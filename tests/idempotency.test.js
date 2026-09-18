/**
 * idempotency.test.js — exactly-once submission against the mock exchange
 * and the real SQLite live_orders table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { createLiveSession, getLiveOrderByClientId, insertLiveOrder, listLiveOrders, sumLiveFees, insertLiveFill } from '../server/db/live-repository.mjs';
import { OrderIdempotency, clientOrderIdFor } from '../server/services/idempotency.mjs';
import { createMockExchange } from '../server/exchange/mock.mjs';
import { BinancePrivate } from '../server/exchange/binance-private.mjs';

const credentials = { apiKey: 'test-key', apiSecret: 'test-secret' };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinrule-idem-'));
  const db = openDatabase({ file: path.join(dir, 'test.db') });
  const mock = createMockExchange();
  const client = new BinancePrivate({ ...credentials, baseUrl: 'https://mock.local', fetchImpl: mock.fetchImpl });
  const session = createLiveSession(db, { environment: 'testnet', symbol: 'BTCUSDT' });
  const idem = new OrderIdempotency({ db });
  return {
    db, mock, client, session, idem,
    intent: { sessionId: session.id, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 0.001, intentId: 'sig1' },
    submit: (clientOrderId) => client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, clientOrderId }),
    stop() {
      try { db.close(); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('client order ids are deterministic from the intent, safe and short', () => {
  const a = clientOrderIdFor({ strategyId: 'strat-1', intentId: 'cycle7:entry' });
  const b = clientOrderIdFor({ strategyId: 'strat-1', intentId: 'cycle7:entry' });
  const c = clientOrderIdFor({ strategyId: 'strat-1', intentId: 'cycle7:exit' });
  assert.equal(a, b, 'a retry of the same intent must reuse the id');
  assert.notEqual(a, c, 'a different intent must get a different id');
  assert.notEqual(clientOrderIdFor({ strategyId: 's1', intentId: 'x' }), clientOrderIdFor({ strategyId: 's2', intentId: 'x' }));
  assert.ok(a.length <= 36);
  assert.match(a, /^[a-zA-Z0-9-]+$/);
  assert.throws(() => clientOrderIdFor({}), /intentId/);
});

test('submit without intentId or clientOrderId is refused', async () => {
  const s = setup();
  try {
    await assert.rejects(
      s.idem.submit({ sessionId: s.session.id, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 0.001 }, s.submit),
      /intentId/,
    );
    assert.equal(s.mock.state.counters.placed, 0);
  } finally {
    s.stop();
  }
});

test('a market order is submitted exactly once and stored as FILLED', async () => {
  const s = setup();
  try {
    const first = await s.idem.submit(s.intent, s.submit);
    assert.equal(first.skipped, false);
    assert.equal(s.mock.state.counters.placed, 1);
    const stored = getLiveOrderByClientId(s.db, first.clientOrderId);
    assert.equal(stored.status, 'FILLED');
    assert.ok(stored.exchange_order_id);

    const second = await s.idem.submit(s.intent, s.submit);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'id_used', 'a completed order id is never reused for a new submission');
    assert.equal(s.mock.state.counters.placed, 1, 'the exchange must never see it twice');
    assert.equal(listLiveOrders(s.db, s.session.id).length, 1);
  } finally {
    s.stop();
  }
});

test('a closed order id is never reused for a new submission', async () => {
  const s = setup();
  try {
    const { clientOrderId } = await s.idem.submit(s.intent, s.submit);
    s.idem.resolve(clientOrderId, 'CANCELED');
    const again = await s.idem.submit({ ...s.intent, clientOrderId }, s.submit);
    assert.equal(again.skipped, true);
    assert.equal(again.reason, 'id_used');
    assert.equal(s.mock.state.counters.placed, 1);
  } finally {
    s.stop();
  }
});

test('a timeout after acceptance is UNKNOWN and is never resent', async () => {
  const s = setup();
  try {
    s.mock.setTimeoutAfterAccept();
    await assert.rejects(s.idem.submit(s.intent, s.submit), (err) => err.requiresReconciliation === true && Boolean(err.clientOrderId));
    assert.equal(s.mock.state.counters.placed, 1, 'the exchange accepted the order');

    const retry = await s.idem.submit(s.intent, s.submit);
    assert.equal(retry.skipped, true);
    assert.equal(retry.reason, 'already_submitted');
    assert.equal(retry.order.status, 'UNKNOWN');
    assert.equal(s.mock.state.counters.placed, 1, 'a timeout must never cause a resend');
  } finally {
    s.stop();
  }
});

test('an exchange duplicate-id answer is treated as already accepted', async () => {
  const s = setup();
  try {
    s.mock.failNext({ status: 400, code: -2010, message: 'Duplicate order sent.' });
    await assert.rejects(s.idem.submit(s.intent, s.submit), (err) => err.requiresReconciliation === true);
    const row = listLiveOrders(s.db, s.session.id)[0];
    assert.equal(row.status, 'UNKNOWN', 'reconciliation must resolve it, not the client');
  } finally {
    s.stop();
  }
});

test('a clean rejection is stored as REJECTED without reconciliation', async () => {
  const s = setup();
  try {
    s.mock.failNext({ status: 400, code: -1013, message: 'Filter failure: LOT_SIZE' });
    await assert.rejects(s.idem.submit(s.intent, s.submit), (err) => err.requiresReconciliation === false);
    const row = listLiveOrders(s.db, s.session.id)[0];
    assert.equal(row.status, 'REJECTED');
    assert.match(row.raw_json, /LOT_SIZE/);
  } finally {
    s.stop();
  }
});

test('the live repository protects against duplicate rows and tracks fees', () => {
  const s = setup();
  try {
    const base = { sessionId: s.session.id, clientOrderId: 'cr-dup-1', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', qty: 0.001, price: 50000, status: 'PENDING' };
    assert.equal(insertLiveOrder(s.db, base).inserted, true);
    assert.equal(insertLiveOrder(s.db, { ...base, id: 'other-id' }).inserted, false, 'client_order_id must be unique');
    assert.equal(listLiveOrders(s.db, s.session.id).length, 1);

    insertLiveFill(s.db, { sessionId: s.session.id, symbol: 'BTCUSDT', qty: 0.001, price: 50000, fee: 0.05, feeAsset: 'USDT' });
    insertLiveFill(s.db, { sessionId: s.session.id, symbol: 'BTCUSDT', qty: 0.001, price: 51000, fee: 0.02, feeAsset: 'USDT' });
    assert.ok(Math.abs(sumLiveFees(s.db, s.session.id) - 0.07) < 1e-12);
  } finally {
    s.stop();
  }
});