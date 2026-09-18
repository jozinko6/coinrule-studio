/**
 * paper.js — the virtual (paper) broker.
 *
 * Models a real exchange closely enough to be useful, without ever touching a
 * real account: order types (market / limit / stop-market / stop-limit /
 * take-profit / trailing-stop), maker/taker fees, slippage, partial fills
 * limited by a SHARED participation budget, IOC/FOK/GTC time-in-force and OCO
 * groups.
 *
 * Two execution modes:
 *   - `backtest`: market orders are queued and filled at the NEXT bar's open
 *     (no look-ahead bias).
 *   - `live`: market orders fill immediately at the last traded price
 *     (used by the real-time virtual trading screen).
 *
 * Bar sequence (backtest):
 *   1. queued market orders fill at the open
 *   2. the entry-fill hook arms protective orders at the REAL fill price
 *   3. the intrabar range is processed according to `executionModel`
 *   4. the bar closes and equity is marked
 *
 * Execution models (Phase 1.6):
 *   - `conservative` (default): no intrabar path is assumed. Protective levels
 *     seen anywhere in the bar may trigger and the stop wins ties; the trailing
 *     stop only ever uses the PREVIOUS bar's high-water mark.
 *   - `ohlc`: path O -> H -> L -> C. The high updates the trailing level before
 *     the low is checked.
 *   - `olhc`: path O -> L -> H -> C. The low is checked against the pre-bar
 *     trailing level; the high only updates it afterwards.
 */

import { Portfolio } from './portfolio.js';
import { roundCash, roundQty, roundPct, pctChange } from './money.js';
import { positionSize } from './risk.js';

export const ORDER_STATUS = {
  NEW: 'new',
  PARTIAL: 'partially_filled',
  FILLED: 'filled',
  CANCELED: 'canceled',
  REJECTED: 'rejected',
  PENDING_OPEN: 'pending_open',
};

export const EXECUTION_MODELS = ['conservative', 'ohlc', 'olhc'];

let orderSeq = 0;

export function createOrder(patch = {}) {
  orderSeq += 1;
  // Defaults are applied AFTER the spread so that an explicitly `undefined`
  // field in the patch can never wipe out a generated value.
  return {
    ...patch,
    id: patch.id ?? `ord_${Date.now().toString(36)}_${orderSeq.toString(36)}`,
    symbol: patch.symbol,
    side: patch.side ?? 'buy',
    type: patch.type ?? 'market',
    qty: patch.qty ?? 0,
    price: patch.price ?? null,
    stopPrice: patch.stopPrice ?? null,
    trailingPct: patch.trailingPct ?? 0,
    status: patch.status ?? ORDER_STATUS.NEW,
    filledQty: patch.filledQty ?? 0,
    avgFillPrice: patch.avgFillPrice ?? null,
    fee: patch.fee ?? 0,
    timeInForce: patch.timeInForce ?? 'GTC',
    participationRate: patch.participationRate ?? 0.25,
    reduceOnly: patch.reduceOnly ?? false,
    ocoGroup: patch.ocoGroup ?? null,
    createdAt: patch.createdAt ?? 0,
    updatedAt: patch.updatedAt ?? 0,
    reason: patch.reason ?? 'signal',
    ruleId: patch.ruleId ?? null,
    strategyId: patch.strategyId ?? null,
    parentId: patch.parentId ?? null,
  };
}

