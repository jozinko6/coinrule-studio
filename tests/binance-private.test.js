/**
 * binance-private.test.js — signed client against the deterministic mock
 * exchange: signing, time sync, error mapping, idempotency and safety.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockExchange } from '../server/exchange/mock.mjs';
import {
  BINANCE_TIMEOUT, BinanceApiError, BinancePrivate, BinanceTimeoutError,
  WITHDRAWAL_BLOCKED, hasTradePermission,
} from '../server/exchange/binance-private.mjs';

const credentials = { apiKey: 'test-key', apiSecret: 'test-secret' };

function make(overrides = {}, mockOptions = {}) {
  const mock = createMockExchange(mockOptions);
  const client = new BinancePrivate({
    ...credentials,
    baseUrl: 'https://mock.local',
    fetchImpl: mock.fetchImpl,
    ...overrides,
  });
  return { mock, client };
}

test('signed requests resynchronise the clock automatically', async () => {
  const { mock, client } = make();
  mock.setTimestampDrift(30_000); // larger than recvWindow
  const account = await client.accountInfo();
  assert.equal(account.accountType, 'SPOT');
  assert.ok(Math.abs(client.timeOffset - 30_000) < 50, `offset ~30000, got ${client.timeOffset}`);
  assert.ok(mock.state.counters.signed >= 1);
});

test('a bad api key or secret is reported as a typed error', async () => {
  const { client: badKey } = make({ apiKey: 'wrong-key' });
  await assert.rejects(badKey.accountInfo(), (err) => err instanceof BinanceApiError && err.status === 401 && err.code === -2015);

  const { client: badSecret } = make({ apiSecret: 'wrong-secret' });
  await assert.rejects(badSecret.accountInfo(), (err) => err instanceof BinanceApiError && err.status === 401 && err.code === -1022);
});

test('the client never persists the raw key in its description', () => {
  const { client } = make();
  const described = JSON.stringify(client.describe());
  assert.ok(!described.includes('test-key'));
  assert.ok(described.includes('Masked'));
});

test('429 responses surface Retry-After and are not retried', async () => {
  const { mock, client } = make();
  await client.accountInfo(); // warm clock
  const before = mock.state.counters.requests;
  mock.failNext({ status: 429, code: -1003, message: 'Too many requests', retryAfter: 2 });
  await assert.rejects(client.accountInfo(), (err) => err instanceof BinanceApiError && err.status === 429 && err.retryAfter === 2);
  assert.equal(mock.state.counters.requests, before + 1, '429 must not be retried');
});

test('a 5xx GET is retried once, a 5xx POST is never retried', async () => {
  const { mock, client } = make();
  await client.accountInfo();
  mock.failNext({ status: 500, code: -1000, message: 'Internal error' });
  const account = await client.accountInfo();
  assert.equal(account.canTrade, true, 'the retried GET must succeed');

  const before = mock.state.counters.requests;
  mock.failNext({ status: 500, code: -1000, message: 'Internal error' });
  await assert.rejects(
    client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001, clientOrderId: 'cr-500-1' }),
    (err) => err instanceof BinanceApiError && err.status === 500,
  );
  assert.equal(mock.state.counters.requests, before + 1, 'POST must not be retried');
  assert.equal(mock.state.counters.placed, 0);
});

test('market orders fill and limit orders rest, with the caller-supplied clientOrderId', async () => {
  const { mock, client } = make();
  const market = await client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, clientOrderId: 'cr-mkt-1' });
  assert.equal(market.status, 'FILLED');
  assert.equal(market.clientOrderId, 'cr-mkt-1');

  const limit = await client.placeOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', quantity: 0.001, price: 90000, timeInForce: 'GTC', clientOrderId: 'cr-lim-1' });
  assert.equal(limit.status, 'NEW');

  const open = await client.openOrders('BTCUSDT');
  assert.deepEqual(open.map((o) => o.clientOrderId), ['cr-lim-1']);
  assert.equal(mock.getOrder('cr-lim-1').status, 'NEW');
});

test('a duplicate clientOrderId is rejected and flagged for reconciliation', async () => {
  const { client } = make();
  await client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 50000, clientOrderId: 'cr-dup' });
  await assert.rejects(
    client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 50000, clientOrderId: 'cr-dup' }),
    (err) => err instanceof BinanceApiError && err.code === -2010 && err.duplicate === true,
  );
});

test('partial fills are reported as PARTIALLY_FILLED', async () => {
  const { client, mock } = make();
  mock.setPartialFill(0.0004);
  const order = await client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 50000, clientOrderId: 'cr-part' });
  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert.equal(order.executedQty, '0.0004');
});

test('orders can be queried and cancelled by clientOrderId', async () => {
  const { mock, client } = make();
  await client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 50000, clientOrderId: 'cr-cancel' });
  const queried = await client.queryOrder({ symbol: 'BTCUSDT', origClientOrderId: 'cr-cancel' });
  assert.equal(queried.status, 'NEW');

  const cancelled = await client.cancelOrder({ symbol: 'BTCUSDT', origClientOrderId: 'cr-cancel' });
  assert.equal(cancelled.status, 'CANCELED');
  assert.equal(mock.state.counters.canceled, 1);
  assert.deepEqual(await client.openOrders('BTCUSDT'), []);

  await assert.rejects(client.queryOrder({ symbol: 'BTCUSDT', orderId: 9999 }), (err) => err.code === -2013);
});

test('a network timeout after the order was accepted is never resent automatically', async () => {
  const { mock, client } = make();
  mock.setTimeoutAfterAccept();
  await assert.rejects(
    client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, clientOrderId: 'cr-timeout' }),
    (err) => err instanceof BinanceTimeoutError && err.code === BINANCE_TIMEOUT && err.requestAccepted === true,
  );
  assert.equal(mock.state.counters.placed, 1, 'exactly one order reached the exchange');
  assert.ok(mock.getOrder('cr-timeout'), 'the caller can reconcile by clientOrderId');
});

test('withdrawals are hard-blocked before any network call', async () => {
  const { mock, client } = make();
  await assert.rejects(
    client.request('POST', '/sapi/v1/capital/withdraw/apply', { signed: true }),
    (err) => err instanceof BinanceApiError && err.code === WITHDRAWAL_BLOCKED,
  );
  assert.equal(mock.state.counters.requests, 0, 'no HTTP request may leave the process');
  assert.equal(mock.state.counters.withdrawalAttempts, 0);
});

test('order test mode validates without placing anything', async () => {
  const { mock, client } = make();
  const result = await client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 50000, clientOrderId: 'cr-test', test: true });
  assert.deepEqual(result, {});
  assert.equal(mock.state.counters.placed, 0);
});

test('balances, trades and permissions are mapped for the UI', async () => {
  const { client } = make();
  const balances = await client.balances();
  assert.equal(balances.USDT.total, 10000);
  assert.equal(balances.BTC.free, 0.5);

  await client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, clientOrderId: 'cr-trade-1' });
  const trades = await client.myTrades('BTCUSDT');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].symbol, 'BTCUSDT');

  const account = await client.accountInfo();
  assert.equal(hasTradePermission(account), true);
  assert.equal(hasTradePermission({ canTrade: false, permissions: ['SPOT'] }), false);
  assert.equal(hasTradePermission({ canTrade: true, permissions: [] }), false);
});

test('public endpoints work without any credentials', async () => {
  const mock = createMockExchange();
  const client = new BinancePrivate({ ...credentials, baseUrl: 'https://mock.local', fetchImpl: mock.fetchImpl });
  await client.ping();
  const info = await client.exchangeInfo();
  assert.ok(info.symbols.some((s) => s.symbol === 'BTCUSDT'));
  assert.equal(mock.state.counters.signed, 0);
});