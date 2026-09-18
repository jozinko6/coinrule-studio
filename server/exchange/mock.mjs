/**
 * mock.mjs — deterministic in-process Binance Spot double for tests (Phase 24).
 *
 * It verifies signatures the same way Binance does (HMAC over the exact query
 * string that was sent), enforces recvWindow, and can simulate: success, 401/
 * 403, invalid signature, timestamp drift, 429, 418, 500, a timeout after the
 * order was accepted, partial fill / filled / canceled, WebSocket-less polling
 * data, and a duplicate clientOrderId.
 */

import { signQuery } from './signing.mjs';

export const MOCK_EXCHANGE_INFO = {
  timezone: 'UTC',
  symbols: [
    {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      quotePrecision: 8,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000', maxQty: '9000.00000000' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000', maxQty: '178.00000000' },
        { filterType: 'NOTIONAL', minNotional: '10.00000000', applyMinNotional: true },
      ],
    },
    {
      symbol: 'PEPEUSDT',
      status: 'TRADING',
      baseAsset: 'PEPE',
      quoteAsset: 'USDT',
      quotePrecision: 8,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.00000001' },
        { filterType: 'LOT_SIZE', stepSize: '1.00000000', minQty: '1.00000000', maxQty: '1000000000.00000000' },
        { filterType: 'NOTIONAL', minNotional: '5.00000000', applyMinNotional: true },
      ],
    },
  ],
};

const headerReader = (headers) => (name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
};