export class PaperBroker {
  constructor(opts = {}) {
    this.symbol = opts.symbol ?? 'BTCUSDT';
    this.quote = opts.quote ?? 'USDT';
    this.mode = opts.mode ?? 'backtest';
    this.takerFeePct = opts.takerFeePct ?? 0.1;
    this.makerFeePct = opts.makerFeePct ?? 0.1;
    this.slippagePct = opts.slippagePct ?? 0.05;
    this.participationRate = opts.participationRate ?? 0.25;
    this.executionModel = EXECUTION_MODELS.includes(opts.executionModel) ? opts.executionModel : 'conservative';
    this.portfolio = opts.portfolio ?? new Portfolio({
      cash: opts.startingCash ?? 10_000,
      feePct: opts.takerFeePct ?? 0.1,
      quote: this.quote,
      startingCash: opts.startingCash ?? 10_000,
    });
    this.orders = new Map();
    this.trades = [];
    this.lastPrice = opts.lastPrice ?? 0;
    this.lastTime = 0;
    this.lastVolume = 0;
    this.events = [];
    this.rejections = [];
    // Set by the strategy runtime: called right after a buy fill so protective
    // orders (SL/TP/trailing) can be armed at the actual average fill price.
    this.onEntryFilled = opts.onEntryFilled ?? null;
    // Shared per-bar liquidity budget (base units) — every fill in the bar
    // consumes from it. Infinity when there is no volume cap.
    this.barLiquidityRemaining = Infinity;
    // Optional deterministic id generator (used by the backtester so that two
    // identical runs produce byte-identical output).
    this.idFactory = opts.idFactory ?? null;
    this.idSeq = 0;
  }

  nextOrderId() {
    if (!this.idFactory) return undefined;
    this.idSeq += 1;
    return this.idFactory(this.idSeq);
  }

  /* ------------------------------------------------------------- accessors */

  get openOrders() {
    return [...this.orders.values()].filter((o) => [ORDER_STATUS.NEW, ORDER_STATUS.PARTIAL, ORDER_STATUS.PENDING_OPEN].includes(o.status));
  }

  position(symbol = this.symbol) { return this.portfolio.position(symbol); }

  equity() { return this.portfolio.equity(this.lastPrice); }

  cash() { return this.portfolio.cash; }

  setExecutionModel(model) {
    if (!EXECUTION_MODELS.includes(model)) {
      throw new Error(`Neznámy execution model: ${model} (povolené: ${EXECUTION_MODELS.join(', ')})`);
    }
    this.executionModel = model;
    return this;
  }

  log(type, message, extra = {}) {
    this.events.push({ type, message, time: this.lastTime, price: this.lastPrice, ...extra });
  }

  /* ---------------------------------------------------------------- fills */

  /** Apply slippage for the given side. */
  slippagePrice(price, side, { isMaker = false } = {}) {
    if (isMaker) return price;
    const slip = (this.slippagePct / 100) * price;
    return side === 'buy' ? price + slip : Math.max(price - slip, 1e-12);
  }

  feeFor(notional, { isMaker = false } = {}) {
    const pct = isMaker ? this.makerFeePct : this.takerFeePct;
    return roundCash((notional * pct) / 100);
  }

  /** Largest quantity the current cash can pay for, fee included. */
  affordableQty(price, { isMaker = false } = {}) {
    if (!(price > 0)) return 0;
    const feeRate = (isMaker ? this.makerFeePct : this.takerFeePct) / 100;
    let qty = roundQty(this.portfolio.cash / (price * (1 + feeRate)));
    for (let i = 0; i < 6 && qty > 0; i += 1) {
      const notional = roundCash(qty * price);
      const fee = this.feeFor(notional, { isMaker });
      if (this.portfolio.cash + 1e-9 >= notional + fee) break;
      const over = roundCash(notional + fee - this.portfolio.cash);
      qty = roundQty(Math.max(0, qty - over / price - 1e-8));
    }
    return qty > 0 ? qty : 0;
  }

  /**
   * How much of an order can fill against a bar with `volume`.
   * The per-order cap is `volume * participationRate`; all executions in the
   * same bar additionally share `barLiquidityRemaining`.
   */
  fillCapacity(volume, order) {
    const rate = order.participationRate ?? this.participationRate;
    let cap = Infinity;
    if (Number.isFinite(volume) && volume > 0 && rate > 0) cap = volume * rate;
    if (Number.isFinite(this.barLiquidityRemaining)) cap = Math.min(cap, this.barLiquidityRemaining);
    return cap;
  }

