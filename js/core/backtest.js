/**
 * backtest.js — event-driven backtester.
 *
 * Bar loop (no look-ahead):
 *   1. broker.onCandle(bar)  -> fills orders queued on the previous bar at THIS
 *                               bar's open, then processes stops/limits inside
 *                               the bar's range.
 *   2. runtime.onBar(bar)    -> evaluates rules on THIS bar's close and queues
 *                               orders for the next bar's open.
 *   3. mark equity to the close.
 */

import { PaperBroker } from './paper.js';
import { Portfolio } from './portfolio.js';
import { StrategyRuntime } from './engine.js';
import { computeMetrics } from './metrics.js';
import { collectIndicatorRefs, TIMEFRAME_MS } from './rules.js';
import { roundCash } from './money.js';

/** Conservative warm-up estimate: the largest lookback any indicator needs. */
export function estimateWarmup(strategy) {
  let w = 2;
  for (const ref of collectIndicatorRefs(strategy)) {
    for (const v of Object.values(ref.params ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v) && v > w && v < 5000) w = Math.ceil(v);
    }
    if (ref.id === 'macd' || ref.id === 'macd_signal' || ref.id === 'macd_hist') w = Math.max(w, 35);
    if (ref.id === 'ichimoku_tenkan' || ref.id === 'ichimoku_kijun') w = Math.max(w, 60);
  }
  // rules may also use `bars`/`risingBars` lookbacks
  const walk = (n) => {
    if (!n) return;
    if (n.kind === 'group') { (n.items ?? []).forEach(walk); return; }
    w = Math.max(w, n.bars ?? 0, n.risingBars ?? 0, (n.offset ?? 0) + 1);
  };
  (strategy.rules ?? []).forEach((r) => walk(r.when));
  return w;
}

/**
 * @param {object} args
 * @param {object|Array} args.strategy   single strategy or array (same symbol)
 * @param {Array} args.candles           OHLCV bars, oldest first
 * @param {number} [args.startingCash]
 * @param {number} [args.feePct]
 * @param {number} [args.slippagePct]
 * @param {boolean} [args.allowPyramiding]
 * @param {number} [args.maxDrawdownPct]
 * @param {number} [args.maxDailyLossPct]
 */
export function backtest(args) {
  const {
    candles,
    startingCash = 10_000,
    feePct = 0.1,
    slippagePct = 0.05,
    participationRate = 0.25,
    executionModel = 'conservative',
    makerFeePct = null,
    allowPyramiding = false,
    maxDrawdownPct = 0,
    maxDailyLossPct = 0,
    cooldownBars = 0,
  } = args;
  const strategies = Array.isArray(args.strategy) ? args.strategy : [args.strategy];
  if (!strategies.length) throw new Error('backtest: chýba stratégia');
  if (!Array.isArray(candles) || candles.length < 10) throw new Error('backtest: potrebných aspoň 10 sviečok');

  const symbol = strategies[0].symbol;
  for (const s of strategies) {
    if (s.symbol !== symbol) throw new Error('backtest: všetky stratégie musia mať rovnaký symbol');
  }

  const timeframeMs = inferTimeframeMs(candles, strategies[0].timeframe);
  const portfolio = new Portfolio({ cash: startingCash, feePct, startingCash });
  const broker = new PaperBroker({
    symbol,
    startingCash,
    takerFeePct: feePct,
    makerFeePct: makerFeePct ?? feePct,
    slippagePct,
    participationRate,
    executionModel,
    mode: 'backtest',
    portfolio,
    // Deterministic ids so two identical runs produce identical reports.
    idFactory: (n) => `ord_bt_${String(n).padStart(5, '0')}`,
  });
  const runtime = new StrategyRuntime({
    strategies,
    broker,
    options: { allowPyramiding, maxDrawdownPct, maxDailyLossPct, cooldownBars, timeframe: strategies[0].timeframe },
  });
  runtime.prepare(candles);

  const warmup = Math.max(2, ...strategies.map(estimateWarmup));
  const equityCurve = [];
  const exposureSamples = [];
  const startIndex = Math.min(warmup, candles.length - 1);

  equityCurve.push({ time: candles[startIndex].time, equity: roundCash(startingCash), price: candles[startIndex].close });

  for (let i = startIndex; i < candles.length; i += 1) {
    const bar = candles[i];
    broker.onCandle(bar);
    runtime.onBar(candles, i);
    const eq = broker.portfolio.equity(broker.lastPrice);
    equityCurve.push({ time: bar.time, equity: roundCash(eq), price: bar.close });
    exposureSamples.push(broker.portfolio.exposurePct(broker.lastPrice));
  }

  // Close everything at the end so trade stats include the open position.
  const lastBar = candles[candles.length - 1];
  broker.cancelAll(symbol);
  const openPos = broker.portfolio.position(symbol);
  if (openPos) {
    broker.mode = 'live';
    broker.setPrice(lastBar.close, lastBar.time);
    broker.submit({ symbol, side: 'sell', type: 'market', qty: openPos.qty, reduceOnly: true, reason: 'end_of_backtest' });
  }

  const finalEquity = broker.portfolio.equity(lastBar.close);
  equityCurve[equityCurve.length - 1] = { time: lastBar.time, equity: roundCash(finalEquity), price: lastBar.close };

  const benchmark = candles.slice(startIndex).map((c) => ({ time: c.time, price: c.close }));
  const metrics = computeMetrics({
    equityCurve,
    trades: broker.trades,
    startingCash,
    timeframeMs,
    benchmark,
    // The buy&hold benchmark uses the same taker fee assumptions on both legs so
    // the comparison is net, not gross (Phase 16).
    benchmarkFeePct: feePct,
    feesPaid: broker.portfolio.feesPaid,
    exposureSamples,
  });

  const warnings = [];
  const dataLabel = timeframeMs % 60_000 === 0 ? `${Math.round(timeframeMs / 60_000)} minútové sviečky` : `sviečky po ${Math.round(timeframeMs / 1000)} s`;
  for (const s of strategies) {
    const declaredMs = TIMEFRAME_MS[s.timeframe];
    if (declaredMs && Math.abs(declaredMs - timeframeMs) > 1) {
      warnings.push(`Stratégia „${s.name}“ je nastavená na ${s.timeframe}, ale dáta majú ${dataLabel}.`);
    }
  }

  return {
    symbol,
    strategies: strategies.map((s) => ({ id: s.id, name: s.name })),
    timeframeMs,
    assumptions: {
      startingCash,
      feePct,
      makerFeePct: makerFeePct ?? feePct,
      slippagePct,
      participationRate,
      executionModel,
      allowPyramiding,
      maxDrawdownPct,
      maxDailyLossPct,
      cooldownBars,
      warmup,
      timeframeMs,
      candles: candles.length,
      dataSource: args.dataSource ?? 'unknown',
    },
    warnings,
    warmup,
    candles,
    equityCurve,
    trades: broker.trades,
    orders: [...broker.orders.values()],
    signals: runtime.signals,
    events: broker.events,
    portfolio: broker.portfolio.snapshot(lastBar.close),
    metrics,
    finalPosition: null,
  };
}

