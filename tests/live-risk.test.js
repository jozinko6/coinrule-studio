/**
 * live-risk.test.js — every pre-trade gate of the LiveRiskGuard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRiskGuard, RiskViolation, RISK_DEFAULTS } from '../server/services/live-risk.mjs';

function make(limits = {}, start = 1_000_000) {
  let now = start;
  const guard = new LiveRiskGuard({ limits, clock: () => now });
  guard.startSession({ equityQuote: 10_000, killSwitch: false });
  return { guard, advance: (ms) => { now += ms; } };
}

const reject = (promise, check) => assert.rejects(promise, (err) => err instanceof RiskViolation && err.check === check);

test('the kill switch starts ENGAGED and blocks every order', async () => {
  const guard = new LiveRiskGuard();
  assert.equal(guard.killSwitchEngaged, true);
  assert.equal(RISK_DEFAULTS.maxOrderQuote, 1000);
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 1, referencePrice: 100 })), 'kill_switch');
  guard.setKillSwitch(false);
  const result = guard.checkOrder({ symbol: 'BTCUSDT', quantity: 1, referencePrice: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.notional, 100);
});

test('single-order and position notional limits are enforced', async () => {
  const { guard } = make({ maxPositionQuote: 1200 });
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 1, referencePrice: 2000 })), 'max_order_quote');

  guard.onOrderPlaced({ clientOrderId: 'a', symbol: 'BTCUSDT', quote: 900 });
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.2, referencePrice: 3000 })), 'max_position_quote');

  const ok = guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.1, referencePrice: 3000 });
  assert.equal(ok.notional, 300);
});

test('position size is capped by equity percentage', async () => {
  const { guard } = make({ maxOrderQuote: 100_000, maxPositionQuote: 100_000 });
  // 25% of 10 000 = 2 500
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.3, referencePrice: 10_000 })), 'max_position_pct');
  const ok = guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.2, referencePrice: 10_000 });
  assert.equal(ok.notional, 2000);
});

test('open-order and hourly-trade limits are enforced', async () => {
  const { guard, advance } = make({ maxOrderQuote: 100_000, maxOpenOrders: 2, maxTradesPerHour: 3 });
  guard.onOrderPlaced({ clientOrderId: '1', symbol: 'BTCUSDT', quote: 10 });
  guard.onOrderPlaced({ clientOrderId: '2', symbol: 'BTCUSDT', quote: 10 });
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 })), 'max_open_orders');

  guard.onOrderSettled({ clientOrderId: '1' });
  guard.onOrderSettled({ clientOrderId: '2' });
  guard.onOrderPlaced({ clientOrderId: '3', symbol: 'BTCUSDT', quote: 10 });
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 })), 'max_trades_per_hour');

  advance(61 * 60_000);
  const ok = guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 });
  assert.equal(ok.ok, true);
});

test('a loss starts a cooldown and consecutive losses stop new entries', async () => {
  const { guard, advance } = make({ maxConsecutiveLosses: 99 });
  guard.onTradeClosed({ pnl: -5 });
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 })), 'cooldown_after_loss');
  advance(15 * 60_000 + 1);
  assert.equal(guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 }).ok, true);

  const strict = make({ maxConsecutiveLosses: 3, cooldownAfterLossMs: 0 }).guard;
  strict.onTradeClosed({ pnl: -1 });
  strict.onTradeClosed({ pnl: -1 });
  strict.onTradeClosed({ pnl: -1 });
  await reject(Promise.resolve().then(() => strict.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 })), 'max_consecutive_losses');
  strict.onTradeClosed({ pnl: 2 });
  assert.equal(strict.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 }).ok, true, 'a win resets the counter');
});

test('daily loss and drawdown limits halt trading', async () => {
  const { guard } = make({ maxConsecutiveLosses: 99, cooldownAfterLossMs: 0, maxDailyLossPct: 5 });
  guard.onTradeClosed({ pnl: -600 }); // 6% of 10 000
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 })), 'max_daily_loss');

  const dd = make({ maxDrawdownPct: 20 }).guard;
  dd.onEquity(12_000);
  dd.onEquity(9_000); // 25% from peak
  await reject(Promise.resolve().then(() => dd.checkOrder({ symbol: 'BTCUSDT', quantity: 0.001, referencePrice: 10_000 })), 'max_drawdown');
});

test('reduce-only orders bypass size limits but not the kill switch', async () => {
  const { guard } = make({ maxOrderQuote: 100, maxPositionQuote: 100 });
  const reduce = guard.checkOrder({ symbol: 'BTCUSDT', quantity: 5, referencePrice: 10_000, reduceOnly: true });
  assert.equal(reduce.notional, 50_000);
  guard.setKillSwitch(true);
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 5, referencePrice: 10_000, reduceOnly: true })), 'kill_switch');
});

test('symbol lists and invalid inputs are validated', async () => {
  const { guard } = make({ allowedSymbols: ['BTCUSDT'] });
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'PEPEUSDT', quantity: 1, referencePrice: 1 })), 'symbol_not_allowed');

  const blocked = make({ blockedSymbols: ['PEPEUSDT'] }).guard;
  await reject(Promise.resolve().then(() => blocked.checkOrder({ symbol: 'PEPEUSDT', quantity: 1, referencePrice: 1 })), 'symbol_blocked');

  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 0, referencePrice: 1 })), 'invalid_quantity');
  await reject(Promise.resolve().then(() => guard.checkOrder({ symbol: 'BTCUSDT', quantity: 1, referencePrice: 0 })), 'invalid_price');
});

test('settlement releases reserved exposure and the snapshot reports state', () => {
  const { guard } = make({ maxOrderQuote: 100_000, maxPositionQuote: 100_000 });
  guard.onOrderPlaced({ clientOrderId: 'o1', symbol: 'BTCUSDT', quote: 4000 });
  assert.equal(guard.snapshot().openQuoteBySymbol.BTCUSDT, 4000);
  guard.onOrderSettled({ clientOrderId: 'o1', pnl: 12.5 });
  const snap = guard.snapshot();
  assert.equal(snap.openQuoteBySymbol.BTCUSDT, 0);
  assert.equal(snap.openOrders, 0);
  assert.equal(snap.dailyRealizedPnl, 12.5);
  assert.equal(snap.violations, 0);
  assert.equal(snap.limits.maxOrderQuote, 100_000);
});