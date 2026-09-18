/**
 * engine.js — the shared strategy runtime.
 *
 * The same runtime drives backtests and live virtual trading, which guarantees
 * that what you backtest is exactly what you trade.
 *
 * Usage:
 *   const rt = new StrategyRuntime({ strategies, broker });
 *   rt.prepare(candles);                 // pre-compute indicator series once
 *   for (let i = 0; i < candles.length; i++) rt.onBar(candles, i);
 */

import {
  collectIndicatorRefs, makeOperandResolver, evaluateNode, evaluateCondition,
  describeRule, describeCondition, describeGroup,
} from './rules.js';
import { computeIndicator, candlePatterns, atr } from './indicators.js';
import { roundQty } from './money.js';
import { RiskGuard, capByMaxPosition } from './risk.js';

/** Actions that need an open position and are queued until the entry fills. */
export const PROTECTIVE_ACTIONS = new Set(['take_profit', 'stop_loss', 'trailing_stop', 'break_even']);

export class StrategyRuntime {
  /**
   * @param {object} opts
   * @param {Array} opts.strategies
   * @param {import('./paper.js').PaperBroker} opts.broker
   * @param {object} [opts.options]
   */
  constructor({ strategies = [], broker, options = {} }) {
    this.strategies = strategies;
    this.broker = broker;
    this.options = {
      dryRun: false,
      allowPyramiding: false,
      defaultStopPct: 2,
      maxOpenPositions: 1,
      maxDrawdownPct: 0,
      maxDailyLossPct: 0,
      cooldownBars: 0,
      ...options,
    };
    this.cache = new Map();     // strategyId -> Map(key -> series)
    this.ruleState = new Map(); // `${strategyId}:${ruleId}` -> {triggers,lastIndex,paused}
    this.strategyPaused = new Set(); // strategyIds paused by a `pause` action
    this.signals = [];          // human-readable log of what fired
    this.pendingProtection = new Map(); // symbol -> protective actions awaiting a fill
    this.guard = new RiskGuard({
      maxDrawdownPct: this.options.maxDrawdownPct,
      maxDailyLossPct: this.options.maxDailyLossPct,
      cooldownBars: this.options.cooldownBars,
    });
    this.blockedUntilNextDay = false;
    this.killed = false;
    // Protective orders must be armed the moment an entry actually fills (at the
    // real average fill price), not at the bar close: otherwise a bar whose low
    // breaches the stop before the close would be survived by the strategy.
    if (this.broker) this.broker.onEntryFilled = (order, fill) => this.handleEntryFill(order, fill);
  }

  /* --------------------------------------------------------------- prepare */

  prepare(candles) {
    this.candles = candles;
    this.cache.clear();
    for (const s of this.strategies) {
      const map = new Map();
      for (const ref of collectIndicatorRefs(s)) {
        map.set(ref.key, computeIndicator(ref.id, candles, ref.params));
      }
      this.cache.set(s.id, map);
    }
    // Pre-compute candle patterns for pattern conditions (O(n) once).
    this.patternsByBar = candles.map((_, i) => (i < 2 ? [] : candlePatterns(candles.slice(i - 2, i + 1))));
    this.atrCache = new Map();
    return this;
  }

  atrFor(strategy, index) {
    const key = `atr|${strategy.risk?.atrPeriod ?? 14}`;
    if (!this.atrCache.has(key)) this.atrCache.set(key, atr(this.candles, strategy.risk?.atrPeriod ?? 14));
    return this.atrCache.get(key)[index];
  }

  stateFor(strategyId, ruleId) {
    const key = `${strategyId}:${ruleId}`;
    if (!this.ruleState.has(key)) this.ruleState.set(key, { triggers: 0, lastIndex: -Infinity, paused: false });
    return this.ruleState.get(key);
  }

  /* ------------------------------------------------------------ evaluation */

  makeContext(strategy, index) {
    const candles = this.candles;
    const resolver = makeOperandResolver(candles, this.cache.get(strategy.id) ?? new Map());
    return {
      index,
      candles,
      resolver,
      price: candles[index]?.close ?? 0,
      patterns: this.patternsByBar[index] ?? [],
      portfolio: this.broker.portfolio,
      position: this.broker.portfolio.position(strategy.symbol),
      divergenceCache: this.divergenceCache ?? (this.divergenceCache = new Map()),
    };
  }

  /** Evaluate one rule -> boolean. */
  ruleMatches(rule, ctx) {
    if (!rule.enabled) return false;
    return evaluateNode(rule.when, ctx);
  }

  /** Detailed breakdown used by the UI ("prečo sa nespustilo"). */
  diagnose(strategy, index) {
    const ctx = this.makeContext(strategy, index);
    return (strategy.rules ?? []).map((rule) => ({
      ruleId: rule.id,
      name: rule.name,
      text: describeRule(rule),
      enabled: rule.enabled !== false,
      matches: this.ruleMatches(rule, ctx),
      tree: diagnoseNode(rule.when, ctx),
    }));
  }

