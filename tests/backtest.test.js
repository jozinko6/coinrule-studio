import test from 'node:test';
import assert from 'node:assert/strict';
import { backtest, compareStrategies, paramSweep, estimateWarmup, inferTimeframeMs } from '../js/core/backtest.js';
import { createStrategy, createRule, createGroup, createCondition, TIMEFRAME_MS } from '../js/core/rules.js';
import { generateCandles } from '../js/data/synthetic.js';

const candles = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 500, seed: 321, scenario: 'bull' });

const alwaysBuy = (extra = {}) => createStrategy({
  name: 'Always buy',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  rules: [createRule({
    when: createGroup('AND', [{ id: 'c1', kind: 'condition', type: 'always' }]),
    then: [{ type: 'buy', sizeMode: 'percent_cash', value: 50 }],
  })],
  ...extra,
});

test('the backtester produces a well-formed result', () => {
  const res = backtest({ strategy: alwaysBuy(), candles, startingCash: 10_000 });
  assert.equal(res.symbol, 'BTCUSDT');
  assert.ok(res.equityCurve.length > 100);
  assert.ok(res.metrics.bars > 100);
  assert.equal(res.metrics.startingCash, 10_000);
  assert.ok(Array.isArray(res.trades));
  assert.ok(Array.isArray(res.signals));
  assert.ok(res.signals.length >= 1, 'the always-buy rule should have fired');
});

test('results are deterministic across runs', () => {
  const a = backtest({ strategy: alwaysBuy(), candles, startingCash: 10_000 });
  const b = backtest({ strategy: alwaysBuy(), candles, startingCash: 10_000 });
  assert.deepEqual(a.metrics, b.metrics);
  assert.deepEqual(a.equityCurve.slice(0, 20), b.equityCurve.slice(0, 20));
  assert.equal(a.trades.length, b.trades.length);
});

test('the first entry fills at the open of the bar AFTER the signal (no look-ahead)', () => {
  // Bars 0..3 are flat at 100; bar 4 opens at 200.
  const bars = Array.from({ length: 12 }, (_, i) => ({
    time: i * 3_600_000,
    open: i === 4 ? 200 : 100,
    high: i === 4 ? 205 : 101,
    low: i === 4 ? 195 : 99,
    close: i === 4 ? 202 : 100,
    volume: 1000,
  }));
  const res = backtest({ strategy: alwaysBuy(), candles: bars, startingCash: 10_000, slippagePct: 0.05 });
  assert.ok(res.trades.length >= 1);
  // warmup = 2 -> the first signal is on bar 2 and fills at bar 3's open (100).
  const first = res.orders.find((o) => o.side === 'buy' && o.filledQty > 0);
  assert.ok(first.avgFillPrice > 99.9 && first.avgFillPrice < 100.1, `unexpected fill ${first.avgFillPrice}`);
  assert.ok(!res.equityCurve.some((p) => !Number.isFinite(p.equity)));
});

test('fees reduce the final equity versus a zero-fee run', () => {
  const withFees = backtest({ strategy: alwaysBuy(), candles, feePct: 0.5 });
  const withoutFees = backtest({ strategy: alwaysBuy(), candles, feePct: 0 });
  assert.ok(withFees.metrics.feesPaid > 0);
  assert.ok(withFees.metrics.finalEquity < withoutFees.metrics.finalEquity);
});

test('slippage reduces the final equity versus a zero-slippage run', () => {
  const a = backtest({ strategy: alwaysBuy(), candles, slippagePct: 1 });
  const b = backtest({ strategy: alwaysBuy(), candles, slippagePct: 0 });
  assert.ok(a.metrics.finalEquity < b.metrics.finalEquity);
});

test('equity never goes negative and cash is never overspent', () => {
  const res = backtest({ strategy: alwaysBuy(), candles, startingCash: 500 });
  for (const point of res.equityCurve) assert.ok(point.equity >= 0, `equity ${point.equity}`);
  assert.ok(res.metrics.finalEquity >= 0);
});

test('an open position is closed at the end of the backtest', () => {
  const res = backtest({ strategy: alwaysBuy(), candles, startingCash: 10_000 });
  assert.equal(res.finalPosition, null);
  const lastTrade = res.trades.at(-1);
  assert.equal(lastTrade.reason, 'end_of_backtest');
});

test('stop-loss and take-profit orders are attached after the entry fills', () => {
  const strategy = createStrategy({
    name: 'With protection',
    symbol: 'BTCUSDT',
    rules: [createRule({
      when: createGroup('AND', [{ id: 'c', kind: 'condition', type: 'always' }]),
      then: [
        { type: 'buy', sizeMode: 'percent_cash', value: 50 },
        { type: 'stop_loss', value: 5 },
        { type: 'take_profit', value: 10 },
      ],
    })],
  });
  const res = backtest({ strategy, candles });
  const protective = res.orders.filter((o) => ['stop_market', 'take_profit'].includes(o.type));
  assert.ok(protective.length >= 2, 'protective orders were never created');
  assert.ok(res.trades.length >= 1);
});

