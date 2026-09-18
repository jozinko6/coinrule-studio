/**
 * binance-private.mjs — signed Binance Spot API client (Phase 7).
 *
 * Security rules:
 *   - credentials live only in this instance (RAM); nothing is written to disk,
 *     localStorage or logs by the client itself;
 *   - withdrawal endpoints are hard-blocked before any network call;
 *   - timestamps are synchronised with the server and signed with recvWindow;
 *   - POST/DELETE requests are NEVER retried automatically (a timeout may mean
 *     the exchange accepted the order — the caller must reconcile by clientOrderId).
 */

import { encodeQuery, signedQuery, maskApiKey, fingerprintApiKey } from './signing.mjs';

export const BINANCE_TIMEOUT = 'BINANCE_TIMEOUT';
export const WITHDRAWAL_BLOCKED = 'WITHDRAWAL_BLOCKED';
// Any /sapi/ or /wapi/ (private account/wallet APIs), /capi/ and anything withdraw-shaped.
const WITHDRAWAL_PATTERN = /withdraw|\/capi\/|\/sapi\/|\/wapi\//i;

export class BinanceApiError extends Error {
  constructor({ status = 0, code = null, message = 'Binance API error', retryAfter = null, duplicate = false } = {}) {
    super(message);
    this.name = 'BinanceApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.duplicate = duplicate || code === -2010;
  }
}

export class BinanceTimeoutError extends Error {
  constructor(message, { requestAccepted = false } = {}) {
    super(message);
    this.name = 'BinanceTimeoutError';
    this.code = BINANCE_TIMEOUT;
    this.requestAccepted = requestAccepted;
  }
}

/** Withdrawals are out of scope for this application, permanently. */
export function assertNoWithdrawal(path) {
  const raw = String(path ?? '');
  // Percent-encoding must not smuggle a blocked path past the guard.
  let decoded = raw;
  for (let i = 0; i < 2; i += 1) {
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; }
  }
  if (WITHDRAWAL_PATTERN.test(decoded) || WITHDRAWAL_PATTERN.test(raw)) {
    const err = new BinanceApiError({ message: `Zakázaný endpoint: ${raw} (withdrawals a privátne wallet API nie sú podporované)` });
    err.code = WITHDRAWAL_BLOCKED;
    throw err;
  }
}

