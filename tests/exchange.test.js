/**
 * exchange.test.js — Binance signing, exchange filters and rule caching.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeQuery, encodeValue, signQuery, signedQuery, maskApiKey, fingerprintApiKey,
} from '../server/exchange/signing.mjs';
import {
  SymbolRulesCache, decimalsFromStep, floorToStep, normalizeOrder, normalizePrice,
  normalizeQuantity, roundToTick, rulesFromExchangeInfo,
} from '../server/exchange/filters.mjs';

/* ------------------------------------------------------------------ signing */

test('query encoding matches the Binance canonical form', () => {
  assert.equal(encodeValue('a b&c=d'), 'a%20b%26c%3Dd');
  assert.equal(encodeValue('A-Z_a~b.c'), 'A-Z_a~b.c');
  assert.equal(encodeQuery({ b: 2, a: 1, empty: '', skip: null }), 'a=1&b=2');
  assert.equal(encodeQuery({ symbol: 'BTC/USDT' }), 'symbol=BTC%2FUSDT');
});

test('HMAC-SHA256 signing matches the published test vector', () => {
  // RFC 4231-style vector: key "key", message "The quick brown fox jumps over the lazy dog"
  const vector = 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
  assert.equal(signQuery('The quick brown fox jumps over the lazy dog', 'key'), vector);
});

test('signedQuery appends timestamp, recvWindow and the signature of the encoded payload', () => {
  const query = signedQuery({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 }, 'secret', { timestamp: 1_234_567_890 });
  const [body, signature] = query.split('&signature=');
  assert.equal(signature.length, 64);
  assert.match(body, /timestamp=1234567890/);
  assert.match(body, /recvWindow=5000/);
  assert.equal(signQuery(body, 'secret'), signature, 'the signature must cover the exact sent payload');
  assert.throws(() => signedQuery({}, 'secret', {}), /timestamp/);
});

test('api keys are masked and fingerprinted, never stored raw', () => {
  const key = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  assert.equal(maskApiKey(key), 'ABCD...7890');
  assert.equal(maskApiKey('short'), 'sh...rt');
  assert.equal(maskApiKey('').length <= 5, true);
  assert.equal(fingerprintApiKey(key).length, 16);
  assert.notEqual(fingerprintApiKey(key), fingerprintApiKey(`${key}x`));
  assert.ok(!fingerprintApiKey(key).includes('ABCD'), 'the fingerprint must not leak the key');
});

/* ------------------------------------------------------------------ filters */

const INFO = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      quotePrecision: 8,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000', maxQty: '9000.00000000' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.00000000', minQty: '0.00000000', maxQty: '178.00000000' },
        { filterType: 'NOTIONAL', minNotional: '10.00000000', applyMinNotional: true },
      ],
    },
    {
      symbol: 'BREAKUSDT',
      status: 'BREAK',
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00010000' }],
    },
  ],
};

test('step/tick helpers round in the safe direction', () => {
  assert.equal(decimalsFromStep('0.00100000'), 3);
  assert.equal(decimalsFromStep('1.00000000'), 0);
  assert.equal(decimalsFromStep(''), 0);
  assert.equal(floorToStep(1.23456, '0.001'), 1.234);
  assert.equal(floorToStep(1.2, '0'), 1.2, 'a zero step must not destroy the value');
  assert.equal(roundToTick(123.456, '0.01'), 123.46);
});

test('rulesFromExchangeInfo extracts tick, step and notional limits', () => {
  const rules = rulesFromExchangeInfo(INFO, 'BTCUSDT');
  assert.equal(rules.tickSize, '0.01000000');
  assert.equal(rules.stepSize, '0.00001000');
  assert.equal(rules.minQty, 0.00001);
  assert.equal(rules.minNotional, 10);
  assert.equal(rules.applyMinNotional, true);
  assert.equal(rules.status, 'TRADING');
  assert.equal(rulesFromExchangeInfo(INFO, 'NOPE'), null);
});

test('normalizePrice and normalizeQuantity respect the market rules', () => {
  const rules = rulesFromExchangeInfo(INFO, 'BTCUSDT');
  assert.equal(normalizePrice(123.456, rules), 123.46);

  // step is 1e-5, so the safe floor is 0.00123
  assert.equal(normalizeQuantity(0.0012345678, rules).qty, 0.00123);
  const below = normalizeQuantity(0.000001, rules);
  assert.equal(below.qty, 0);
  assert.match(below.error, /minQty/);

  const capped = normalizeQuantity(100000, rules);
  assert.ok(capped.qty <= 9000, 'maxQty must cap the quantity');
});

test('normalizeOrder blocks invalid, non-TRADING and too-small orders', () => {
  const rules = rulesFromExchangeInfo(INFO, 'BTCUSDT');
  const market = normalizeOrder({ symbol: 'BTCUSDT', type: 'MARKET', quantity: 0.5, referencePrice: 60_000 }, rules);
  assert.equal(market.ok, true, JSON.stringify(market.errors));
  assert.equal(market.order.quantity, 0.5);

  const limit = normalizeOrder({ symbol: 'BTCUSDT', type: 'LIMIT', quantity: 0.5, price: 123.456 }, rules);
  assert.equal(limit.ok, true);
  assert.equal(limit.order.price, 123.46);

  const noPrice = normalizeOrder({ symbol: 'BTCUSDT', type: 'LIMIT', quantity: 0.5 }, rules);
  assert.equal(noPrice.ok, false);
  assert.ok(noPrice.errors.some((e) => /price/.test(e)));

  const tiny = normalizeOrder({ symbol: 'BTCUSDT', type: 'LIMIT', quantity: 0.00002, price: 100 }, rules);
  assert.equal(tiny.ok, false);
  assert.ok(tiny.errors.some((e) => /minNotional/.test(e)));

  const broken = normalizeOrder({ symbol: 'BREAKUSDT', type: 'MARKET', quantity: 1, referencePrice: 1 }, rulesFromExchangeInfo(INFO, 'BREAKUSDT'));
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((e) => /TRADING/.test(e)));

  const noRules = normalizeOrder({ symbol: 'BTCUSDT', type: 'MARKET', quantity: 1 }, null);
  assert.equal(noRules.ok, false);
});

test('SymbolRulesCache caches exchangeInfo and honours the TTL', async () => {
  let calls = 0;
  let now = 1_000;
  const cache = new SymbolRulesCache({
    clock: () => now,
    ttlMs: 100,
    fetchExchangeInfo: async () => { calls += 1; return INFO; },
  });

  const first = await cache.rules('BTCUSDT');
  assert.equal(first.tickSize, '0.01000000');
  await cache.rules('BTCUSDT');
  assert.equal(calls, 1, 'the second call must hit the cache');

  now += 101;
  await cache.rules('BTCUSDT');
  assert.equal(calls, 2, 'the TTL must expire the cache');

  await cache.rules('BTCUSDT', { force: true });
  assert.equal(calls, 3);

  cache.clear();
  await cache.rules('BTCUSDT');
  assert.equal(calls, 4);
});