  consumeLiquidity(qty) {
    if (Number.isFinite(this.barLiquidityRemaining)) {
      this.barLiquidityRemaining = Math.max(0, this.barLiquidityRemaining - qty);
    }
  }

  /** Execute a fill at `price`, honouring the portfolio ledger. */
  fillOrder(order, price, { volume = Infinity, time = 0, isMaker = false, reason = null } = {}) {
    // An order can be cancelled by a sibling OCO leg (or by a guard) in the
    // middle of a bar loop — never fill a dead order.
    if ([ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.REJECTED].includes(order.status)) return null;
    const remaining = roundQty(order.qty - order.filledQty);
    if (!(remaining > 0)) return null;
    const cap = this.fillCapacity(volume, order);
    let qty = remaining;
    if (Number.isFinite(cap)) qty = Math.min(qty, roundQty(cap));
    if (order.reduceOnly) {
      const pos = this.portfolio.position(order.symbol);
      const maxQty = pos ? pos.qty : 0;
      qty = Math.min(qty, maxQty);
    }
    if (!(qty > 0)) return null;

    const execPrice = this.slippagePrice(price, order.side, { isMaker });
    if (!(execPrice > 0)) return null;
    let notional = roundCash(qty * execPrice);
    let fee = this.feeFor(notional, { isMaker });

    if (order.side === 'buy' && this.portfolio.cash < notional + fee) {
      // Not enough cash at the actual fill price: shrink to what is affordable
      // and RECOMPUTE notional + fee from the final quantity.
      qty = Math.min(qty, this.affordableQty(execPrice, { isMaker }));
      if (!(qty > 0)) {
        order.status = ORDER_STATUS.REJECTED;
        this.rejections.push({ orderId: order.id, reason: 'insufficient_funds', time });
        return null;
      }
      notional = roundCash(qty * execPrice);
      fee = this.feeFor(notional, { isMaker });
      if (this.portfolio.cash < notional + fee - 1e-9) {
        order.status = ORDER_STATUS.REJECTED;
        this.rejections.push({ orderId: order.id, reason: 'insufficient_funds', time });
        return null;
      }
    }

    const prePos = order.side === 'sell' ? this.portfolio.position(order.symbol) : null;
    let sellResult = null;

    if (order.side === 'buy') {
      this.portfolio.applyBuy({
        symbol: order.symbol, qty, price: execPrice, fee, time,
        strategyId: order.strategyId ?? null, ruleId: order.ruleId ?? null,
      });
    } else {
      sellResult = this.portfolio.applySell({ symbol: order.symbol, qty, price: execPrice, fee, time, reason: reason ?? order.reason });
      if (!sellResult.qty) {
        order.status = ORDER_STATUS.REJECTED;
        this.rejections.push({ orderId: order.id, reason: 'no_position', time });
        return null;
      }
      this.recordTrade(order, execPrice, sellResult, time, reason ?? order.reason, prePos);
    }

    this.consumeLiquidity(qty);
    const filledNotional = roundCash(qty * execPrice);
    order.avgFillPrice = order.avgFillPrice
      ? roundCash((order.avgFillPrice * order.filledQty + filledNotional) / (order.filledQty + qty))
      : execPrice;
    order.filledQty = roundQty(order.filledQty + qty);
    order.fee = roundCash(order.fee + fee);
    order.updatedAt = time;
    order.status = order.filledQty + 1e-12 >= order.qty ? ORDER_STATUS.FILLED : ORDER_STATUS.PARTIAL;

    this.log(order.side === 'buy' ? 'buy' : 'sell', `${order.side.toUpperCase()} ${roundQty(qty)} ${order.symbol} @ ${execPrice}`, {
      orderId: order.id, fee, reason: reason ?? order.reason,
    });

    if (order.side === 'sell') this.syncOco(order, qty);
    if (order.status === ORDER_STATUS.FILLED) this.resolveOco(order);
    if (order.side === 'buy' && this.onEntryFilled) {
      try {
        this.onEntryFilled(order, { qty, price: execPrice, time, fee });
      } catch (err) {
        this.log('warn', `Entry-fill hook zlyhal: ${err.message}`, { orderId: order.id });
      }
    }
    return { qty, price: execPrice, fee };
  }

