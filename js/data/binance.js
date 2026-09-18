/**
 * binance.js — Binance **public** market-data client.
 *
 * Hard rules (enforced by `assertNoCredentials`):
 *   - only public endpoints are used (`/api/v3/*`, `wss://stream.binance.com`)
 *   - no API key, no secret, no signature, no account endpoint is ever touched
 *   - therefore the app can never place a real order
 *
 * The client is rate-limit aware (weight budget) and retries transient errors
 * with exponential backoff. `fetchImpl` / `WebSocketImpl` are injectable so the
 * whole thing is testable offline.
 */

export const BINANCE_REST = 'https://api.binance.com';
export const BINANCE_WS = 'wss://stream.binance.com:9443';

export const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

/** Endpoints this client is allowed to call — all public, all unauthenticated. */
export const PUBLIC_ENDPOINTS = [
  '/api/v3/ping',
  '/api/v3/time',
  '/api/v3/exchangeInfo',
  '/api/v3/klines',
  '/api/v3/ticker/price',
  '/api/v3/ticker/24hr',
  '/api/v3/avgPrice',
  '/api/v3/depth',
  '/api/v3/trades',
];

/** Field names that would imply credential handling — a hard programming error. */
export const FORBIDDEN_FIELDS = new Set([
  'apikey', 'api_key', 'secret', 'secretkey', 'secret_key', 'signature',
  'privatekey', 'private_key', 'token', 'accesstoken', 'bearer',
]);

/** Anything that looks like a credential is a programming error here. */
export function assertNoCredentials(options = {}) {
  for (const k of Object.keys(options)) {
    const normalised = k.toLowerCase().replace(/[-_\s]/g, '');
    if (FORBIDDEN_FIELDS.has(k.toLowerCase()) || FORBIDDEN_FIELDS.has(normalised)) {
      throw new Error(`BinancePublic: zakázané pole "${k}" — klient nikdy nepoužíva prihlasovacie údaje.`);
    }
  }
  return true;
}

