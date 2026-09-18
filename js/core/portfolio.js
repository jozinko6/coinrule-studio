/**
 * portfolio.js — cash / position / ledger accounting for the virtual account.
 *
 * Spot semantics (like Coinrule): long only, no borrowing, fees are charged on
 * the notional of every fill.
 */

import { roundCash, roundQty, roundPct, pctChange, clamp } from './money.js';

export class Position {
  constructor({ symbol, qty, entryPrice, time = 0, strategyId = null, ruleId = null }) {
    this.symbol = symbol;
    this.qty = qty;
    this.entryPrice = entryPrice;
    this.openedAt = time;
    // Who opened this position: kept so every closed trade stays attributable
    // even when the exit order is created internally (stop, end of backtest).
    this.strategyId = strategyId;
    this.ruleId = ruleId;
    this.realizedPnl = 0;
    this.feesPaid = 0;
    // Entry fees attributable to the currently OPEN quantity. Every sell
    // allocates a proportional slice so trade PnL is net of entry costs.
    this.entryFeeOpen = 0;
    this.stopLoss = null;      // absolute price
    this.takeProfit = null;    // absolute price
    this.trailingStopPct = 0;  // percent distance from the high-water mark
    this.highWater = entryPrice;
    this.lowWater = entryPrice;
    this.breakevenSet = false;
    this.leverage = 1;
    this.tags = [];
  }

  get notional() { return this.qty * this.entryPrice; }

  marketValue(price) { return this.qty * price; }

  unrealized(price) { return (price - this.entryPrice) * this.qty; }

  unrealizedPct(price) {
    if (!this.entryPrice) return 0;
    return pctChange(this.entryPrice, price);
  }

  /** Absolute stop price implied by the trailing stop, or null. */
  trailingStopPrice(price) {
    if (!this.trailingStopPct) return null;
    return this.highWater * (1 - this.trailingStopPct / 100);
  }

  updateWatermarks(price) {
    this.highWater = Math.max(this.highWater, price);
    this.lowWater = Math.min(this.lowWater, price);
  }

  toJSON() { return { ...this }; }
}

export class Portfolio {
  /**
   * @param {{cash?:number, feePct?:number, quote?:string, startingCash?:number}} opts
   */
  constructor({ cash = 10_000, feePct = 0.1, quote = 'USDT', startingCash = null } = {}) {
    this.quote = quote;
    this.cash = cash;
    this.startingCash = startingCash ?? cash;
    this.feePct = feePct;
    this.positions = new Map();
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.ledger = [];
    this.peakEquity = cash;
    this.maxDrawdownPct = 0;
    this.deposits = cash;
    this.withdrawals = 0;
  }

  /* ------------------------------------------------------------- queries */

  get openPositions() { return [...this.positions.values()]; }

  position(symbol) { return this.positions.get(symbol) ?? null; }

  hasPosition(symbol) { return this.positions.has(symbol); }

  /** Market value of all open positions. */
  positionsValue(prices = {}) {
    let v = 0;
    for (const p of this.positions.values()) {
      const px = typeof prices === 'number' ? prices : prices[p.symbol];
      if (Number.isFinite(px)) v += p.qty * px;
    }
    return v;
  }

  equity(prices = {}) {
    return this.cash + this.positionsValue(prices);
  }

  /** Total account return in percent vs. net deposits. */
  totalReturnPct(prices = {}) {
    const net = this.deposits - this.withdrawals;
    if (!net) return 0;
    return pctChange(net, this.equity(prices));
  }

  exposurePct(prices = {}) {
    const eq = this.equity(prices);
    return eq === 0 ? 0 : (this.positionsValue(prices) / eq) * 100;
  }

  drawdownPct(prices = {}) {
    const eq = this.equity(prices);
    const peak = Math.max(this.peakEquity, eq);
    return peak === 0 ? 0 : ((peak - eq) / peak) * 100;
  }

  markToMarket(prices = {}) {
    const eq = this.equity(prices);
    this.peakEquity = Math.max(this.peakEquity, eq);
    const dd = this.peakEquity === 0 ? 0 : ((this.peakEquity - eq) / this.peakEquity) * 100;
    this.maxDrawdownPct = Math.max(this.maxDrawdownPct, dd);
    return { equity: eq, drawdownPct: dd };
  }

  /* ------------------------------------------------------------ mutations */

  deposit(amount, note = 'deposit') {
    if (!(amount > 0)) return;
    this.cash = roundCash(this.cash + amount);
    this.deposits = roundCash(this.deposits + amount);
    this.record({ type: 'deposit', amount, note });
  }

  withdraw(amount, note = 'withdraw') {
    const amt = clamp(amount, 0, this.cash);
    if (!(amt > 0)) return;
    this.cash = roundCash(this.cash - amt);
    this.withdrawals = roundCash(this.withdrawals + amt);
    this.record({ type: 'withdraw', amount: amt, note });
  }