  recordTrade(order, exitPrice, fill, time, reason, prePos = null) {
    // The position may already be gone (fully closed) — use the snapshot taken
    // before the sell so the entry price is always correct.
    const identity = prePos ?? this.portfolio.position(order.symbol);
    const entryPrice = identity?.entryPrice ?? exitPrice;
    const openedAt = identity?.openedAt ?? order.createdAt ?? time;
    const qty = roundQty(fill.qty);
    const grossPnl = roundCash((exitPrice - entryPrice) * qty);
    const entryFee = roundCash(fill.entryFeeAlloc ?? 0);
    const exitFee = roundCash(fill.exitFee ?? 0);
    const totalFees = roundCash(entryFee + exitFee);
    const netPnl = roundCash(grossPnl - totalFees);
    const costBasis = roundCash(entryPrice * qty);
    const netPnlPct = costBasis > 0 ? roundPct((netPnl / costBasis) * 100) : 0;
    this.trades.push({
      id: `trd_${this.trades.length + 1}`,
      symbol: order.symbol,
      side: 'long',
      qty,
      entryPrice,
      exitPrice,
      grossPnl,
      entryFee,
      exitFee,
      totalFees,
      netPnl,
      netPnlPct,
      // `pnl`/`pnlPct`/`fees` stay the net, fee-inclusive values so every
      // existing analytics path keeps using the true economic result.
      pnl: netPnl,
      pnlPct: netPnlPct,
      fees: totalFees,
      openedAt,
      closedAt: time,
      durationMs: time - openedAt,
      reason,
      ruleId: identity?.ruleId ?? order.ruleId ?? null,
      strategyId: identity?.strategyId ?? order.strategyId ?? null,
      orderId: order.id,
    });
  }

  /**
   * Keep OCO siblings quantity-synchronised: a partial fill on one leg reduces
   * the remaining quantity of the others, and a fully consumed sibling is
   * cancelled. Protective legs can therefore never sell more than the position.
   */
  syncOco(order, filledQty) {
    if (!order.ocoGroup) return;
    for (const other of this.orders.values()) {
      if (other.id === order.id || other.ocoGroup !== order.ocoGroup) continue;
      if (![ORDER_STATUS.NEW, ORDER_STATUS.PARTIAL, ORDER_STATUS.PENDING_OPEN].includes(other.status)) continue;
      const remaining = roundQty(other.qty - other.filledQty - filledQty);
      if (!(remaining > 1e-12)) {
        other.status = ORDER_STATUS.CANCELED;
        other.updatedAt = this.lastTime;
        this.log('cancel', `OCO: zrušený ${other.type} #${other.id} (brat vyplnil celú pozíciu)`, { orderId: other.id });
      } else {
        other.qty = roundQty(other.filledQty + remaining);
      }
    }
  }

  resolveOco(order) {
    if (!order.ocoGroup) return;
    for (const other of this.orders.values()) {
      if (other.id !== order.id && other.ocoGroup === order.ocoGroup && [ORDER_STATUS.NEW, ORDER_STATUS.PARTIAL, ORDER_STATUS.PENDING_OPEN].includes(other.status)) {
        other.status = ORDER_STATUS.CANCELED;
        other.updatedAt = this.lastTime;
        this.log('cancel', `OCO: zrušený ${other.side} ${other.type} #${other.id}`, { orderId: other.id });
      }
    }
  }

  /* ---------------------------------------------------------------- orders */