  /* ------------------------------------------------------------------ bars */

  onBar(candles, index) {
    const candle = candles[index];
    if (!candle) return [];
    this.broker.setPrice(candle.close, candle.time);

    // --- portfolio level kill switches -----------------------------------
    const prices = this.broker.lastPrice;
    const { drawdownPct } = this.broker.portfolio.markToMarket(prices);
    const guardResult = this.guard.evaluate({
      time: candle.time,
      equity: this.broker.portfolio.equity(prices),
      drawdownPct,
    });
    this.blockedUntilNextDay = guardResult.blockEntries;
    if (guardResult.kill && !this.killed) {
      this.killed = true;
      this.emergencyClose('max_drawdown', index);
    }
    for (const ev of this.guard.events.splice(0)) {
      this.signals.push({ time: candle.time, type: ev.type, message: ev.message });
    }

    const executed = [];
    if (this.killed) return executed;

    for (const strategy of this.strategies) {
      if (strategy.enabled === false) continue;
      if (strategy.symbol !== this.broker.symbol) continue;
      // NOTE: strategy.timeframe is advisory — the bar size is whatever the
      // caller feeds in (session timeframe / backtest candles). A mismatch is
      // reported as a warning by the backtester and the UI instead of silently
      // disabling the strategy.
      const ctx = this.makeContext(strategy, index);
      // Attach protective orders (SL/TP/trailing) once the entry actually filled.
      this.flushProtection(strategy.symbol, ctx);
      for (const rule of strategy.rules ?? []) {
        if (this.strategyPaused.has(strategy.id)) break;
        const st = this.stateFor(strategy.id, rule.id);
        if (st.paused) continue;
        if (rule.oneShot && st.triggers > 0) continue;
        if (rule.maxTriggers > 0 && st.triggers >= rule.maxTriggers) continue;
        const cooldown = Math.max(rule.cooldownBars ?? 0, strategy.risk?.cooldownBars ?? 0, this.options.cooldownBars);
        if (cooldown > 0 && index - st.lastIndex < cooldown) continue;
        if (!this.ruleMatches(rule, ctx)) continue;

        st.triggers += 1;
        st.lastIndex = index;
        const signal = {
          time: candle.time,
          index,
          strategyId: strategy.id,
          strategyName: strategy.name,
          ruleId: rule.id,
          ruleName: rule.name,
          text: describeRule(rule),
          price: candle.close,
          actions: [],
        };
        const protectives = (rule.then ?? []).filter((a) => PROTECTIVE_ACTIONS.has(a.type));
        const alreadyProtected = this.broker.portfolio.position(strategy.symbol)?.protectionApplied;
        if (protectives.length && !alreadyProtected) {
          // Queue BEFORE the entry action so the fill hook can arm the protection
          // at the real fill price (live fills immediately, backtest next open).
          this.pendingProtection.set(strategy.symbol, {
            actions: protectives,
            ruleId: rule.id,
            strategyId: strategy.id,
          });
        }
        for (const action of rule.then ?? []) {
          if (PROTECTIVE_ACTIONS.has(action.type)) continue;
          const outcome = this.runAction(strategy, rule, action, ctx);
          if (outcome) signal.actions.push(outcome);
          if (action.type === 'pause') this.strategyPaused.add(strategy.id);
          if (action.type === 'resume') this.strategyPaused.delete(strategy.id);
        }
        this.flushProtection(strategy.symbol, ctx);
        this.signals.push(signal);
        executed.push(signal);
        if (this.options.dryRun) break;
      }
    }
    return executed;
  }

  /**
   * Create the protective orders for a pending protection spec at the given
   * price. Called from the broker's entry-fill hook `handleEntryFill` (real fill
   * price) and, as a fallback, from `flushProtection` at the bar close.
   */
  applyProtection(pending, symbol, price, time) {
    const actions = Array.isArray(pending) ? pending : pending?.actions;
    if (!actions?.length) return false;
    const pos = this.broker.portfolio.position(symbol);
    if (!pos) return false;
    if (pos.protectionApplied) { this.pendingProtection.delete(symbol); return false; }
    if (this.options.dryRun) { pos.protectionApplied = true; this.pendingProtection.delete(symbol); return true; }
    for (const action of actions) {
      this.broker.executeAction(action, {
        symbol,
        price,
        time,
        // Keep the originating rule so protective exits stay attributable in
        // the trade log (analytics, per-rule stats).
        ruleId: pending.ruleId ?? null,
        strategyId: pending.strategyId ?? null,
        reason: action.type,
      });
    }
    pos.protectionApplied = true;
    this.pendingProtection.delete(symbol);
    return true;
  }

