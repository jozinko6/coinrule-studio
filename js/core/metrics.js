/**
 * metrics.js — performance analytics for an equity curve + trade list.
 * All numbers are deterministic (no Date.now(), no randomness).
 */

import { roundPct, roundCash, pctChange } from './money.js';

export const BARS_PER_YEAR = (timeframeMs) => (365 * 24 * 60 * 60 * 1000) / timeframeMs;

export function returnsFrom(equityCurve) {
  const out = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const a = equityCurve[i - 1].equity;
    const b = equityCurve[i].equity;
    out.push(a === 0 ? 0 : (b - a) / a);
  }
  return out;
}

export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function stdev(values, sample = true) {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  const acc = values.reduce((a, v) => a + (v - m) ** 2, 0);
  return Math.sqrt(acc / (sample ? n - 1 : n));
}

export function downsideDeviation(values, target = 0) {
  const neg = values.map((v) => Math.min(0, v - target));
  if (neg.length < 2) return 0;
  return Math.sqrt(neg.reduce((a, v) => a + v * v, 0) / neg.length);
}

/** Max drawdown in percent plus the peak/trough timestamps. */
export function maxDrawdown(equityCurve) {
  let peak = -Infinity;
  let peakTime = null;
  let worst = 0;
  let worstPeak = null;
  let worstTrough = null;
  for (const p of equityCurve) {
    if (p.equity > peak) { peak = p.equity; peakTime = p.time; }
    const dd = peak === 0 ? 0 : ((peak - p.equity) / peak) * 100;
    if (dd > worst) { worst = dd; worstPeak = peakTime; worstTrough = p.time; }
  }
  return { maxDrawdownPct: roundPct(worst), peakTime: worstPeak, troughTime: worstTrough };
}

/** Longest stretch (in ms) below a previous peak. */
export function longestDrawdown(equityCurve) {
  let peak = -Infinity;
  let peakTime = null;
  let worst = 0;
  for (const p of equityCurve) {
    if (p.equity >= peak) { peak = p.equity; peakTime = p.time; }
    if (peakTime !== null && p.time - peakTime > worst) worst = p.time - peakTime;
  }
  return worst;
}

export function tradeStats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  let streak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const t of trades) {
    if (t.pnl > 0) { streak = streak > 0 ? streak + 1 : 1; maxWinStreak = Math.max(maxWinStreak, streak); }
    else { streak = streak < 0 ? streak - 1 : -1; maxLossStreak = Math.min(maxLossStreak, streak); }
  }

  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: n ? roundPct((wins.length / n) * 100) : 0,
    grossProfit: roundCash(grossProfit),
    grossLoss: roundCash(grossLoss),
    netPnl: roundCash(grossProfit - grossLoss),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? null : 0) : roundCash(grossProfit / grossLoss),
    avgWin: roundCash(avgWin),
    avgLoss: roundCash(avgLoss),
    payoffRatio: avgLoss === 0 ? null : roundCash(avgWin / avgLoss),
    expectancy: n ? roundCash((grossProfit - grossLoss) / n) : 0,
    expectancyPct: n ? roundPct(trades.reduce((a, t) => a + t.pnlPct, 0) / n) : 0,
    maxConsecutiveWins: maxWinStreak,
    maxConsecutiveLosses: Math.abs(maxLossStreak),
    bestTrade: sorted.length ? sorted[0] : null,
    worstTrade: sorted.length ? sorted[sorted.length - 1] : null,
    avgDurationMs: n ? trades.reduce((a, t) => a + (t.durationMs ?? 0), 0) / n : 0,
    totalFees: roundCash(trades.reduce((a, t) => a + (t.fees ?? 0), 0)),
    avgPnlPct: n ? roundPct(trades.reduce((a, t) => a + t.pnlPct, 0) / n) : 0,
  };
}

