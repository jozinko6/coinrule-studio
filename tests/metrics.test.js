import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, maxDrawdown, monthlyReturns, tradeStats, stdev, downsideDeviation, returnsFrom } from '../js/core/metrics.js';

const DAY = 86_400_000;
const curve = (equities) => equities.map((equity, i) => ({ time: i * DAY, equity }));
const trade = (pnl, pnlPct, durationMs = DAY) => ({ pnl, pnlPct, fees: 0.1, durationMs, entryPrice: 100, exitPrice: 100 + pnl });

test('max drawdown finds the worst peak-to-trough move', () => {
  const dd = maxDrawdown(curve([100, 120, 90, 110, 100]));
  assert.equal(dd.maxDrawdownPct, 25); // 120 -> 90
});

test('returns and stdev are computed on bar returns', () => {
  const rets = returnsFrom(curve([100, 110, 121]));
  assert.equal(rets.length, 2);
  assert.ok(Math.abs(rets[0] - 0.1) < 1e-12);
  assert.equal(stdev([2, 2, 2]), 0);
  assert.ok(stdev([1, 2, 3, 4]) > 0);
  assert.equal(downsideDeviation([0.1, 0.1]), 0);
});

test('tradeStats aggregates wins, losses and streaks', () => {
  const s = tradeStats([
    trade(10, 10), trade(-5, -5), trade(20, 20), trade(5, 5), trade(-2, -2), trade(-3, -3),
  ]);
  assert.equal(s.trades, 6);
  assert.equal(s.wins, 3);
  assert.equal(s.losses, 3);
  assert.equal(s.winRatePct, 50);
  assert.ok(Math.abs(s.profitFactor - 35 / 10) < 1e-9);
  assert.equal(s.maxConsecutiveWins, 2);
  assert.equal(s.maxConsecutiveLosses, 2);
  // money helpers round to 8 decimals: 25/6 -> 4.16666667
  assert.equal(s.expectancy, 4.16666667);
  assert.equal(s.netPnl, 25);
  assert.equal(s.avgWin, 11.66666667);
  assert.equal(s.avgLoss, 3.33333333);
  assert.equal(s.payoffRatio, 3.5);
});

test('tradeStats handles the empty case without dividing by zero', () => {
  const s = tradeStats([]);
  assert.equal(s.trades, 0);
  assert.equal(s.winRatePct, 0);
  assert.equal(s.profitFactor, 0);
});

test('a monotonically rising curve yields positive metrics and zero drawdown', () => {
  const eq = curve([10_000, 10_100, 10_200, 10_300]);
  const m = computeMetrics({
    equityCurve: eq,
    trades: [trade(50, 1), trade(50, 1)],
    startingCash: 10_000,
    timeframeMs: DAY,
  });
  assert.ok(m.totalReturnPct > 0);
  assert.equal(m.maxDrawdownPct, 0);
  assert.ok(m.sharpe > 0);
  assert.equal(m.trades, 2);
  assert.equal(m.winRatePct, 100);
});

test('metrics degrade gracefully on an empty curve', () => {
  const m = computeMetrics({ equityCurve: [], trades: [] });
  assert.equal(m.empty, true);
});

test('benchmark comparison produces alpha', () => {
  const eq = curve([10_000, 11_000]);
  const benchmark = [{ time: 0, price: 100 }, { time: DAY, price: 105 }];
  const m = computeMetrics({ equityCurve: eq, trades: [], startingCash: 10_000, timeframeMs: DAY, benchmark });
  assert.equal(m.benchmarkReturnPct, 5);
  assert.ok(Math.abs(m.alphaPct - 5) < 1e-9);
});

test('computeMetrics exposes monthly returns for API consumers', () => {
  const t0 = Date.UTC(2024, 0, 5);
  const eq = [
    { time: t0, equity: 1000 },
    { time: t0 + 20 * DAY, equity: 1100 },
    { time: t0 + 40 * DAY, equity: 1210 },
  ];
  const m = computeMetrics({ equityCurve: eq, trades: [], startingCash: 1000, timeframeMs: DAY });
  assert.equal(m.monthly.length, 2);
  assert.equal(m.monthly[0].month, '2024-01');
  assert.equal(m.monthly[0].returnPct, 10);
});

test('monthly returns group by calendar month', () => {
  const t0 = Date.UTC(2024, 0, 5);
  const eq = [
    { time: t0, equity: 1000 },
    { time: t0 + 20 * DAY, equity: 1100 },
    { time: t0 + 40 * DAY, equity: 1210 },
  ];
  const months = monthlyReturns(eq);
  assert.equal(months.length, 2);
  assert.equal(months[0].month, '2024-01');
  assert.ok(Math.abs(months[0].returnPct - 10) < 1e-6);
  assert.ok(Math.abs(months[1].returnPct - 10) < 1e-6);
});

test('CAGR and calmar are consistent with the curve', () => {
  const year = 365;
  const eq = curve(Array.from({ length: year + 1 }, (_, i) => 10_000 * 1.0001 ** i));
  const m = computeMetrics({ equityCurve: eq, trades: [], startingCash: 10_000, timeframeMs: DAY });
  assert.ok(m.cagrPct > 0);
  assert.ok(Number.isFinite(m.calmar));
  assert.ok(Number.isFinite(m.sortino));
  assert.ok(Number.isFinite(m.volatilityPct));
});
