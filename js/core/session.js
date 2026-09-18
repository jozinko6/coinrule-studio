/**
 * session.js — the live virtual-trading session.
 *
 * Wires a PaperBroker (live mode: market orders fill immediately) to a
 * StrategyRuntime, aggregates incoming ticks into timeframe candles and keeps
 * an equity curve. DOM-free, so it is unit tested under `node --test`.
 */

import { PaperBroker } from './paper.js';
import { Portfolio } from './portfolio.js';
import { StrategyRuntime } from './engine.js';
import { TIMEFRAME_MS } from './rules.js';
import { roundCash, roundQty } from './money.js';

export class LivePaperEngine {
  constructor(opts = {}) {
    this.symbol = opts.symbol ?? 'BTCUSDT';
    this.timeframe = opts.timeframe ?? '1h';
    this.tfMs = TIMEFRAME_MS[this.timeframe] ?? 3_600_000;
    this.startingCash = opts.startingCash ?? 10_000;
    this.portfolio = opts.portfolio ?? new Portfolio({
      cash: this.startingCash,
      feePct: opts.feePct ?? 0.1,
      quote: 'USDT',
      startingCash: this.startingCash,
    });
    this.broker = new PaperBroker({
      symbol: this.symbol,
      startingCash: this.startingCash,
      takerFeePct: opts.feePct ?? 0.1,
      makerFeePct: opts.feePct ?? 0.1,
      slippagePct: opts.slippagePct ?? 0.05,
      participationRate: opts.participationRate ?? 0.25,
      mode: 'live',
      portfolio: this.portfolio,
    });
    this.runtime = new StrategyRuntime({
      strategies: opts.strategies ?? [],
      broker: this.broker,
      options: { timeframe: this.timeframe, ...(opts.options ?? {}) },
    });
    this.candles = [];
    this.current = null;
    this.equityCurve = [];
    this.startedAt = 0;
    this.tickCount = 0;
    this.lastTick = null;
    this.notes = [];
    this.historyLoaded = false;
  }

  setStrategies(strategies) {
    this.runtime.strategies = strategies;
    if (this.candles.length) this.runtime.prepare(this.candles);
    return this;
  }

  /** Seed the engine with historical candles so indicators are warm. */
  loadHistory(candles) {
    this.candles = candles.map((c) => ({ ...c }));
    this.runtime.prepare(this.candles);
    this.historyLoaded = true;
    const last = this.candles[this.candles.length - 1];
    if (last) {
      this.broker.setPrice(last.close, last.time);
      this.pushEquity(last.time);
    }
    // History only warms up the indicators — no orders are simulated on it.
    this.current = null;
    return this;
  }

  /** Feed one tick. Returns the completed candle when a new bar started. */
  onTick(tick) {
    if (!tick || !Number.isFinite(tick.price)) return null;
    this.tickCount += 1;
    this.lastTick = tick;
    if (!this.startedAt) this.startedAt = tick.time ?? 0;

    const time = Number.isFinite(tick.time) ? tick.time : this.broker.lastTime + 1000;
    const bucket = Math.floor(time / this.tfMs) * this.tfMs;
    let completed = null;

    if (!this.current || this.current.time !== bucket) {
      completed = this.current && this.candles.length ? this.candles[this.candles.length - 1] : null;
      if (this.current) {
        // The bar is complete: refresh the indicator series (they were computed
        // while the bar was still forming) and then evaluate the rules.
        this.broker.onCandle(this.current);
        this.runtime.prepare(this.candles);
        this.runtime.onBar(this.candles, this.candles.length - 1);
        this.pushEquity(this.current.time);
      }
      this.current = {
        time: bucket,
        open: tick.open ?? tick.price,
        high: tick.high ?? tick.price,
        low: tick.low ?? tick.price,
        close: tick.price,
        volume: tick.volume ?? 0,
      };
      this.candles.push(this.current);
    } else {
      this.current.high = Math.max(this.current.high, tick.high ?? tick.price);
      this.current.low = Math.min(this.current.low, tick.low ?? tick.price);
      this.current.close = tick.price;
      this.current.volume = roundCash(this.current.volume + (tick.volume ?? 0));
    }

    this.broker.setPrice(tick.price, time);
    this.portfolio.markToMarket(tick.price);
    return completed;
  }