/** Group equity samples by calendar month -> [{ month:'2024-01', returnPct }] */
export function monthlyReturns(equityCurve) {
  if (equityCurve.length < 2) return [];
  const byMonth = new Map();
  for (const p of equityCurve) {
    const d = new Date(p.time);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, { first: p.equity, last: p.equity });
    const m = byMonth.get(key);
    m.last = p.equity;
  }
  const months = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out = [];
  let prevClose = equityCurve[0].equity;
  for (const [month, m] of months) {
    out.push({ month, returnPct: roundPct(pctChange(prevClose, m.last)), startEquity: roundCash(prevClose), endEquity: roundCash(m.last) });
    prevClose = m.last;
  }
  return out;
}

/**
 * Full performance report.
 * @param {object} args
 * @param {Array<{time:number,equity:number}>} args.equityCurve
 * @param {Array} args.trades
 * @param {number} args.startingCash
 * @param {number} args.timeframeMs
 * @param {Array<{time:number,price:number}>} [args.benchmark] buy&hold curve
 */
export function computeMetrics({ equityCurve, trades = [], startingCash = 10_000, timeframeMs = 3_600_000, benchmark = null, feesPaid = 0, exposureSamples = [] }) {
  if (!equityCurve.length) {
    return { empty: true, trades: 0 };
  }
  const first = equityCurve[0].equity;
  const lastEq = equityCurve[equityCurve.length - 1].equity;
  const rets = returnsFrom(equityCurve);
  const periods = rets.length;
  const barsPerYear = BARS_PER_YEAR(timeframeMs);
  const totalReturnPct = roundPct(pctChange(first, lastEq));
  const years = periods / barsPerYear;
  const cagr = years > 0 && first > 0 && lastEq > 0 ? roundPct(((lastEq / first) ** (1 / years) - 1) * 100) : 0;
  const avgRet = mean(rets);
  const sd = stdev(rets);
  const dd = downsideDeviation(rets);
  const sharpe = sd === 0 ? 0 : roundPct(((avgRet - 0) / sd) * Math.sqrt(barsPerYear));
  const sortino = dd === 0 ? 0 : roundPct((avgRet / dd) * Math.sqrt(barsPerYear));
  const ddInfo = maxDrawdown(equityCurve);
  const volatilityPct = roundPct(sd * Math.sqrt(barsPerYear) * 100);
  const calmar = ddInfo.maxDrawdownPct === 0 ? 0 : roundPct(cagr / ddInfo.maxDrawdownPct);
  const tStats = tradeStats(trades);

  let benchmarkReturnPct = null;
  let alphaPct = null;
  if (benchmark && benchmark.length > 1) {
    benchmarkReturnPct = roundPct(pctChange(benchmark[0].price, benchmark[benchmark.length - 1].price));
    alphaPct = roundPct(totalReturnPct - benchmarkReturnPct);
  }

  const exposurePct = exposureSamples.length
    ? roundPct((exposureSamples.filter((x) => x > 0).length / exposureSamples.length) * 100)
    : 0;

  return {
    empty: false,
    startTime: equityCurve[0].time,
    endTime: equityCurve[equityCurve.length - 1].time,
    bars: equityCurve.length,
    startingCash: roundCash(startingCash),
    finalEquity: roundCash(lastEq),
    netProfit: roundCash(lastEq - first),
    totalReturnPct,
    cagrPct: cagr,
    sharpe: sharpe === 0 ? 0 : sharpe,
    sortino,
    calmar,
    volatilityPct,
    maxDrawdownPct: ddInfo.maxDrawdownPct,
    maxDrawdownPeakTime: ddInfo.peakTime,
    maxDrawdownTroughTime: ddInfo.troughTime,
    longestDrawdownMs: longestDrawdown(equityCurve),
    exposurePct,
    feesPaid: roundCash(feesPaid),
    benchmarkReturnPct,
    alphaPct,
    monthly: monthlyReturns(equityCurve),
    ...tStats,
  };
}

/** Compact one-line summary used in the UI cards. */
export function summarise(metrics) {
  if (!metrics || metrics.empty) return 'Žiadne dáta';
  return `${metrics.totalReturnPct}% | DD ${metrics.maxDrawdownPct}% | Sharpe ${metrics.sharpe} | ${metrics.trades} obchodov`;
}
