/**
 * attribution.test.js — per-strategy accounting over a shared cash pool (Phase 17).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { perStrategyBreakdown } from '../js/core/attribution.js';
import { backtest } from '../js/core/backtest.js';
import { createStrategy, createRule, createGroup } from '../js/core/rules.js';
import { generateCandles } from '../js/data/synthetic.js';

const trade = (overrides = {}) => ({
  strategyId: 's1',
  netPnl: 10,
  grossPnl: 11,
  totalFees: 1,
  qty: 1,
  entryPrice: 100,
  closedAt: 2,
  openedAt: 1,
  durationMs: 1,
  ...overrides,
});

test('groups trades by strategy and derives the accounting fields', () => {
  const rows = perStrategyBreakdown([
    trade({ netPnl: 10, grossPnl: 11, totalFees: 1, entryPrice: 100, qty: 1 }),
    trade({ netPnl: -5, grossPnl: -4, totalFees: 1, entryPrice: 200, qty: 0.5 }),
  ], { strategyNames: { s1: 'Alpha' }, startingCash: 1_000 });

  assert.equal(rows.length, 1);
  const [alpha] = rows;
  assert.equal(alpha.strategyName, 'Alpha');
  assert.equal(alpha.trades, 2);
  assert.equal(alpha.wins, 1);
  assert.equal(alpha.losses, 1);
  assert.equal(alpha.winRate, 50);
  assert.equal(alpha.grossPnl, 7, 'gross sums both trades');
  assert.equal(alpha.fees, 2);
  assert.equal(alpha.netPnl, 5);
  assert.equal(alpha.capitalDeployed, 200, '100*1 + 200*0.5');
  assert.equal(alpha.returnOnDeployedPct, 2.5, '5 / 200');
  assert.equal(alpha.portfolioPnlPct, 0.5, '5 / 1000');
  assert.equal(alpha.firstTradeAt, 1);
  assert.equal(alpha.lastTradeAt, 2);
});

test('unattributed trades land in an explicit bucket and names fall back to the id', () => {
  const rows = perStrategyBreakdown([
    trade({ strategyId: null, netPnl: 3 }),
    trade({ strategyId: 'sX', netPnl: 1 }),
  ]);
  const unassigned = rows.find((r) => r.strategyId === 'unassigned');
  const named = rows.find((r) => r.strategyId === 'sX');
  assert.ok(unassigned, 'null strategyId must not be dropped');
  assert.equal(unassigned.strategyName, 'Nepriradené');
  assert.equal(named.strategyName, 'sX');
});

test('rows are sorted by net PnL and tolerate missing fields without NaN', () => {
  const rows = perStrategyBreakdown([
    trade({ strategyId: 'small', netPnl: 1 }),
    trade({ strategyId: 'big', netPnl: 50 }),
    { strategyId: 'weird' }, // no fields at all
  ]);
  assert.deepEqual(rows.map((r) => r.strategyId), ['big', 'small', 'weird']);
  const weird = rows.find((r) => r.strategyId === 'weird');
  assert.equal(weird.netPnl, 0);
  assert.equal(weird.winRate, 0);
  assert.equal(weird.returnOnDeployedPct, 0, 'no deployed capital -> 0, never Infinity/NaN');
  assert.ok(rows.every((r) => [r.netPnl, r.winRate, r.returnOnDeployedPct, r.portfolioPnlPct].every(Number.isFinite)));
});

test('an empty trade list produces an empty breakdown', () => {
  assert.deepEqual(perStrategyBreakdown([], { startingCash: 1_000 }), []);
  assert.deepEqual(perStrategyBreakdown(), []);
});

const alwaysBuy = (name) => createStrategy({
  name,
  symbol: 'BTCUSDT',
  timeframe: '1h',
  rules: [createRule({
    when: createGroup('AND', [{ id: 'c1', kind: 'condition', type: 'always' }]),
    then: [{ type: 'buy', sizeMode: 'percent_cash', value: 50 }],
  })],
});

test('every backtest trade is attributed to the strategy that opened it', () => {
  const candles = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 400, seed: 77, scenario: 'bull' });
  const a = alwaysBuy('Alpha');
  const res = backtest({ strategy: a, candles, startingCash: 10_000 });

  assert.ok(res.trades.length >= 1);
  assert.ok(
    res.trades.every((t) => t.strategyId === a.id),
    'an internally forced exit (end_of_backtest) must keep the opener identity',
  );
  const rows = res.metrics.perStrategy;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].strategyId, a.id, 'the old bug bucketed this as unassigned');
  assert.equal(rows[0].strategyName, 'Alpha');

  const sumNet = rows.reduce((acc, r) => acc + r.netPnl, 0);
  const tradesNet = res.trades.reduce((acc, t) => acc + (t.netPnl ?? 0), 0);
  assert.ok(Math.abs(sumNet - tradesNet) < 0.05, `attribution ${sumNet} must reconcile with trades ${tradesNet}`);
  assert.equal(rows.reduce((acc, r) => acc + r.trades, 0), res.trades.length);
  assert.ok(rows[0].capitalDeployed > 0);
});

test('two same-symbol strategies run serially on one position and stay attributable', () => {
  // One position per symbol + allowPyramiding:false means the second strategy
  // cannot open while the first one holds; attribution must survive whichever
  // strategy actually traded (never "unassigned").
  const candles = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 400, seed: 77, scenario: 'bull' });
  const a = alwaysBuy('Alpha');
  const b = alwaysBuy('Beta');
  const res = backtest({ strategy: [a, b], candles, startingCash: 10_000 });

  const rows = res.metrics.perStrategy;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.strategyId !== 'unassigned'), 'no trade may lose its strategy');
  assert.ok(rows.every((r) => [a.id, b.id].includes(r.strategyId)));
  const sumNet = rows.reduce((acc, r) => acc + r.netPnl, 0);
  const tradesNet = res.trades.reduce((acc, t) => acc + (t.netPnl ?? 0), 0);
  assert.ok(Math.abs(sumNet - tradesNet) < 0.05);
  assert.equal(rows.reduce((acc, r) => acc + r.trades, 0), res.trades.length);
});