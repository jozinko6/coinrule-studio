import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BinancePublic, RateLimiter, assertNoCredentials, klineToCandle,
  normalizeStream, weightForLimit, PUBLIC_ENDPOINTS, BINANCE_REST,
} from '../js/data/binance.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const KLINES = [
  [1700000000000, '100.0', '110.0', '95.0', '105.0', '12.5', 1700003599999, '1200.0', 42, '6.0', '600.0', '0'],
];

test('the client refuses to be constructed with credentials', () => {
  for (const bad of [{ apiKey: 'x' }, { secretKey: 'x' }, { signature: 'x' }, { privateKey: 'x' }]) {
    assert.throws(() => new BinancePublic(bad), /zakázané pole/);
  }
  assert.equal(assertNoCredentials({ timeoutMs: 1000 }), true);
});

test('only public endpoints are allowed', () => {
  const c = new BinancePublic({ fetchImpl: async () => json({}) });
  assert.equal(c.assertPublic('/api/v3/klines'), '/api/v3/klines');
  for (const priv of ['/api/v3/account', '/api/v3/order', '/sapi/v1/capital/config/getall', '/api/v3/userTrades']) {
    assert.throws(() => c.assertPublic(priv), /nie je verejný endpoint/);
  }
  for (const p of PUBLIC_ENDPOINTS) assert.doesNotThrow(() => c.assertPublic(p));
});

test('requests never carry an auth header', async () => {
  let captured = null;
  const c = new BinancePublic({
    fetchImpl: async (url, init) => { captured = { url, init }; return json(KLINES); },
  });
  await c.klines('BTCUSDT', '1h', { limit: 1 });
  assert.ok(captured.url.startsWith(BINANCE_REST));
  const headers = Object.keys(captured.init.headers).map((h) => h.toLowerCase());
  for (const h of headers) {
    assert.ok(!h.includes('mbx') && !h.includes('auth') && !h.includes('key'), `unexpected header ${h}`);
  }
  assert.equal(captured.init.method, 'GET');
});

test('klines are mapped into candle objects', async () => {
  const c = new BinancePublic({ fetchImpl: async () => json(KLINES) });
  const candles = await c.klines('BTCUSDT', '1h', { limit: 1 });
  assert.deepEqual(candles[0], {
    time: 1700000000000,
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 12.5,
    closeTime: 1700003599999,
    quoteVolume: 1200,
    trades: 42,
  });
  assert.deepEqual(klineToCandle(KLINES[0]), candles[0]);
});

test('an invalid interval is rejected before any request', async () => {
  let called = false;
  const c = new BinancePublic({ fetchImpl: async () => { called = true; return json([]); } });
  await assert.rejects(() => c.klines('BTCUSDT', '2m'), /neplatný interval/);
  assert.equal(called, false);
});

test('transient 5xx errors are retried and then succeed', async () => {
  let calls = 0;
  const c = new BinancePublic({
    maxRetries: 3,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return new Response('boom', { status: 503 });
      return json(KLINES);
    },
  });
  const candles = await c.klines('BTCUSDT', '1h', { limit: 1 });
  assert.equal(candles.length, 1);
  assert.equal(calls, 3);
  assert.equal(c.stats.retries, 2);
});

test('4xx errors are not retried', async () => {
  let calls = 0;
  const c = new BinancePublic({
    fetchImpl: async () => { calls += 1; return new Response('bad symbol', { status: 400 }); },
  });
  await assert.rejects(() => c.klines('NOPE', '1h', { limit: 1 }), /HTTP 400/);
  assert.equal(calls, 1);
});

test('rate limiting stops requests before the weight budget is exhausted', () => {
  let now = 0;
  const rl = new RateLimiter({ maxWeight: 10, windowMs: 1000, now: () => now });
  rl.consume(6);
  assert.equal(rl.available(), 4);
  rl.consume(4);
  assert.equal(rl.available(), 0);
  assert.throws(() => rl.consume(1), /vyčerpaný weight limit/);
  now = 1500;
  assert.equal(rl.available(), 10, 'window must roll over');
  assert.doesNotThrow(() => rl.consume(1));
});

test('weightForLimit follows the documented kline weights', () => {
  assert.equal(weightForLimit(1), 1);
  assert.equal(weightForLimit(100), 1);
  assert.equal(weightForLimit(500), 2);
  assert.equal(weightForLimit(1000), 5);
});