  /** Force-close the current bar (used when stopping the session). */
  flush() {
    if (!this.current) return null;
    this.broker.onCandle(this.current);
    this.runtime.prepare(this.candles);
    this.runtime.onBar(this.candles, this.candles.length - 1);
    this.pushEquity(this.current.time);
    return this.current;
  }

  pushEquity(time) {
    const equity = roundCash(this.portfolio.equity(this.broker.lastPrice));
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (last && last.time === time) { last.equity = equity; return; }
    this.equityCurve.push({ time, equity, price: this.broker.lastPrice });
    if (this.equityCurve.length > 5000) this.equityCurve.splice(0, this.equityCurve.length - 5000);
  }

  /** Close every open position at the current price. */
  closeAll(reason = 'manual') {
    const closed = [];
    for (const pos of [...this.portfolio.openPositions]) {
      this.broker.cancelAll(pos.symbol);
      const order = this.broker.submit({
        symbol: pos.symbol,
        side: 'sell',
        type: 'market',
        qty: pos.qty,
        reduceOnly: true,
        reason,
        createdAt: this.broker.lastTime,
      });
      closed.push(order);
    }
    if (closed.length) this.pushEquity(this.broker.lastTime);
    return closed;
  }

  /** Cancel every working order without touching positions. */
  cancelAll() {
    return this.broker.cancelAll(this.symbol);
  }

  snapshot() {
    const price = this.broker.lastPrice;
    const equity = roundCash(this.portfolio.equity(price));
    const startEquity = this.equityCurve.length ? this.equityCurve[0].equity : this.startingCash;
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      running: true,
      price,
      cash: roundCash(this.portfolio.cash),
      equity,
      startEquity,
      returnPct: startEquity ? roundCash(((equity - startEquity) / startEquity) * 100) : 0,
      realizedPnl: roundCash(this.portfolio.realizedPnl),
      feesPaid: roundCash(this.portfolio.feesPaid),
      exposurePct: roundCash(this.portfolio.exposurePct(price)),
      drawdownPct: roundCash(this.portfolio.drawdownPct(price)),
      positions: this.portfolio.openPositions.map((p) => ({
        symbol: p.symbol,
        qty: roundQty(p.qty),
        entryPrice: p.entryPrice,
        value: roundCash(p.qty * price),
        pnl: roundCash(p.unrealized(price)),
        pnlPct: roundCash(p.unrealizedPct(price)),
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        trailingPct: p.trailingStopPct,
        openedAt: p.openedAt,
      })),
      openOrders: this.broker.openOrders.map((o) => ({
        id: o.id, side: o.side, type: o.type, qty: o.qty, filledQty: o.filledQty,
        price: o.price, stopPrice: o.stopPrice, status: o.status, reason: o.reason,
      })),
      trades: this.broker.trades.length,
      ticks: this.tickCount,
      bars: this.candles.length,
      lastTime: this.broker.lastTime,
      signals: this.runtime.signals.slice(-40).reverse(),
      events: this.broker.events.slice(-40).reverse(),
    };
  }

  toJSON() {
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      startingCash: this.startingCash,
      startedAt: this.startedAt,
      ticks: this.tickCount,
      candles: this.candles.slice(-600),
      equityCurve: this.equityCurve.slice(-2000),
      trades: this.broker.trades.slice(-500),
      portfolio: this.portfolio.toJSON(),
      signals: this.runtime.signals.slice(-200),
      notes: this.notes,
    };
  }
}