  submit(orderPatch) {
    const order = createOrder({
      ...orderPatch,
      id: orderPatch.id ?? this.nextOrderId(),
      symbol: orderPatch.symbol ?? this.symbol,
      // inherit the broker's participation rate unless the order overrides it
      participationRate: orderPatch.participationRate ?? this.participationRate,
    });
    if (!(order.qty > 0)) {
      order.status = ORDER_STATUS.REJECTED;
      this.rejections.push({ orderId: order.id, reason: 'zero_qty', time: this.lastTime });
      return order;
    }
    const refPrice = order.price ?? this.lastPrice ?? 0;
    if (order.side === 'buy' && refPrice > 0 && order.qty * refPrice > this.portfolio.cash * 1.000001) {
      const affordable = this.affordableQty(refPrice, { isMaker: order.type === 'limit' });
      if (!(affordable > 0)) {
        order.status = ORDER_STATUS.REJECTED;
        this.rejections.push({ orderId: order.id, reason: 'insufficient_funds', time: this.lastTime });
        return order;
      }
      order.qty = affordable;
    }
    if (['stop_market', 'stop_limit', 'take_profit', 'trailing_stop'].includes(order.type) && !Number.isFinite(order.stopPrice)) {
      order.status = ORDER_STATUS.REJECTED;
      this.rejections.push({ orderId: order.id, reason: 'missing_stop_price', time: this.lastTime });
      return order;
    }
    if (['limit', 'stop_limit'].includes(order.type) && !Number.isFinite(order.price)) {
      // Without a limit price the order could never fill — reject up front
      // instead of leaving a permanently resting order behind.
      order.status = ORDER_STATUS.REJECTED;
      this.rejections.push({ orderId: order.id, reason: 'missing_limit_price', time: this.lastTime });
      return order;
    }
    this.orders.set(order.id, order);
    order.createdAt = order.createdAt || this.lastTime;
    if (order.type === 'market') {
      if (this.mode === 'live') {
        this.fillOrder(order, this.lastPrice, { volume: Infinity, time: this.lastTime, reason: order.reason });
      } else {
        order.status = ORDER_STATUS.PENDING_OPEN;
      }
    }
    return order;
  }

  cancel(orderId) {
    const o = this.orders.get(orderId);
    if (!o) return false;
    if ([ORDER_STATUS.FILLED, ORDER_STATUS.CANCELED, ORDER_STATUS.REJECTED].includes(o.status)) return false;
    o.status = ORDER_STATUS.CANCELED;
    o.updatedAt = this.lastTime;
    this.log('cancel', `Zrušený príkaz ${o.id}`, { orderId: o.id });
    return true;
  }

  cancelAll(symbol = null) {
    let n = 0;
    for (const o of this.openOrders) {
      if (symbol && o.symbol !== symbol) continue;
      this.cancel(o.id);
      n += 1;
    }
    return n;
  }

  /* ------------------------------------------------------------ market data */

  setPrice(price, time = null) {
    this.lastPrice = price;
    if (time !== null) this.lastTime = time;
  }

  /** Fill price for a stop: gap-through at the open, otherwise the level. */
  stopFillPrice(trigger, side, { levelPreExisted = true, open }) {
    if (side === 'sell') {
      if (levelPreExisted && open <= trigger) return open;
      return trigger;
    }
    if (levelPreExisted && open >= trigger) return open;
    return trigger;
  }

  /** Fill price for a resting limit: you never do worse than the limit. */
  limitFillPrice(trigger, side, open) {
    return side === 'sell'
      ? (open >= trigger ? open : trigger)
      : (open <= trigger ? open : trigger);
  }