test('the client reports a clean error when fetch is unavailable', async () => {
  // An explicit null disables fetch even though Node provides a global one.
  const c = new BinancePublic({ fetchImpl: null });
  await assert.rejects(() => c.ping(), /fetch nie je dostupný/);

  const saved = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const c2 = new BinancePublic({});
    await assert.rejects(() => c2.ping(), /fetch nie je dostupný/);
  } finally {
    globalThis.fetch = saved;
  }
});

test('ticker and exchangeInfo responses are normalised', async () => {
  const c = new BinancePublic({
    fetchImpl: async (url) => {
      if (url.includes('24hr')) {
        return json({ symbol: 'BTCUSDT', lastPrice: '50000', priceChangePercent: '2.5', highPrice: '51000', lowPrice: '48000', volume: '100', quoteVolume: '5000000', count: 900 });
      }
      if (url.includes('exchangeInfo')) {
        return json({ symbols: [
          { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', quotePrecision: 8 },
          { symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC', quotePrecision: 8 },
          { symbol: 'OLDUSDT', status: 'BREAK', baseAsset: 'OLD', quoteAsset: 'USDT', quotePrecision: 8 },
        ] });
      }
      return json({ symbol: 'BTCUSDT', price: '50000' });
    },
  });
  const t = await c.ticker24h('BTCUSDT');
  assert.equal(t.price, 50000);
  assert.equal(t.changePct, 2.5);
  const symbols = await c.usdtSymbols('USDT');
  assert.deepEqual(symbols.map((s) => s.symbol), ['BTCUSDT']);
});

test('history pagination walks backwards and de-duplicates', async () => {
  const page = (start) => Array.from({ length: 1000 }, (_, i) => [start + i * 60_000, '1', '1', '1', '1', '1', 0, '0', 0, '0', '0', '0']);
  let call = 0;
  const c = new BinancePublic({
    fetchImpl: async (url) => {
      call += 1;
      const end = Number(new URL(url).searchParams.get('endTime') ?? 0);
      return json(page(end - 999 * 60_000));
    },
  });
  const candles = await c.klinesHistory('BTCUSDT', '1m', 1500);
  assert.equal(candles.length, 1500);
  assert.ok(call >= 2);
  const times = new Set(candles.map((x) => x.time));
  assert.equal(times.size, candles.length, 'duplicate timestamps');
  for (let i = 1; i < candles.length; i += 1) assert.ok(candles[i].time > candles[i - 1].time);
});

test('websocket payloads are normalised', () => {
  const k = normalizeStream({ data: { e: 'kline', k: { s: 'BTCUSDT', i: '1m', x: true, t: 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '10' } } });
  assert.equal(k.kind, 'kline');
  assert.equal(k.symbol, 'BTCUSDT');
  assert.equal(k.candle.close, 1.5);
  assert.equal(k.closed, true);

  const t = normalizeStream({ data: { e: '24hrMiniTicker', s: 'ETHUSDT', c: '2000', v: '5' } });
  assert.equal(t.kind, 'miniTicker');
  assert.equal(t.price, 2000);

  const tr = normalizeStream({ data: { e: 'trade', s: 'BTCUSDT', p: '100', q: '1', T: 5 } });
  assert.equal(tr.kind, 'trade');
  assert.equal(tr.price, 100);
});

test('subscribing without a WebSocket implementation fails loudly', () => {
  const c = new BinancePublic({ fetchImpl: async () => json({}), WebSocketImpl: null });
  assert.throws(() => c.subscribe(['btcusdt@miniTicker'], () => {}), /WebSocket nie je dostupný/);

  const saved = globalThis.WebSocket;
  try {
    globalThis.WebSocket = undefined;
    const c2 = new BinancePublic({ fetchImpl: async () => json({}) });
    assert.throws(() => c2.subscribe(['btcusdt@miniTicker'], () => {}), /WebSocket nie je dostupný/);
  } finally {
    globalThis.WebSocket = saved;
  }
});

test('subscribing forwards normalised messages', () => {
  class FakeWS {
    constructor(url) { this.url = url; FakeWS.last = this; }
    close() { this.closed = true; }
  }
  const c = new BinancePublic({ fetchImpl: async () => json({}), WebSocketImpl: FakeWS });
  const seen = [];
  const handle = c.subscribe(['btcusdt@miniTicker'], (m) => seen.push(m));
  assert.match(handle.socket.url, /stream\?streams=btcusdt@miniTicker/);
  FakeWS.last.onmessage({ data: JSON.stringify({ data: { e: '24hrMiniTicker', s: 'BTCUSDT', c: '100', v: '1' } }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].price, 100);
  handle.close();
  assert.equal(FakeWS.last.closed, true);
});