export function createMockExchange({ apiKey = 'test-key', apiSecret = 'test-secret', now = () => Date.now(), balances = null } = {}) {
  const state = {
    serverClockOffsetMs: 0,
    orders: new Map(),          // clientOrderId -> order
    trades: [],                 // fills
    seq: 0,
    counters: { requests: 0, signed: 0, placed: 0, rejected: 0, canceled: 0, withdrawalAttempts: 0 },
    nextFailure: null,          // { status, code, message, retryAfter }
    timeoutAfterAccept: false,
    timeoutBeforeAccept: false,
    partialFillQty: null,
    balanceOverride: balances ?? [
      { asset: 'USDT', free: '10000.00000000', locked: '0.00000000' },
      { asset: 'BTC', free: '0.50000000', locked: '0.00000000' },
    ],
  };

  const serverTime = () => now() + state.serverClockOffsetMs;

  const respond = (status, body, headers = {}) => ({
    ok: status < 400,
    status,
    headers,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });
  const apiError = (status, code, message, headers = {}) => respond(status, { code, msg: message }, headers);

  function checkAuth(url, init) {
    const key = headerReader(init.headers ?? {})('X-MBX-APIKEY');
    if (!key) return apiError(401, -2014, 'API-key format invalid.');
    if (key !== apiKey) return apiError(401, -2015, 'Invalid API-key, IP, or permissions for action.');
    return null;
  }

  function verifySignature(fullUrl) {
    const raw = String(fullUrl).split('?')[1] ?? '';
    if (!raw.includes('signature=')) return apiError(401, -2014, 'Signature for this request is not valid.');
    const idx = raw.lastIndexOf('&signature=');
    if (idx < 0) return apiError(401, -2014, 'Signature for this request is not valid.');
    const body = raw.slice(0, idx);
    const provided = raw.slice(idx + '&signature='.length);
    const expected = signQuery(body, apiSecret);
    if (provided !== expected) return apiError(401, -1022, 'Signature for this request is not valid.');
    const params = new Map(body.split('&').map((kv) => {
      const [k, ...rest] = kv.split('=');
      return [k, decodeURIComponent(rest.join('='))];
    }));
    const timestamp = Number(params.get('timestamp'));
    const recvWindow = Number(params.get('recvWindow') ?? 5000);
    if (!Number.isFinite(timestamp)) return apiError(400, -1102, 'Mandatory parameter timestamp was not sent.');
    if (Math.abs(serverTime() - timestamp) > recvWindow) {
      return apiError(400, -1021, 'Timestamp for this request is outside of the recvWindow.');
    }
    return { params, query: body };
  }

  function orderBody(order) {
    return {
      symbol: order.symbol,
      orderId: order.orderId,
      orderListId: -1,
      clientOrderId: order.clientOrderId,
      transactTime: serverTime(),
      price: order.price ?? '0.00000000',
      origQty: String(order.quantity),
      executedQty: String(order.executedQty ?? 0),
      cummulativeQuoteQty: String(order.cummulativeQuoteQty ?? 0),
      status: order.status,
      timeInForce: order.timeInForce ?? 'GTC',
      type: order.type,
      side: order.side,
      isWorking: order.status === 'NEW' || order.status === 'PARTIALLY_FILLED',
    };
  }

  async function fetchImpl(url, init = {}) {
    state.counters.requests += 1;
    const fullUrl = typeof url === 'string' ? url : String(url?.url ?? url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const path = new URL(fullUrl).pathname;
    const headers = headerReader(init.headers ?? {});
    void headers;

    if (state.nextFailure) {
      const failure = state.nextFailure;
      state.nextFailure = null;
      state.counters.rejected += 1;
      return apiError(failure.status, failure.code ?? -1000, failure.message ?? 'scripted failure', failure.retryAfter ? { 'Retry-After': String(failure.retryAfter) } : {});
    }

    if (path.startsWith('/sapi/') || path.includes('withdraw')) {
      state.counters.withdrawalAttempts += 1;
      return apiError(404, -1121, 'Withdrawals are not supported by this application.');
    }

    if (path === '/api/v3/ping' && method === 'GET') return respond(200, {});
    if (path === '/api/v3/time' && method === 'GET') return respond(200, { serverTime: serverTime() });
    if (path === '/api/v3/exchangeInfo' && method === 'GET') return respond(200, MOCK_EXCHANGE_INFO);
    if (path === '/api/v3/ticker/price' && method === 'GET') {
      const symbol = new URL(fullUrl).searchParams.get('symbol');
      if (symbol && symbol !== 'BTCUSDT' && symbol !== 'PEPEUSDT') return apiError(400, -1121, 'Invalid symbol.');
      return respond(200, { symbol: symbol ?? 'BTCUSDT', price: '60000.00000000' });
    }

    const authError = checkAuth(fullUrl, init);
    if (authError) return authError;
    const verified = verifySignature(fullUrl);
    if (verified.status) return verified;
    state.counters.signed += 1;
    const { params } = verified;

    if (path === '/api/v3/account' && method === 'GET') {
      return respond(200, {
        makerCommission: 10,
        takerCommission: 10,
        canTrade: true,
        canWithdraw: false,
        canDeposit: true,
        accountType: 'SPOT',
        permissions: ['SPOT'],
        balances: state.balanceOverride,
      });
    }

    if (path === '/api/v3/openOrders' && method === 'GET') {
      const symbol = params.get('symbol');
      const open = [...state.orders.values()].filter((o) => (!symbol || o.symbol === symbol)
        && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'));
      return respond(200, open.map(orderBody));
    }

    if (path === '/api/v3/allOrders' && method === 'GET') {
      const symbol = params.get('symbol');
      return respond(200, [...state.orders.values()].filter((o) => !symbol || o.symbol === symbol).map(orderBody));
    }

    if (path === '/api/v3/myTrades' && method === 'GET') {
      const symbol = params.get('symbol');
      return respond(200, state.trades.filter((t) => !symbol || t.symbol === symbol));
    }

    if (path === '/api/v3/order/test' && method === 'POST') {
      return respond(200, {});
    }

    if (path === '/api/v3/order' && method === 'POST') {
      if (state.timeoutBeforeAccept) {
        state.timeoutBeforeAccept = false;
        const err = new TypeError('fetch failed');
        err.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
        throw err; // the exchange never saw the request
      }
      const clientOrderId = params.get('newClientOrderId') ?? `mock_${state.seq + 1}`;
      if (state.orders.has(clientOrderId)) {
        state.counters.rejected += 1;
        return apiError(400, -2010, 'Duplicate order sent.');
      }
      state.seq += 1;
      const type = params.get('type') ?? 'MARKET';
      const quantity = Number(params.get('quantity') ?? 0);
      const price = params.get('price') ? Number(params.get('price')) : null;
      const status = type === 'MARKET' ? 'FILLED' : 'NEW';
      const order = {
        orderId: state.seq,
        clientOrderId,
        symbol: params.get('symbol'),
        side: params.get('side') ?? 'BUY',
        type,
        timeInForce: params.get('timeInForce') ?? 'GTC',
        quantity,
        price: price === null ? null : String(price),
        executedQty: status === 'FILLED' ? quantity : 0,
        status,
      };
      if (state.partialFillQty !== null) {
        order.status = 'PARTIALLY_FILLED';
        order.executedQty = Math.min(Number(state.partialFillQty), quantity);
      }
      state.orders.set(clientOrderId, order);
      state.counters.placed += 1;
      if (status === 'FILLED' || order.status === 'PARTIALLY_FILLED') {
        state.trades.push({
          id: state.trades.length + 1, orderId: order.orderId, symbol: order.symbol, side: order.side,
          qty: String(order.executedQty), price: String(price ?? 60000), commission: '0.00000010', commissionAsset: 'BTC',
          time: serverTime(),
        });
      }
      if (state.timeoutAfterAccept) {
        state.timeoutAfterAccept = false;
        const err = new TypeError('fetch failed');
        err.cause = { code: 'UND_ERR_SOCKET' };
        throw err;
      }
      return respond(200, orderBody(order));
    }

    if (path === '/api/v3/order' && method === 'DELETE') {
      const id = params.get('orderId');
      const clientOrderId = params.get('origClientOrderId');
      const order = clientOrderId ? state.orders.get(clientOrderId)
        : [...state.orders.values()].find((o) => String(o.orderId) === String(id));
      if (!order) return apiError(400, -2011, 'Unknown order sent.');
      order.status = 'CANCELED';
      state.counters.canceled += 1;
      return respond(200, orderBody(order));
    }

    if (path === '/api/v3/order' && method === 'GET') {
      const id = params.get('orderId');
      const clientOrderId = params.get('origClientOrderId');
      const order = clientOrderId ? state.orders.get(clientOrderId)
        : [...state.orders.values()].find((o) => String(o.orderId) === String(id));
      if (!order) return apiError(400, -2013, 'Order does not exist.');
      return respond(200, orderBody(order));
    }

    return apiError(404, -1121, `Unknown endpoint ${method} ${path}`);
  }

  return {
    fetchImpl,
    state,
    serverTime,
    setTimestampDrift(ms) { state.serverClockOffsetMs = ms; },
    failNext(failure) { state.nextFailure = failure; },
    setTimeoutAfterAccept(value = true) { state.timeoutAfterAccept = value; },
    setTimeoutBeforeAccept(value = true) { state.timeoutBeforeAccept = value; },
    setPartialFill(qty) { state.partialFillQty = qty; },
    setBalances(list) { state.balanceOverride = list; },
    getOrder(clientOrderId) { return state.orders.get(clientOrderId) ?? null; },
  };
}