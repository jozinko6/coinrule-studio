/**
 * backend.js — client for the local CoinRule Studio backend (Phases 19/20).
 *
 * The admin token and the exchange credentials are NEVER stored: the token
 * lives in this closure for the lifetime of the page, credentials are passed
 * straight to the backend (which keeps them in RAM too) and forgotten.
 * Every method returns parsed JSON or throws BackendError, so the UI has one
 * uniform failure path.
 */

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8787';
export const DEFAULT_TIMEOUT_MS = 10_000;

export class BackendError extends Error {
  constructor({ status = 0, code = null, message = 'Backend error', check = null, details = null } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    this.check = check;
    this.details = details;
  }
}

/**
 * When the UI is served BY the backend, the backend lives on the page's own
 * origin (any port); only file:// or foreign hosting falls back to 8787.
 */
export function defaultBackendUrl(loc = (typeof location !== 'undefined' ? location : null)) {
  const origin = loc?.origin;
  if (typeof origin === 'string' && /^https?:\/\//.test(origin)) return normalizeBaseUrl(origin);
  return DEFAULT_BACKEND_URL;
}

/** Accepts "127.0.0.1:8787", "http://localhost:8787/" or an empty value. */
export function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULT_BACKEND_URL;
  const explicit = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (explicit && !/^https?$/i.test(explicit[1])) {
    throw new BackendError({ status: 0, code: 'bad_url', message: 'Podporované sú len http/https adresy.' });
  }
  const withScheme = explicit ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BackendError({ status: 0, code: 'bad_url', message: 'Podporované sú len http/https adresy.' });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function createBackendClient({ baseUrl = DEFAULT_BACKEND_URL, token = '', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let currentBase = normalizeBaseUrl(baseUrl);
  let currentToken = String(token ?? '');

  async function request(method, path, body = null, { auth = true, timeoutOverride = null } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new BackendError({ status: 0, code: 'no_fetch', message: 'Toto prostredie nepodporuje fetch.' });
    }
    const headers = { Accept: 'application/json' };
    if (body !== null) headers['Content-Type'] = 'application/json';
    if (auth && currentToken) headers['X-CoinRule-Token'] = currentToken;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const limit = timeoutOverride ?? timeoutMs;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { controller?.abort(); } catch { /* ignore */ }
        reject(new BackendError({ status: 0, code: 'timeout', message: `Backend neodpovedal do ${limit} ms.` }));
      }, limit);
    });

    let response;
    try {
      response = await Promise.race([
        fetchImpl(`${currentBase}${path}`, {
          method,
          headers,
          body: body === null ? undefined : JSON.stringify(body),
          ...(controller ? { signal: controller.signal } : {}),
        }),
        timeout,
      ]);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw new BackendError({ status: 0, code: 'offline', message: `Backend nedostupný (${err?.message ?? err}).` });
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      throw new BackendError({
        status: response.status,
        code: payload?.error ?? 'http_error',
        message: payload?.message ?? `HTTP ${response.status}`,
        check: payload?.check ?? null,
        details: payload?.details ?? null,
      });
    }
    return payload;
  }

  return {
    get baseUrl() { return currentBase; },
    get hasToken() { return Boolean(currentToken); },
    configure({ baseUrl: nextBase = currentBase, token: nextToken = currentToken } = {}) {
      currentBase = normalizeBaseUrl(nextBase);
      currentToken = String(nextToken ?? '');
      return { baseUrl: currentBase, hasToken: Boolean(currentToken) };
    },

    health: () => request('GET', '/api/health', null, { auth: false }),
    status: () => request('GET', '/api/status'),
    mode: () => request('GET', '/api/mode'),
    risk: () => request('GET', '/api/risk'),
    sessions: () => request('GET', '/api/sessions'),

    setMode: (action, options = {}) => request('POST', '/api/mode', { action, ...options }),
    setKillSwitch: (engaged) => request('POST', '/api/risk/killswitch', { engaged: Boolean(engaged) }),
    saveCredentials: (key, secret) => request('POST', '/api/credentials', { key, secret }),
    clearCredentials: () => request('DELETE', '/api/credentials'),

    createSession: (environment, symbol) => request('POST', '/api/sessions', { environment, symbol }),
    reconcile: (sessionId) => request('POST', '/api/sessions/reconcile', { sessionId }),

    orders: (sessionId) => request('GET', `/api/orders?sessionId=${encodeURIComponent(sessionId)}`),
    placeOrder: (order) => request('POST', '/api/orders', order),
    cancelOrder: (cancel) => request('POST', '/api/orders/cancel', cancel),

    backtests: ({ limit = 50 } = {}) => request('GET', '/api/backtests?limit=' + encodeURIComponent(limit)),
    backtest: (id) => request('GET', '/api/backtests/' + encodeURIComponent(id)),
    saveBacktest: (payload) => request('POST', '/api/backtests', payload),
    deleteBacktest: (id) => request('DELETE', '/api/backtests/' + encodeURIComponent(id)),

    streamStatus: () => request('GET', '/api/stream'),
    streamStart: (sessionId, options = {}) => request('POST', '/api/stream/start', { sessionId, ...options }),
    streamStop: () => request('POST', '/api/stream/stop'),
  };
}