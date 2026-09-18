/**
 * attribution.js — per-strategy accounting for shared-portfolio backtests (Phase 17).
 *
 * Several strategies can trade one cash pool at the same time. This module
 * attributes every closed trade to the strategy that opened it and reports
 * gross/net PnL, fees, win rate, deployed capital and return on that capital.
 * Unattributed trades (legacy/manual) land in an `unassigned` bucket instead of
 * being silently dropped.
 */

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const pct = (value) => Math.round((Number(value) || 0) * 10) / 10;

/**
 * @param {Array<object>} trades closed trades (netPnl/totalFees/grossPnl/qty/entryPrice/strategyId)
 * @param {{strategyNames?: Record<string,string>, startingCash?: number}} options
 */
export function perStrategyBreakdown(trades = [], { strategyNames = {}, startingCash = 0 } = {}) {
  const buckets = new Map();

  for (const trade of trades) {
    const id = trade?.strategyId ?? 'unassigned';
    const bucket = buckets.get(id) ?? {
      strategyId: id,
      strategyName: trade?.strategyName ?? strategyNames[id] ?? (id === 'unassigned' ? 'Nepriradené' : id),
      trades: 0,
      wins: 0,
      losses: 0,
      grossPnl: 0,
      fees: 0,
      netPnl: 0,
      capitalDeployed: 0,
      durationMsTotal: 0,
      firstTradeAt: null,
      lastTradeAt: null,
    };
    const net = Number(trade?.netPnl ?? trade?.pnl ?? 0) || 0;
    const gross = Number(trade?.grossPnl ?? net) || 0;
    const fees = Number(trade?.totalFees ?? trade?.fees ?? 0) || 0;
    const deployed = (Number(trade?.entryPrice) || 0) * (Number(trade?.qty) || 0);

    bucket.trades += 1;
    bucket.grossPnl += gross;
    bucket.fees += fees;
    bucket.netPnl += net;
    bucket.capitalDeployed += deployed;
    bucket.durationMsTotal += Number(trade?.durationMs) || 0;
    if (net > 0) bucket.wins += 1;
    else if (net < 0) bucket.losses += 1;
    if (Number.isFinite(trade?.openedAt)) {
      bucket.firstTradeAt = bucket.firstTradeAt === null ? trade.openedAt : Math.min(bucket.firstTradeAt, trade.openedAt);
    }
    if (Number.isFinite(trade?.closedAt)) {
      bucket.lastTradeAt = bucket.lastTradeAt === null ? trade.closedAt : Math.max(bucket.lastTradeAt, trade.closedAt);
    }
    buckets.set(id, bucket);
  }

  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    grossPnl: money(bucket.grossPnl),
    fees: money(bucket.fees),
    netPnl: money(bucket.netPnl),
    capitalDeployed: money(bucket.capitalDeployed),
    winRate: bucket.trades ? pct((bucket.wins / bucket.trades) * 100) : 0,
    avgDurationMs: bucket.trades ? Math.round(bucket.durationMsTotal / bucket.trades) : 0,
    returnOnDeployedPct: bucket.capitalDeployed > 0 ? pct((bucket.netPnl / bucket.capitalDeployed) * 100) : 0,
    portfolioPnlPct: startingCash > 0 ? pct((bucket.netPnl / startingCash) * 100) : 0,
  })).sort((a, b) => (b.netPnl - a.netPnl) || a.strategyName.localeCompare(b.strategyName));
}