  /** Buy `qty` at `price`; charges `fee`. Returns the created/updated position. */
  applyBuy({ symbol, qty, price, fee, time = 0, strategyId = null, ruleId = null }) {
    const q = roundQty(qty);
    const cost = roundCash(q * price);
    this.cash = roundCash(this.cash - cost - fee);
    this.feesPaid = roundCash(this.feesPaid + fee);
    let pos = this.positions.get(symbol);
    if (pos) {
      const newQty = roundQty(pos.qty + q);
      pos.entryPrice = roundCash((pos.entryPrice * pos.qty + price * q) / newQty);
      pos.qty = newQty;
      pos.feesPaid = roundCash(pos.feesPaid + fee);
      pos.entryFeeOpen = roundCash((pos.entryFeeOpen ?? 0) + fee);
      pos.updateWatermarks(price);
      if (!pos.strategyId && strategyId) pos.strategyId = strategyId;
      if (!pos.ruleId && ruleId) pos.ruleId = ruleId;
    } else {
      pos = new Position({ symbol, qty: q, entryPrice: price, time, strategyId, ruleId });
      pos.feesPaid = roundCash(fee);
      pos.entryFeeOpen = roundCash(fee);
      this.positions.set(symbol, pos);
    }
    this.record({ type: 'buy', symbol, qty: q, price, fee, time, cash: this.cash });
    return pos;
  }

  /**
   * Sell `qty` at `price`; charges `fee` and allocates the proportional slice
   * of the open entry fees to this fill.
   * @returns {{realized:number, realizedGross:number, entryFeeAlloc:number, exitFee:number, closed:boolean, qty:number}}
   */
  applySell({ symbol, qty, price, fee, time = 0, reason = 'signal' }) {
    const pos = this.positions.get(symbol);
    if (!pos) return { realized: 0, realizedGross: 0, entryFeeAlloc: 0, exitFee: 0, closed: false, qty: 0 };
    const q = roundQty(Math.min(qty, pos.qty));
    if (!(q > 0)) return { realized: 0, realizedGross: 0, entryFeeAlloc: 0, exitFee: 0, closed: false, qty: 0 };

    const qtyBefore = pos.qty;
    const entryFeeAlloc = roundCash((pos.entryFeeOpen ?? 0) * (q / qtyBefore));
    const proceeds = roundCash(q * price);
    const realizedGross = roundCash((price - pos.entryPrice) * q);
    const realized = roundCash(realizedGross - entryFeeAlloc - fee);

    this.cash = roundCash(this.cash + proceeds - fee);
    this.feesPaid = roundCash(this.feesPaid + fee);
    this.realizedPnl = roundCash(this.realizedPnl + realized);
    pos.qty = roundQty(qtyBefore - q);
    pos.entryFeeOpen = roundCash(Math.max(0, (pos.entryFeeOpen ?? 0) - entryFeeAlloc));
    pos.realizedPnl = roundCash(pos.realizedPnl + realized);
    pos.feesPaid = roundCash(pos.feesPaid + fee);
    const closed = pos.qty <= 1e-12;
    if (closed) this.positions.delete(symbol);
    this.record({ type: 'sell', symbol, qty: q, price, fee, time, realized, reason, cash: this.cash });
    return { realized, realizedGross, entryFeeAlloc, exitFee: fee, closed, qty: q };
  }

  record(entry) {
    this.ledger.push({ ...entry, at: entry.time ?? entry.at ?? 0 });
  }

  snapshot(prices = {}) {
    return {
      cash: roundCash(this.cash),
      equity: roundCash(this.equity(prices)),
      realizedPnl: roundCash(this.realizedPnl),
      feesPaid: roundCash(this.feesPaid),
      exposurePct: roundPct(this.exposurePct(prices)),
      drawdownPct: roundPct(this.drawdownPct(prices)),
      openPositions: this.openPositions.map((p) => ({
        symbol: p.symbol,
        qty: roundQty(p.qty),
        entryPrice: p.entryPrice,
        marketValue: roundCash(p.marketValue(typeof prices === 'number' ? prices : prices[p.symbol] ?? p.entryPrice)),
        unrealizedPct: roundPct(p.unrealizedPct(typeof prices === 'number' ? prices : prices[p.symbol] ?? p.entryPrice)),
      })),
    };
  }

  toJSON() {
    return {
      quote: this.quote,
      cash: this.cash,
      startingCash: this.startingCash,
      feePct: this.feePct,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      peakEquity: this.peakEquity,
      maxDrawdownPct: this.maxDrawdownPct,
      deposits: this.deposits,
      withdrawals: this.withdrawals,
      positions: this.openPositions.map((p) => p.toJSON()),
      ledger: this.ledger,
    };
  }

  static fromJSON(data) {
    const p = new Portfolio({
      cash: data.cash,
      feePct: data.feePct,
      quote: data.quote,
      startingCash: data.startingCash,
    });
    p.realizedPnl = data.realizedPnl ?? 0;
    p.feesPaid = data.feesPaid ?? 0;
    p.peakEquity = data.peakEquity ?? p.cash;
    p.maxDrawdownPct = data.maxDrawdownPct ?? 0;
    p.deposits = data.deposits ?? p.cash;
    p.withdrawals = data.withdrawals ?? 0;
    p.ledger = data.ledger ?? [];
    for (const raw of data.positions ?? []) {
      const pos = new Position({ symbol: raw.symbol, qty: raw.qty, entryPrice: raw.entryPrice, time: raw.openedAt ?? 0 });
      Object.assign(pos, raw);
      p.positions.set(pos.symbol, pos);
    }
    return p;
  }
}