export class RateLimiter {
  /** @param {{maxWeight?:number, windowMs?:number, now?:()=>number}} opts */
  constructor({ maxWeight = 1200, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.maxWeight = maxWeight;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = [];
  }

  /** Weight still available in the current window. */
  available() {
    this.prune();
    return this.maxWeight - this.entries.reduce((a, e) => a + e.weight, 0);
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    this.entries = this.entries.filter((e) => e.at > cutoff);
  }

  /** Reserve weight; throws if the budget is exhausted. */
  consume(weight = 1) {
    this.prune();
    const used = this.entries.reduce((a, e) => a + e.weight, 0);
    if (used + weight > this.maxWeight) {
      const oldest = this.entries[0];
      const retryAfterMs = oldest ? Math.max(0, oldest.at + this.windowMs - this.now()) : 0;
      const err = new Error(`Binance: vyčerpaný weight limit (${used}/${this.maxWeight}), skús o ${Math.ceil(retryAfterMs / 1000)} s.`);
      err.code = 'RATE_LIMIT';
      err.retryAfterMs = retryAfterMs;
      throw err;
    }
    this.entries.push({ at: this.now(), weight });
    return this.available();
  }
}

export function klineToCandle(k) {
  return {
    time: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
    quoteVolume: Number(k[7]),
    trades: Number(k[8]),
  };
}

export function candleToKline(c) {
  return [c.time, c.open, c.high, c.low, c.close, c.volume, c.closeTime ?? c.time + 59_999, c.quoteVolume ?? 0, c.trades ?? 0];
}

export class BinancePublic {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]
   * @param {Function} [opts.fetchImpl]     injected for tests
   * @param {Function} [opts.WebSocketImpl]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries]
   */
  constructor(opts = {}) {
    assertNoCredentials(opts);
    this.baseUrl = (opts.baseUrl ?? BINANCE_REST).replace(/\/$/, '');
    this.wsUrl = (opts.wsUrl ?? BINANCE_WS).replace(/\/$/, '');
    // An explicit `fetchImpl: null` really means "no fetch available"; only an
    // absent key falls back to the global implementation.
    this.fetchImpl = 'fetchImpl' in opts ? opts.fetchImpl : (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.WebSocketImpl = 'WebSocketImpl' in opts ? opts.WebSocketImpl : (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.limiter = opts.limiter ?? new RateLimiter({ maxWeight: opts.maxWeight ?? 1200 });
    this.now = opts.now ?? (() => Date.now());
    this.stats = { requests: 0, errors: 0, retries: 0, lastLatencyMs: 0, lastError: null };
    this.sockets = new Map();
  }

  /* --------------------------------------------------------------- plumbing */

  /** Signed/private endpoints do not exist on this client by design. */
  assertPublic(path) {
    const clean = path.split('?')[0];
    if (!PUBLIC_ENDPOINTS.includes(clean)) {
      throw new Error(`BinancePublic: "${clean}" nie je verejný endpoint. Tento klient nepodporuje súkromné API.`);
    }
    return clean;
  }

  async request(path, params = {}, { weight = 1, retries = this.maxRetries } = {}) {
    this.assertPublic(path);
    if (!this.fetchImpl) {
      const err = new Error('Binance: fetch nie je dostupný v tomto prostredí.');
      err.code = 'NO_FETCH';
      throw err;
    }
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.limiter.consume(weight);
      const started = this.now();
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      try {
        this.stats.requests += 1;
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' }, // no auth headers, ever
          signal: controller ? controller.signal : undefined,
        });
        this.stats.lastLatencyMs = this.now() - started;
        if (!res.ok) {
          const body = await safeText(res);
          const err = new Error(`Binance HTTP ${res.status} na ${path}: ${body.slice(0, 200)}`);
          err.status = res.status;
          if (res.status === 429 || res.status === 418 || res.status >= 500) {
            if (attempt < retries) {
              attempt += 1;
              this.stats.retries += 1;
              await sleep(this.backoffMs(attempt, res));
              continue;
            }
          }
          this.stats.errors += 1;
          this.stats.lastError = err.message;
          throw err;
        }
        return await res.json();
      } catch (err) {
        if (err.status && err.status < 500 && err.status !== 429 && err.status !== 418) throw err;
        if (attempt < retries) {
          attempt += 1;
          this.stats.retries += 1;
          await sleep(this.backoffMs(attempt));
          continue;
        }
        this.stats.errors += 1;
        this.stats.lastError = err.message;
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  backoffMs(attempt, res = null) {
    const header = res?.headers?.get?.('Retry-After');
    if (header) return Math.min(30_000, Number(header) * 1000);
    return Math.min(8000, 250 * 2 ** attempt);
  }

  /* ------------------------------------------------------------- endpoints */

  async ping() {
    const t0 = this.now();
    await this.request('/api/v3/ping', {}, { weight: 1 });
    return { ok: true, latencyMs: this.now() - t0 };
  }

  async serverTime() {
    const r = await this.request('/api/v3/time', {}, { weight: 1 });
    return r.serverTime;
  }

  async exchangeInfo(symbols = null) {
    const params = symbols ? { symbols: JSON.stringify(symbols) } : {};
    return this.request('/api/v3/exchangeInfo', params, { weight: 20 });
  }

  /** Historical candles. `limit` max 1000 per call (Binance limit). */
  async klines(symbol, interval = '1h', { limit = 500, startTime, endTime } = {}) {
    if (!INTERVALS.includes(interval)) throw new Error(`Binance: neplatný interval "${interval}"`);
    const rows = await this.request('/api/v3/klines', {
      symbol, interval, limit: Math.min(Math.max(limit, 1), 1000), startTime, endTime,
    }, { weight: weightForLimit(limit) });
    return rows.map(klineToCandle);
  }

  /** Paginated history: walks backwards until `count` candles are collected. */
  async klinesHistory(symbol, interval = '1h', count = 1000, { endTime } = {}) {
    const out = [];
    let cursor = endTime;
    const batch = 1000;
    let guard = 0;
    while (out.length < count && guard < 20) {
      guard += 1;
      const want = Math.min(batch, count - out.length);
      const rows = await this.klines(symbol, interval, { limit: want, endTime: cursor });
      if (!rows.length) break;
      out.unshift(...rows);
      cursor = rows[0].time - 1;
    }
    return out.slice(-count);
  }

  async tickerPrice(symbol) {
    const r = await this.request('/api/v3/ticker/price', { symbol }, { weight: 2 });
    return { symbol: r.symbol, price: Number(r.price) };
  }

  async ticker24h(symbol) {
    const r = await this.request('/api/v3/ticker/24hr', { symbol }, { weight: 40 });
    return {
      symbol: r.symbol,
      price: Number(r.lastPrice),
      changePct: Number(r.priceChangePercent),
      high: Number(r.highPrice),
      low: Number(r.lowPrice),
      volume: Number(r.volume),
      quoteVolume: Number(r.quoteVolume),
      trades: Number(r.count),
    };
  }

  async avgPrice(symbol) {
    const r = await this.request('/api/v3/avgPrice', { symbol }, { weight: 2 });
    return { symbol: r.symbol, price: Number(r.price) };
  }

  async depth(symbol, limit = 20) {
    return this.request('/api/v3/depth', { symbol, limit }, { weight: limit <= 100 ? 5 : 25 });
  }

  /** Public symbols that trade against `quote` (e.g. USDT). */
  async usdtSymbols(quote = 'USDT') {
    const info = await this.exchangeInfo();
    return info.symbols
      .filter((s) => s.status === 'TRADING' && s.quoteAsset === quote)
      .map((s) => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset, pricePrecision: s.quotePrecision }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  /* -------------------------------------------------------------- streaming */

  /**
   * Subscribe to public WebSocket streams.
   * @param {string[]} streams e.g. ['btcusdt@kline_1m', 'ethusdt@miniTicker']
   * @param {(msg:object)=>void} onMessage
   * @returns {{close:Function, streams:string[]}}
   */
  subscribe(streams, onMessage, { onError, onOpen } = {}) {
    if (!this.WebSocketImpl) {
      throw Object.assign(new Error('Binance: WebSocket nie je dostupný.'), { code: 'NO_WS' });
    }
    const url = `${this.wsUrl}/stream?streams=${streams.join('/')}`;
    const socket = new this.WebSocketImpl(url);
    const handle = {
      socket,
      streams,
      close: () => { try { socket.close(); } catch { /* ignore */ } this.sockets.delete(url); },
    };
    socket.onopen = () => onOpen?.();
    socket.onerror = (e) => onError?.(e);
    socket.onmessage = (event) => {
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        onMessage?.(normalizeStream(payload));
      } catch (err) {
        onError?.(err);
      }
    };
    this.sockets.set(url, handle);
    return handle;
  }

  closeAll() {
    for (const h of this.sockets.values()) h.close();
    this.sockets.clear();
  }
}

/** Normalise a combined-stream payload into a stable shape. */
export function normalizeStream(payload) {
  const data = payload?.data ?? payload;
  if (!data) return payload;
  if (data.e === 'kline' && data.k) {
    const k = data.k;
    return {
      kind: 'kline',
      symbol: k.s,
      interval: k.i,
      closed: !!k.x,
      candle: {
        time: Number(k.t), open: Number(k.o), high: Number(k.h),
        low: Number(k.l), close: Number(k.c), volume: Number(k.v),
      },
    };
  }
  if (data.e === '24hrMiniTicker') {
    return { kind: 'miniTicker', symbol: data.s, price: Number(data.c), volume: Number(data.v) };
  }
  if (data.e === 'trade') {
    return { kind: 'trade', symbol: data.s, price: Number(data.p), qty: Number(data.q), time: Number(data.T) };
  }
  if (data.e === 'depthUpdate') {
    return { kind: 'depth', symbol: data.s, bids: data.b, asks: data.a };
  }
  return data;
}

export function weightForLimit(limit) {
  if (limit <= 100) return 1;
  if (limit <= 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

/** Well-known public pairs offered in the UI. */
export {
  MAJOR_SYMBOLS, VOLATILE_SYMBOLS, POPULAR_SYMBOLS, SYMBOL_CATEGORIES,
  isVolatileSymbol, isValidSymbol, SYMBOL_PATTERN,
} from './symbols.js';