  /** Process protective orders for the current bar according to the model. */
  processProtectives({ open, high, low, time, levelPreExisted }) {
    const protective = this.openOrders
      .filter((o) => ['stop_market', 'trailing_stop', 'take_profit'].includes(o.type));
    const stops = protective.filter((o) => o.type !== 'take_profit');
    const targets = protective.filter((o) => o.type === 'take_profit');
    const ordered = this.executionModel === 'ohlc' ? [...targets, ...stops] : [...stops, ...targets];

    for (const o of ordered) {
      const pos = this.portfolio.position(o.symbol);
      if (!pos && o.side === 'sell') {
        o.status = ORDER_STATUS.CANCELED;
        o.updatedAt = time;
        continue;
      }
      let trigger = null;
      if (o.type === 'trailing_stop') {
        if (!pos?.trailingStopPct) continue;
        trigger = pos.trailingStopPrice(pos.highWater);
        o.stopPrice = trigger;
      } else {
        trigger = o.stopPrice;
      }
      if (!Number.isFinite(trigger)) continue;
      // Direction matters: a take-profit sell sits ABOVE the market and needs the
      // high to reach it; a stop/trailing sell sits BELOW and needs the low.
      const isTarget = o.type === 'take_profit';
      const touched = isTarget
        ? (o.side === 'sell' ? high >= trigger : low <= trigger)
        : (o.side === 'sell' ? low <= trigger : high >= trigger);
      if (!touched) continue;
      const fillPrice = isTarget
        ? this.limitFillPrice(trigger, o.side, open)
        : this.stopFillPrice(trigger, o.side, { levelPreExisted, open });
      this.fillOrder(o, fillPrice, {
        volume: this.lastVolume,
        time,
        reason: o.reason,
      });
    }
  }

  /**
   * Feed one candle. Handles, in order:
   *   1. queued market orders -> fill at the bar open (arms protective orders)
   *   2. protective exits according to the intrabar execution model
   *   3. resting limit orders
   *   4. stop-entry orders
   */
  onCandle(candle) {
    const { open, high, low, close, volume, time } = candle;
    this.lastVolume = volume ?? 0;
    this.lastTime = time ?? this.lastTime;
    const before = this.lastPrice;
    this.lastPrice = open;

    // Fresh shared liquidity budget for this bar.
    const rate = this.participationRate;
    this.barLiquidityRemaining = Number.isFinite(volume) && volume > 0 && rate > 0 ? volume * rate : Infinity;

    // 1. market orders queued from the previous bar (keep filling the remainder)
    for (const o of this.openOrders) {
      if (o.type !== 'market') continue;
      if (o.status !== ORDER_STATUS.PENDING_OPEN && o.status !== ORDER_STATUS.PARTIAL) continue;
      if (o.reduceOnly && o.side === 'sell' && !this.portfolio.position(o.symbol)) continue;
      this.fillOrder(o, open, { volume, time, reason: o.reason });
    }

    // reduce-only orders whose position is gone can never fill — cancel them
    for (const o of this.openOrders) {
      if (!o.reduceOnly) continue;
      if (o.side !== 'sell') continue;
      if (this.portfolio.position(o.symbol)) continue;
      o.status = ORDER_STATUS.CANCELED;
      o.updatedAt = time;
      this.log('cancel', `Zrušený reduce-only príkaz #${o.id} (pozícia neexistuje)`, { orderId: o.id });
    }


    // 2. protective exits; the model decides whether the high may be used
    //    before the low for trailing levels.
    const levelPreExisted = this.executionModel !== 'ohlc';
    if (this.executionModel === 'ohlc') {
      for (const pos of this.portfolio.openPositions) pos.updateWatermarks(high);
    }
    this.processProtectives({ open, high, low, time, levelPreExisted });
    for (const pos of this.portfolio.openPositions) {
      pos.updateWatermarks(high);
      pos.updateWatermarks(low);
    }
    // Refresh trailing levels for the NEXT bar from the updated watermarks.
    for (const o of this.openOrders) {
      if (o.type !== 'trailing_stop') continue;
      const pos = this.portfolio.position(o.symbol);
      if (pos?.trailingStopPct) o.stopPrice = pos.trailingStopPrice(pos.highWater);
    }

    // 3. resting limit orders (a stop-limit only rests once its stop triggered)
    for (const o of this.openOrders) {
      if (o.type !== 'limit') continue;
      if (!Number.isFinite(o.price)) continue;
      const touched = o.side === 'buy' ? low <= o.price : high >= o.price;
      if (!touched) continue;
      const remaining = roundQty(o.qty - o.filledQty);
      if (o.timeInForce === 'FOK' && this.fillCapacity(volume, o) < remaining) {
        o.status = ORDER_STATUS.CANCELED;
        o.updatedAt = time;
        continue;
      }
      this.fillOrder(o, this.limitFillPrice(o.price, o.side, open), { volume, time, isMaker: true, reason: o.reason });
      if (o.timeInForce === 'IOC' && o.status === ORDER_STATUS.PARTIAL) o.status = ORDER_STATUS.CANCELED;
    }

    // 4. stop-entry orders: stop-market fills immediately, stop-limit turns into
    //    a resting limit order that is only fillable from the NEXT bar on.
    for (const o of this.openOrders) {
      if (o.type !== 'stop_market' && o.type !== 'stop_limit') continue;
      if (o.type === 'stop_market' && o.reduceOnly) continue; // protective exits handled above
      if (!Number.isFinite(o.stopPrice)) continue;
      const hit = o.side === 'buy' ? high >= o.stopPrice : low <= o.stopPrice;
      if (!hit) continue;
      if (o.type === 'stop_market') {
        this.fillOrder(o, this.stopFillPrice(o.stopPrice, o.side, { levelPreExisted: true, open }), { volume, time, reason: o.reason });
      } else {
        o.type = 'limit';
        o.triggeredAt = time;
        o.updatedAt = time;
        this.log('trigger', `Stop-limit #${o.id} aktivovaný na cene ${o.price}`, { orderId: o.id });
      }
    }

    // 5. close the bar
    this.lastPrice = close;
    this.portfolio.markToMarket(this.lastPrice);
    if (before !== close) {
      this.events.push({ type: 'price', message: `${this.symbol} ${close}`, time, price: close });
    }
    return this.portfolio.snapshot(this.lastPrice);
  }