  /** Broker hook: an entry filled, arm its protection immediately. */
  handleEntryFill(order, fill) {
    if (!order || order.side !== 'buy') return;
    const pending = this.pendingProtection.get(order.symbol);
    if (!pending) return;
    this.applyProtection(pending, order.symbol, fill.price, fill.time);
  }

  /**
   * Fallback for cases where the fill hook did not fire (e.g. the position
   * already existed, or a live fill happened before the rule was evaluated).
   */
  flushProtection(symbol, ctx) {
    const pending = this.pendingProtection.get(symbol);
    if (!pending) return false;
    return this.applyProtection(pending, symbol, ctx.price, ctx.candles[ctx.index].time);
  }

  /** Risk-checked action execution. */
  runAction(strategy, rule, action, ctx) {
    const { broker } = this;
    const symbol = strategy.symbol;
    const portfolio = broker.portfolio;
    const price = ctx.price;
    const isEntry = action.type === 'buy' || action.type === 'dca';

    if (isEntry) {
      if (this.blockedUntilNextDay) return { type: action.type, status: 'blocked_daily_loss' };
      const pos = portfolio.position(symbol);
      const openCount = portfolio.openPositions.length;
      const maxOpen = strategy.risk?.maxOpenPositions ?? this.options.maxOpenPositions;
      if (!pos && openCount >= maxOpen) return { type: action.type, status: 'blocked_max_positions' };
      if (pos && !strategy.allowPyramiding && action.type === 'buy') return { type: action.type, status: 'blocked_pyramiding' };

      // cap by maxPositionPct
      const maxPct = strategy.risk?.maxPositionPct ?? 100;
      const equity = portfolio.equity(price);
      const currentNotional = pos ? pos.qty * price : 0;
      if (currentNotional >= (equity * maxPct) / 100) return { type: action.type, status: 'blocked_max_position_size' };

      const sized = broker.sizeOrder(action, {
        price,
        atr: this.atrFor(strategy, ctx.index),
        stopPct: action.stopPct ?? strategy.risk?.stopLossPct ?? this.options.defaultStopPct,
        symbol,
      });
      const allowedQty = capByMaxPosition({ qty: sized, price, equity, maxPositionPct: maxPct, currentNotional });
      if (!(allowedQty > 0)) return { type: action.type, status: 'zero_size' };
      if (this.options.dryRun) return { type: action.type, status: 'dry_run', qty: roundQty(allowedQty) };
      const orders = broker.submit({
        symbol, side: 'buy', type: 'market', qty: roundQty(allowedQty),
        createdAt: ctx.candles[ctx.index].time, ruleId: rule.id, strategyId: strategy.id, reason: rule.name ?? 'entry',
      });
      return { type: action.type, status: 'submitted', orderId: orders.id, qty: roundQty(allowedQty) };
    }

    if (this.options.dryRun) return { type: action.type, status: 'dry_run' };
    const orders = broker.executeAction(action, {
      symbol,
      price,
      time: ctx.candles[ctx.index].time,
      atr: this.atrFor(strategy, ctx.index),
      stopPct: strategy.risk?.stopLossPct,
      ruleId: rule.id,
      strategyId: strategy.id,
      reason: rule.name ?? action.type,
    });
    return { type: action.type, status: orders.length ? 'submitted' : 'noop', orders: orders.length };
  }

  emergencyClose(reason, index) {
    const time = this.candles[index]?.time ?? 0;
    for (const pos of this.broker.portfolio.openPositions) {
      this.broker.cancelAll(pos.symbol);
      this.broker.submit({ symbol: pos.symbol, side: 'sell', type: 'market', qty: pos.qty, reduceOnly: true, reason, createdAt: time });
    }
    this.signals.push({ time, type: 'kill_switch', message: `Núdzové zatvorenie všetkých pozícií (${reason}).` });
  }
}

function diagnoseNode(node, ctx) {
  if (!node) return null;
  if (node.kind !== 'group') {
    return { kind: 'condition', text: describeCondition(node), pass: evaluateCondition(node, ctx) };
  }
  const items = (node.items ?? []).map((it) => diagnoseNode(it, ctx));
  let pass;
  if (node.logic === 'OR') pass = items.some((i) => i.pass);
  else if (node.logic === 'NOT') pass = !items.some((i) => i.pass);
  else pass = items.length > 0 && items.every((i) => i.pass);
  return { kind: 'group', logic: node.logic, text: describeGroup(node), pass, items };
}

/** Convenience: run a single strategy over candles with a fresh broker. */
export function runStrategyOnce({ strategy, candles, startingCash = 10_000, feePct = 0.1, slippagePct = 0.05 }) {
  // Deferred import to avoid a cycle at module load time.
  return import('./backtest.js').then(({ backtest }) => backtest({ strategy, candles, startingCash, feePct, slippagePct }));
}