function header(res, name) {
  const headers = res?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

export function hasTradePermission(account) {
  const permissions = account?.permissions ?? [];
  return Boolean(account?.canTrade) && permissions.includes('SPOT');
}

export class BinancePrivate {
  constructor({
    apiKey, apiSecret, baseUrl = 'https://api.binance.com', fetchImpl = globalThis.fetch,
    recvWindow = 5000, now = () => Date.now(), timeoutMs = 10_000,
    timeSyncTtlMs = 30 * 60_000, maxRetriesPerGet = 1,
  } = {}) {
    if (!apiKey || !apiSecret) throw new Error('BinancePrivate: chýba API kľúč alebo secret.');
    if (typeof fetchImpl !== 'function') throw new Error('BinancePrivate: chýba fetch implementácia.');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.recvWindow = recvWindow;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.timeSyncTtlMs = timeSyncTtlMs;
    this.maxRetriesPerGet = maxRetriesPerGet;
    this.timeOffset = 0;
    this.lastSyncAt = 0;
    this.readOnly = false;
  }

  /** Never expose the secret; the key is masked. */
  describe() {
    return { apiKeyMasked: maskApiKey(this.apiKey), apiKeyFingerprint: fingerprintApiKey(this.apiKey), baseUrl: this.baseUrl };
  }

  get effectiveTimestamp() { return this.now() + this.timeOffset; }

  async syncTime({ force = false } = {}) {
    if (!force && this.lastSyncAt && this.now() - this.lastSyncAt < this.timeSyncTtlMs) return this.timeOffset;
    const started = this.now();
    const body = await this.request('GET', '/api/v3/time');
    const finished = this.now();
    const serverTime = Number(body?.serverTime);
    if (!Number.isFinite(serverTime)) throw new BinanceApiError({ message: 'Neplatná odpoveď /api/v3/time' });
    this.timeOffset = Math.round(serverTime - (started + finished) / 2);
    this.lastSyncAt = this.now();
    return this.timeOffset;
  }

  async request(method, path, { params = null, signed = false } = {}) {
    assertNoWithdrawal(path);
    // Signed calls always use a fresh-enough server offset (cached for the TTL).
    if (signed) await this.syncTime();
    const query = signed
      ? signedQuery(params ?? {}, this.apiSecret, { timestamp: this.effectiveTimestamp, recvWindow: this.recvWindow })
      : encodeQuery(params ?? {});
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    const headers = { Accept: 'application/json' };
    if (signed) headers['X-MBX-APIKEY'] = this.apiKey;

    const maxAttempts = method === 'GET' ? 1 + Math.max(0, this.maxRetriesPerGet) : 1;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { method, headers, signal: controller.signal });
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
        if (!res.ok) {
          const retryAfter = Number(header(res, 'Retry-After')) || null;
          const err = new BinanceApiError({
            status: res.status,
            code: body?.code ?? null,
            message: `${body?.code ?? res.status}: ${body?.msg ?? `HTTP ${res.status}`}`,
            retryAfter,
          });
          // A 5xx GET may be retried; 429/418/4xx never are.
          if (method === 'GET' && res.status >= 500 && !retryAfter && attempt + 1 < maxAttempts) { lastError = err; continue; }
          // Timestamp drift: resync and retry idempotent GETs once (POST/DELETE are surfaced).
          if (err.code === -1021) {
            this.lastSyncAt = 0;
            try { await this.syncTime({ force: true }); } catch { /* surfaced below */ }
            if (method === 'GET' && attempt + 1 < maxAttempts) { lastError = err; continue; }
          }
          throw err;
        }
        return body;
      } catch (err) {
        if (err instanceof BinanceApiError) throw err;
        const timeout = new BinanceTimeoutError(
          `Sieťová chyba pri ${method} ${path}: ${err?.message ?? err}`,
          { requestAccepted: method !== 'GET' },
        );
        lastError = timeout;
        if (method === 'GET' && attempt + 1 < maxAttempts) continue;
        throw timeout;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new BinanceTimeoutError(`Neznáma chyba pri ${method} ${path}`);
  }

  /* ------------------------------------------------------------- public API */

  async ping() { return this.request('GET', '/api/v3/ping'); }
  async serverTime() { return this.request('GET', '/api/v3/time'); }
  async exchangeInfo() { return this.request('GET', '/api/v3/exchangeInfo'); }

  /** Public last price (no signature) — used for price-band-safe limit orders. */
  async tickerPrice(symbol) {
    const body = await this.request('GET', '/api/v3/ticker/price', { params: symbol ? { symbol } : {} });
    const price = Number(body?.price);
    if (!Number.isFinite(price)) throw new BinanceApiError({ message: 'Neplatná odpoveď /api/v3/ticker/price' });
    return price;
  }

  /* ------------------------------------------------------------- private API */

  async accountInfo() {
    const account = await this.request('GET', '/api/v3/account', { signed: true });
    this.readOnly = !hasTradePermission(account);
    return account;
  }

  async balances() {
    const account = await this.accountInfo();
    const out = {};
    for (const b of account?.balances ?? []) {
      const free = Number(b.free ?? 0);
      const locked = Number(b.locked ?? 0);
      if (free || locked) out[b.asset] = { free, locked, total: free + locked };
    }
    return out;
  }

  async openOrders(symbol) {
    return this.request('GET', '/api/v3/openOrders', { params: symbol ? { symbol } : {}, signed: true });
  }

  async allOrders(symbol, { limit = 100, startTime = null } = {}) {
    return this.request('GET', '/api/v3/allOrders', { params: { symbol, limit, startTime }, signed: true });
  }

  async myTrades(symbol, { limit = 100, fromId = null } = {}) {
    return this.request('GET', '/api/v3/myTrades', { params: { symbol, limit, fromId }, signed: true });
  }

  async queryOrder({ symbol, orderId = null, origClientOrderId = null }) {
    return this.request('GET', '/api/v3/order', { params: { symbol, orderId, origClientOrderId }, signed: true });
  }

  /**
   * Place a spot order. `clientOrderId` must be supplied by the caller so that
   * a retry can be reconciled instead of duplicated (Phase 11).
   */
  async placeOrder({
    symbol, side, type = 'MARKET', quantity = null, price = null, timeInForce = null,
    clientOrderId = null, test = false, quoteOrderQty = null,
  }) {
    const params = {
      symbol,
      side,
      type,
      quantity,
      quoteOrderQty,
      price,
      timeInForce,
      newClientOrderId: clientOrderId,
    };
    const path = test ? '/api/v3/order/test' : '/api/v3/order';
    return this.request('POST', path, { params, signed: true });
  }

  async cancelOrder({ symbol, orderId = null, origClientOrderId = null }) {
    return this.request('DELETE', '/api/v3/order', { params: { symbol, orderId, origClientOrderId }, signed: true });
  }
}