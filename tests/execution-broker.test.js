/**
 * execution-broker.test.js — no order path may bypass mode, reconciliation,
 * the risk guard, exchange filters or idempotency.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { createLiveSession, getLiveSession, setSessionReconciliation } from '../server/db/live-repository.mjs';
import { createMockExchange } from '../server/exchange/mock.mjs';
import { BinancePrivate } from '../server/exchange/binance-private.mjs';
import { SymbolRulesCache } from '../server/exchange/filters.mjs';
import { LiveRiskGuard, RiskViolation } from '../server/services/live-risk.mjs';
import { TradingModeManager } from '../server/services/mode.mjs';
import { OrderIdempotency } from '../server/services/idempotency.mjs';
import { ExecutionBroker, ExecutionRefused } from '../server/services/execution-broker.mjs';

const credentials = { apiKey: 'test-key', apiSecret: 'test-secret' };

function setup({ limits = {}, reconciled = true, killSwitch = false, mode = 'testnet' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinrule-broker-'));
  const db = openDatabase({ file: path.join(dir, 'test.db') });
  const mock = createMockExchange();
  const client = new BinancePrivate({ ...credentials, baseUrl: 'https://mock.local', fetchImpl: mock.fetchImpl });
  const rulesCache = new SymbolRulesCache({ fetchExchangeInfo: () => mock.fetchImpl('https://mock.local/api/v3/exchangeInfo').then((r) => r.json()) });
  const guard = new LiveRiskGuard({ limits: { maxOrderQuote: 100_000, maxPositionQuote: 100_000, ...limits } });
  guard.startSession({ equityQuote: 10_000, killSwitch });
  const modes = new TradingModeManager({ hasCredentials: () => true });
  if (mode === 'testnet') modes.goTestnet();
  const session = createLiveSession(db, { environment: mode, symbol: 'BTCUSDT' });
  if (reconciled) setSessionReconciliation(db, session.id, 'ok');
  const idempotency = new OrderIdempotency({ db });
  const broker = new ExecutionBroker({ mode: modes, guard, rulesCache, idempotency, client });
  return {
    db, mock, guard, modes, broker, idempotency, session: getLiveSession(db, session.id),
    stop() {
      try { db.close(); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const order = (extra = {}) => ({
  session: null, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET',
  quantity: 0.001, referencePrice: 60_000, intentId: 'cycle1:entry', ...extra,
});

test('paper mode can never place an exchange order', async () => {
  const s = setup({ mode: 'paper' });
  try {
    await assert.rejects(
      s.broker.placeOrder(order({ session: s.session })),
      (err) => err instanceof ExecutionRefused && err.check === 'mode',
    );
    assert.equal(s.mock.state.counters.requests, 0, 'nothing may reach the network');
  } finally {
    s.stop();
  }
});

test('an unreconciled session is refused before the risk guard runs', async () => {
  const s = setup({ reconciled: false });
  try {
    await assert.rejects(
      s.broker.placeOrder(order({ session: s.session })),
      (err) => err.check === 'reconciliation',
    );
    assert.equal(s.mock.state.counters.requests, 0);
  } finally {
    s.stop();
  }
});

test('the kill switch blocks placeOrder but never a cancellation', async () => {
  const s = setup({ killSwitch: true });
  try {
    await assert.rejects(
      s.broker.placeOrder(order({ session: s.session })),
      (err) => err instanceof RiskViolation && err.check === 'kill_switch',
    );
    assert.equal(s.mock.state.counters.requests, 0);
  } finally {
    s.stop();
  }
});

test('a normalized order is submitted exactly once through idempotency', async () => {
  const s = setup();
  try {
    const first = await s.broker.placeOrder(order({ session: s.session, quantity: 0.0012345 }));
    assert.equal(first.skipped, false);
    assert.equal(first.normalized.quantity, 0.00123, 'the 1e-5 step size floors the quantity');
    assert.equal(s.mock.state.counters.placed, 1);
    assert.equal(first.order.status, 'FILLED');
    assert.equal(s.guard.snapshot().openQuoteBySymbol.BTCUSDT, 0.00123 * 60_000);

    const second = await s.broker.placeOrder(order({ session: s.session, quantity: 0.0012345 }));
    assert.equal(second.skipped, true, 'the same intent must never place twice');
    assert.equal(s.mock.state.counters.placed, 1);
  } finally {
    s.stop();
  }
});

test('filters and risk limits refuse before any network call', async () => {
  const tiny = setup();
  try {
    await assert.rejects(
      tiny.broker.placeOrder(order({ session: tiny.session, quantity: 0.0000001 })),
      (err) => err instanceof ExecutionRefused && err.check === 'filters',
    );
    assert.equal(tiny.mock.state.counters.placed, 0, 'the exchange must get no order');
    assert.equal(tiny.mock.state.counters.signed, 0, 'no signed request may leave');
  } finally {
    tiny.stop();
  }

  const capped = setup({ limits: { maxOrderQuote: 10 } });
  try {
    await assert.rejects(
      capped.broker.placeOrder(order({ session: capped.session, quantity: 0.001, referencePrice: 60_000 })),
      (err) => err instanceof RiskViolation && err.check === 'max_order_quote',
    );
    assert.equal(capped.mock.state.counters.placed, 0);
    assert.equal(capped.mock.state.counters.signed, 0);
  } finally {
    capped.stop();
  }
});

test('an unknown symbol is refused, not guessed', async () => {
  const s = setup();
  try {
    await assert.rejects(
      s.broker.placeOrder(order({ session: s.session, symbol: 'NOPEUSDT' })),
      (err) => err.check === 'rules',
    );
    assert.equal(s.mock.state.counters.placed, 0);
    assert.equal(s.mock.state.counters.signed, 0);
  } finally {
    s.stop();
  }
});

test('cancellation works while the kill switch is engaged', async () => {
  const s = setup();
  try {
    const placed = await s.broker.placeOrder(order({ session: s.session, type: 'LIMIT', quantity: 0.001, price: 50_000, intentId: 'cycle1:limit' }));
    s.guard.setKillSwitch(true);
    const cancelled = await s.broker.cancelOrder({ session: s.session, symbol: 'BTCUSDT', clientOrderId: placed.clientOrderId });
    assert.equal(cancelled.status, 'CANCELED');
    assert.equal(s.mock.state.counters.canceled, 1);
  } finally {
    s.stop();
  }
});

test('reduce-only orders may exceed size limits (but still need a clean session)', async () => {
  const s = setup({ limits: { maxOrderQuote: 100 } });
  try {
    const result = await s.broker.placeOrder(order({ session: s.session, quantity: 0.001, referencePrice: 60_000, reduceOnly: true, intentId: 'cycle1:exit' }));
    assert.equal(result.skipped, false);
    assert.equal(s.mock.state.counters.placed, 1);
  } finally {
    s.stop();
  }
});