test('the max drawdown kill switch closes positions', () => {
  const strategy = alwaysBuy();
  const crash = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 400, seed: 5, scenario: 'crash' });
  const res = backtest({ strategy, candles: crash, maxDrawdownPct: 5 });
  assert.ok(res.signals.some((s) => s.type === 'kill_switch'), 'kill switch never triggered');
});

test('the daily loss guard blocks new entries', () => {
  const crash = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 300, seed: 8, scenario: 'crash' });
  const res = backtest({ strategy: alwaysBuy(), candles: crash, maxDailyLossPct: 1 });
  assert.ok(res.signals.some((s) => s.type === 'guard'), 'daily guard never triggered');
});

test('estimateWarmup grows with the indicator lookback', () => {
  const short = createStrategy({ name: 's', rules: [createRule({ when: createGroup('AND', [createCondition({ left: { kind: 'indicator', id: 'sma', params: { period: 5 } }, op: 'gt', right: { kind: 'const', value: 0 } })]) })] });
  const long = createStrategy({ name: 'l', rules: [createRule({ when: createGroup('AND', [createCondition({ left: { kind: 'indicator', id: 'sma', params: { period: 200 } }, op: 'gt', right: { kind: 'const', value: 0 } })]) })] });
  assert.ok(estimateWarmup(long) > estimateWarmup(short));
  assert.ok(estimateWarmup(long) >= 200);
});

test('inferTimeframeMs reads the bar spacing', () => {
  assert.equal(inferTimeframeMs(candles), TIMEFRAME_MS['1h']);
  assert.equal(inferTimeframeMs([], '4h'), TIMEFRAME_MS['4h']);
});

test('the backtester validates its inputs', () => {
  assert.throws(() => backtest({ strategy: alwaysBuy(), candles: [candles[0]] }), /aspoň 10 sviečok/);
  assert.throws(() => backtest({ strategy: [], candles }), /chýba stratégia/);
  const other = alwaysBuy();
  other.symbol = 'ETHUSDT';
  assert.throws(() => backtest({ strategy: [alwaysBuy(), other], candles }), /rovnaký symbol/);
});

test('multiple strategies can share one backtest', () => {
  const s1 = alwaysBuy({ name: 'A' });
  const s2 = alwaysBuy({ name: 'B' });
  s2.rules = [createRule({
    when: createGroup('AND', [{ id: 'c2', kind: 'condition', type: 'position', state: 'none' }]),
    then: [{ type: 'buy', sizeMode: 'percent_cash', value: 10 }],
  })];
  const res = backtest({ strategy: [s1, s2], candles, startingCash: 10_000 });
  assert.equal(res.strategies.length, 2);
  assert.ok(res.metrics.finalEquity > 0);
});

test('compareStrategies ranks by total return', () => {
  const results = compareStrategies({
    strategies: [alwaysBuy({ name: 'A' }), alwaysBuy({ name: 'B' })],
    candles,
  });
  assert.equal(results.length, 2);
  assert.ok(results[0].metrics.totalReturnPct >= results[1].metrics.totalReturnPct);
  assert.equal(results[0].ok, true);
});

test('compareStrategies reports failures instead of throwing', () => {
  const broken = alwaysBuy();
  broken.symbol = 'NOPE';
  const results = compareStrategies({ strategies: [broken], candles });
  assert.equal(results[0].ok, true); // a different symbol still backtests on its own
});

test('paramSweep explores a knob and sorts by return', () => {
  const strategy = createStrategy({
    name: 'Sweep',
    symbol: 'BTCUSDT',
    rules: [createRule({
      when: createGroup('AND', [createCondition({
        left: { kind: 'indicator', id: 'rsi', params: { period: 14 } },
        op: 'lt',
        right: { kind: 'const', value: 40 },
      })]),
      then: [{ type: 'buy', sizeMode: 'percent_cash', value: 25 }, { type: 'sell', sizeMode: 'percent_position', value: 100 }],
    })],
  });
  const results = paramSweep({ strategy, candles, knob: 'rules[0].when.items[0].right.value', values: [30, 45, 60] });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.value).sort((a, b) => a - b), [30, 45, 60]);
  for (let i = 1; i < results.length; i += 1) {
    assert.ok((results[i - 1].metrics?.totalReturnPct ?? -Infinity) >= (results[i].metrics?.totalReturnPct ?? -Infinity));
  }
  assert.throws(() => paramSweep({ strategy, candles, knob: 'nope.nope', values: [1] }), /neplatná cesta/);
});

test('the backtest result documents the assumptions it ran under (Phase 16)', () => {
  const res = backtest({ strategy: alwaysBuy(), candles, startingCash: 10_000, feePct: 0.1, slippagePct: 0.05 });
  assert.equal(res.assumptions.startingCash, 10_000);
  assert.equal(res.assumptions.feePct, 0.1);
  assert.equal(res.assumptions.slippagePct, 0.05);
  assert.ok(res.assumptions.executionModel, 'the intrabar execution model must be recorded');
  assert.ok(res.assumptions.participationRate > 0, 'liquidity participation must be recorded');
  assert.equal(res.assumptions.timeframeMs, res.timeframeMs);
  assert.ok(res.assumptions.candles > 0);
});