  /* --------------------------------------------------------- sizing & acts */

  /**
   * Resolve an order quantity from a sizing instruction.
   * @param {{sizeMode:string, value:number}} sizing
   * @param {{price:number, atr?:number, stopPct?:number, symbol?:string}} ctx
   */
  sizeOrder(sizing, ctx) {
    const { price } = ctx;
    if (!(price > 0)) return 0;
    return positionSize({
      mode: sizing.sizeMode ?? 'percent_cash',
      value: sizing.value,
      price,
      cash: this.portfolio.cash,
      equity: this.portfolio.equity(this.lastPrice || price),
      stopPct: ctx.stopPct ?? 2,
      atr: ctx.atr ?? 0,
      atrMult: ctx.atrMult ?? 2,
      feePct: this.takerFeePct,
    });
  }

  /** Execute a strategy action object. Returns a list of resulting orders. */
  executeAction(action, ctx = {}) {
    const symbol = ctx.symbol ?? this.symbol;
    const price = ctx.price ?? this.lastPrice;
    const time = ctx.time ?? this.lastTime;
    const out = [];
    const base = { symbol, createdAt: time, ruleId: ctx.ruleId ?? null, strategyId: ctx.strategyId ?? null, reason: ctx.reason ?? 'signal' };

    switch (action.type) {
      case 'buy':
      case 'dca': {
        const qty = this.sizeOrder(action, { price, atr: ctx.atr, stopPct: ctx.stopPct, symbol });
        if (qty > 0) out.push(this.submit({ ...base, side: 'buy', type: 'market', qty }));
        else this.log('warn', 'Nákup preskočený — nulová veľkosť príkazu', { action });
        break;
      }
      case 'sell': {
        const pos = this.portfolio.position(symbol);
        if (!pos) break;
        let qty = pos.qty;
        const mode = action.sizeMode ?? 'all';
        const value = Number(action.value ?? 100);
        if (mode === 'percent_position' || mode === 'percent_cash' || mode === 'percent_equity') qty = (pos.qty * value) / 100;
        else if (mode === 'fixed_base') qty = Math.min(value, pos.qty);
        else if (mode === 'fixed_quote') qty = Math.min(value / price, pos.qty);
        if (qty > 0) out.push(this.submit({ ...base, side: 'sell', type: 'market', qty: roundQty(qty), reduceOnly: true }));
        break;
      }
      case 'close_position': {
        const pos = this.portfolio.position(symbol);
        if (pos) out.push(this.submit({ ...base, side: 'sell', type: 'market', qty: pos.qty, reduceOnly: true, reason: ctx.reason ?? 'close' }));
        break;
      }
      case 'take_profit': {
        const pos = this.portfolio.position(symbol);
        if (!pos) break;
        pos.takeProfit = roundCash(price * (1 + action.value / 100));
        out.push(this.submit({ ...base, side: 'sell', type: 'take_profit', qty: pos.qty, stopPrice: pos.takeProfit, reduceOnly: true, reason: 'take_profit' }));
        break;
      }
      case 'stop_loss': {
        const pos = this.portfolio.position(symbol);
        if (!pos) break;
        pos.stopLoss = roundCash(price * (1 - action.value / 100));
        out.push(this.submit({ ...base, side: 'sell', type: 'stop_market', qty: pos.qty, stopPrice: pos.stopLoss, reduceOnly: true, reason: 'stop_loss' }));
        break;
      }
      case 'trailing_stop': {
        const pos = this.portfolio.position(symbol);
        if (!pos) break;
        pos.trailingStopPct = action.value;
        pos.highWater = Math.max(pos.highWater, price);
        out.push(this.submit({ ...base, side: 'sell', type: 'trailing_stop', qty: pos.qty, trailingPct: action.value, stopPrice: pos.trailingStopPrice(pos.highWater), reduceOnly: true, reason: 'trailing_stop' }));
        break;
      }
      case 'break_even': {
        const pos = this.portfolio.position(symbol);
        if (!pos) break;
        pos.breakevenSet = true;
        this.cancelAllProtective(symbol, 'stop_loss');
        pos.stopLoss = pos.entryPrice;
        out.push(this.submit({ ...base, side: 'sell', type: 'stop_market', qty: pos.qty, stopPrice: pos.entryPrice, reduceOnly: true, reason: 'break_even' }));
        break;
      }
      case 'cancel_orders': {
        this.cancelAll(symbol);
        break;
      }
      case 'set_leverage': {
        // Spot engine: leverage is NOT simulated. Record the request so the UI
        // can show it, but never pretend margin exists.
        this.log('warn', `set_leverage nie je v spot režime podporovaný (požiadavka ${action.value}x ignorovaná)`, { action });
        break;
      }
      case 'notify':
      case 'log': {
        this.log('notify', action.message ?? `Notifikácia z pravidla ${ctx.ruleId ?? ''}`, { ruleId: ctx.ruleId });
        break;
      }
      default:
        this.log('warn', `Neznáma akcia: ${action.type}`, { action });
    }
    return out;
  }

  cancelAllProtective(symbol, reason) {
    for (const o of this.openOrders) {
      if (o.symbol === symbol && o.reason === reason) this.cancel(o.id);
    }
  }

  /* ----------------------------------------------------------------- stats */

  summary() {
    const trades = this.trades;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    return {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? roundPct((wins.length / trades.length) * 100) : 0,
      grossProfit: roundCash(grossProfit),
      grossLoss: roundCash(grossLoss),
      profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : roundCash(grossProfit / grossLoss),
      feesPaid: roundCash(this.portfolio.feesPaid),
      realizedPnl: roundCash(this.portfolio.realizedPnl),
      cash: roundCash(this.portfolio.cash),
      equity: roundCash(this.portfolio.equity(this.lastPrice)),
    };
  }
}

export const __orderSeq = () => orderSeq;