export function inferTimeframeMs(candles, fallbackTimeframe = '1h') {
  if (candles.length >= 2) {
    const dt = candles[1].time - candles[0].time;
    if (Number.isFinite(dt) && dt > 0) return dt;
  }
  const table = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000 };
  return table[fallbackTimeframe] ?? 3_600_000;
}

/** Compare several strategies on the same candles (parameter sweep / A-B). */
export function compareStrategies({ strategies, candles, startingCash = 10_000, feePct = 0.1, slippagePct = 0.05 }) {
  return strategies.map((strategy) => {
    try {
      const res = backtest({ strategy, candles, startingCash, feePct, slippagePct });
      return {
        strategyId: strategy.id,
        name: strategy.name,
        ok: true,
        metrics: res.metrics,
        trades: res.trades.length,
        equityCurve: res.equityCurve,
      };
    } catch (err) {
      return { strategyId: strategy.id, name: strategy.name, ok: false, error: err.message };
    }
  }).sort((a, b) => (b.metrics?.totalReturnPct ?? -Infinity) - (a.metrics?.totalReturnPct ?? -Infinity));
}

/** Simple grid search over one numeric knob (e.g. RSI period). */
export function paramSweep({ strategy, candles, knob, values, startingCash = 10_000, feePct = 0.1, slippagePct = 0.05 }) {
  const results = [];
  for (const value of values) {
    const clone = JSON.parse(JSON.stringify(strategy));
    applyKnob(clone, knob, value);
    try {
      const res = backtest({ strategy: clone, candles, startingCash, feePct, slippagePct });
      results.push({ value, ok: true, metrics: res.metrics });
    } catch (err) {
      results.push({ value, ok: false, error: err.message });
    }
  }
  return results.sort((a, b) => (b.metrics?.totalReturnPct ?? -Infinity) - (a.metrics?.totalReturnPct ?? -Infinity));
}

/**
 * knob format: "rules[0].when.items[0].right.value" or
 *              "rules[0].when.items[0].left.params.period"
 */
function applyKnob(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = cur[parts[i]];
    if (cur === undefined || cur === null) throw new Error(`paramSweep: neplatná cesta ${path}`);
  }
  cur[parts[parts.length - 1]] = value;
}
