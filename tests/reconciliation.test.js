/**
 * reconciliation.test.js — exchange truth wins: UNKNOWN orders get resolved,
 * external orders are imported and flagged, fills import idempotently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { createLiveSession, getLiveOrderByClientId, getLiveSession, listLiveFills, listLiveOrders, insertLiveOrder } from '../server/db/live-repository.mjs';
import { OrderIdempotency } from '../server/services/idempotency.mjs';
import { Reconciler, canTradeAfterReconciliation } from '../server/services/reconciliation.mjs';
import { createMockExchange } from '../server/exchange/mock.mjs';
import { BinancePrivate } from '../server/exchange/binance-private.mjs';

const credentials = { apiKey: 'test-key', apiSecret: 'test-secret' };

function setup({ symbol = 'BTCUSDT' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinrule-rec-'));
  const db = openDatabase({ file: path.join(dir, 'test.db') });
  const mock = createMockExchange();
  const client = new BinancePrivate({ ...credentials, baseUrl: 'https://mock.local', fetchImpl: mock.fetchImpl });
  const session = createLiveSession(db, { environment: 'testnet', symbol });
  const idem = new OrderIdempotency({ db });
  const reconciler = new Reconciler({ db, client });
  const intent = (intentId) => ({ sessionId: session.id, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 0.001, intentId });
  const submit = (clientOrderId) => client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, clientOrderId });
  return {
    db, mock, client, session, idem, reconciler, intent, submit,
    stop() {
      try { db.close(); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a consistent session reconciles to ok and imports fills exactly once', async () => {
  const s = setup();
  try {
    await s.idem.submit(s.intent('c1:entry'), s.submit);
    const first = await s.reconciler.reconcileSession(s.session);
    assert.equal(first.state, 'ok');
    assert.equal(first.fillsImported, 1);
    assert.equal(listLiveFills(s.db, s.session.id).length, 1);
    assert.equal(getLiveSession(s.db, s.session.id).reconciliation_state, 'ok');
    assert.equal(canTradeAfterReconciliation(getLiveSession(s.db, s.session.id)), true);

    const second = await s.reconciler.reconcileSession(s.session);
    assert.equal(second.fillsImported, 0, 'fills must import idempotently');
    assert.equal(listLiveFills(s.db, s.session.id).length, 1);
  } finally {
    s.stop();
  }
});

test('an UNKNOWN order accepted by the exchange is resolved to FILLED', async () => {
  const s = setup();
  try {
    s.mock.setTimeoutAfterAccept();
    await assert.rejects(s.idem.submit(s.intent('c2:entry'), s.submit));
    assert.equal(listLiveOrders(s.db, s.session.id)[0].status, 'UNKNOWN');

    const report = await s.reconciler.reconcileSession(s.session);
    assert.equal(report.state, 'ok');
    assert.ok(report.resolved.some((r) => r.from === 'UNKNOWN' && r.to === 'FILLED'));
    assert.equal(listLiveOrders(s.db, s.session.id)[0].status, 'FILLED');
  } finally {
    s.stop();
  }
});

test('an UNKNOWN order the exchange never saw becomes REJECTED', async () => {
  const s = setup();
  try {
    s.mock.setTimeoutBeforeAccept();
    await assert.rejects(s.idem.submit(s.intent('c3:entry'), s.submit));
    const report = await s.reconciler.reconcileSession(s.session);
    assert.equal(report.state, 'ok');
    assert.ok(report.resolved.some((r) => r.reason === 'never_accepted_at_exchange'));
    assert.equal(listLiveOrders(s.db, s.session.id)[0].status, 'REJECTED');
    assert.equal(s.mock.state.counters.placed, 0);
  } finally {
    s.stop();
  }
});

test('an external order is imported and reported as a mismatch (until reconciled)', async () => {
  const s = setup();
  try {
    await s.client.placeOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.0005, clientOrderId: 'cr-external-1' });
    const first = await s.reconciler.reconcileSession(s.session);
    assert.equal(first.state, 'mismatch');
    assert.deepEqual(first.imported, ['cr-external-1']);
    assert.ok(first.mismatches.some((m) => m.kind === 'external_order'));
    assert.ok(first.mismatches.some((m) => m.kind === 'open_state_drift' || m.kind === 'external_order'));
    const imported = getLiveOrderByClientId(s.db, 'cr-external-1');
    assert.equal(imported.intent_id, 'external');
    assert.equal(imported.status, 'FILLED');

    const second = await s.reconciler.reconcileSession(s.session);
    assert.equal(second.state, 'ok', 'the imported order is known after the first pass');
    assert.equal(second.imported.length, 0);
    assert.equal(listLiveOrders(s.db, s.session.id).length, 1);
  } finally {
    s.stop();
  }
});

test('a partial fill cancelled on the exchange is synced locally', async () => {
  const s = setup();
  try {
    s.mock.setPartialFill(0.001);
    const placed = await s.idem.submit(
      { ...s.intent('c5:entry'), type: 'LIMIT', price: 50000 },
      (clientOrderId) => s.client.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.002, price: 50000, timeInForce: 'GTC', clientOrderId }),
    );
    assert.equal(placed.order.status, 'PARTIALLY_FILLED');
    await s.client.cancelOrder({ symbol: 'BTCUSDT', origClientOrderId: placed.clientOrderId });

    const report = await s.reconciler.reconcileSession(s.session);
    assert.equal(report.state, 'ok');
    assert.ok(report.resolved.some((r) => r.from === 'PARTIALLY_FILLED' && r.to === 'CANCELED'));
    assert.equal(getLiveOrderByClientId(s.db, placed.clientOrderId).status, 'CANCELED');
  } finally {
    s.stop();
  }
});

test('a session without a symbol reconciles without order history', async () => {
  const s = setup({ symbol: null });
  try {
    await s.idem.submit(s.intent('c6:entry'), s.submit);
    const report = await s.reconciler.reconcileSession(s.session);
    assert.equal(report.state, 'ok');
    assert.equal(report.fillsImported, 0, 'myTrades needs a symbol; nothing may be invented');
  } finally {
    s.stop();
  }
});

test('a locally open order missing at the exchange is flagged, not silently trusted', async () => {
  const s = setup();
  try {
    insertLiveOrder(s.db, { sessionId: s.session.id, clientOrderId: 'cr-ghost-1', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', qty: 0.001, price: 50000, status: 'NEW' });
    const report = await s.reconciler.reconcileSession(s.session);
    assert.equal(report.state, 'mismatch');
    assert.ok(report.mismatches.some((m) => m.kind === 'missing_at_exchange' && m.clientOrderId === 'cr-ghost-1'));
    assert.equal(canTradeAfterReconciliation(getLiveSession(s.db, s.session.id)), false);
  } finally {
    s.stop();
  }
});