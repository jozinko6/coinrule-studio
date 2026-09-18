/**
 * paper.js — the virtual (paper) broker.
 *
 * Models a real exchange closely enough to be useful, without ever touching a
 * real account: order types (market / limit / stop-market / stop-limit /
 * take-profit / trailing-stop), maker/taker fees, slippage, partial fills
 * limited by a participation rate, IOC/FOK/GTC time-in-force and OCO groups.
 *
 * Two execution modes:
 *   - `backtest`: market orders are queued and filled at the NEXT bar's open
 *     (no look-ahead bias).
 *   - `live`: market orders fill immediately at the last traded price
 *     (used by the real-time virtual trading screen).
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

  /** How much of an order can fill against a bar with `volume`. */
  fillCapacity(volume, order) {
    const rate = order.participationRate ?? this.participationRate;
    if (!Number.isFinite(volume) || volume <= 0 || !(rate > 0)) return Infinity;
    return volume * rate;
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
    const notional = roundCash(qty * execPrice);
    const fee = this.feeFor(notional, { isMaker });

    const prePos = order.side === 'sell' ? this.portfolio.position(order.symbol) : null;

    if (order.side === 'buy') {
      if (this.portfolio.cash < notional + fee) {
        // Not enough cash: shrink to what is affordable (market reality) or reject.
        const affordable = roundQty((this.portfolio.cash * (1 - this.takerFeePct / 100)) / execPrice);
        if (!(affordable > 0)) {
          order.status = ORDER_STATUS.REJECTED;
          this.rejections.push({ orderId: order.id, reason: 'insufficient_funds', time });
          return null;
        }
        qty = Math.min(qty, affordable);
      }
      this.portfolio.applyBuy({ symbol: order.symbol, qty, price: execPrice, fee, time });
    } else {
      const res = this.portfolio.applySell({ symbol: order.symbol, qty, price: execPrice, fee, time, reason: reason ?? order.reason });
      if (!res.qty) {
        order.status = ORDER_STATUS.REJECTED;
        this.rejections.push({ orderId: order.id, reason: 'no_position', time });
        return null;
      }
      this.recordTrade(order, execPrice, res.qty, fee, time, reason ?? order.reason, prePos);
    }

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
    if (order.status === ORDER_STATUS.FILLED) this.resolveOco(order);
    return { qty, price: execPrice, fee };
  }

  recordTrade(order, exitPrice, qty, fee, time, reason, prePos = null) {
    // The position may already be gone (fully closed) — use the snapshot taken
    // before the sell so the entry price is always correct.
    const entryPrice = prePos?.entryPrice ?? this.portfolio.position(order.symbol)?.entryPrice ?? exitPrice;
    const openedAt = prePos?.openedAt ?? this.portfolio.position(order.symbol)?.openedAt ?? order.createdAt ?? time;
    this.trades.push({
      id: `trd_${this.trades.length + 1}`,
      symbol: order.symbol,
      side: 'long',
      qty: roundQty(qty),
      entryPrice,
      exitPrice,
      pnl: roundCash((exitPrice - entryPrice) * qty - fee),
      pnlPct: roundPct(pctChange(entryPrice, exitPrice)),
      fees: fee,
      openedAt,
      closedAt: time,
      durationMs: time - openedAt,
      reason,
      ruleId: order.ruleId,
      strategyId: order.strategyId,
      orderId: order.id,
    });
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
      const affordable = roundQty((this.portfolio.cash * (1 - this.takerFeePct / 100)) / refPrice);
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

  /**
   * Feed one candle. Handles, in a conservative order:
   *   1. queued market orders -> fill at the bar open
   *   2. stop-loss / trailing-stop triggers
   *   3. take-profit triggers
   *   4. resting limit orders
   *   5. stop-entry orders (stop-market buy above / sell below)
   */
  onCandle(candle) {
    const { open, high, low, close, volume, time } = candle;
    this.lastVolume = volume ?? 0;
    this.lastTime = time ?? this.lastTime;
    const before = this.lastPrice;
    this.lastPrice = open;

    /** Fill price for a stop: gaps through the level fill at the open. */
    const stopPrice = (trigger, side) => (side === 'sell'
      ? (open <= trigger ? open : trigger)
      : (open >= trigger ? open : trigger));

    /** Fill price for a resting limit: you never do worse than the limit. */
    const limitPrice = (trigger, side) => (side === 'sell'
      ? (open >= trigger ? open : trigger)
      : (open <= trigger ? open : trigger));

    // 0. track the extremes of every open position
    for (const pos of this.portfolio.openPositions) pos.updateWatermarks(high);
    for (const pos of this.portfolio.openPositions) pos.updateWatermarks(low);

    // 0b. reduce-only orders whose position is gone can never fill — cancel them
    for (const o of this.openOrders) {
      if (!o.reduceOnly) continue;
      if (o.side !== 'sell') continue;
      if (this.portfolio.position(o.symbol)) continue;
      o.status = ORDER_STATUS.CANCELED;
      o.updatedAt = time;
      this.log('cancel', `Zrušený reduce-only príkaz #${o.id} (pozícia neexistuje)`, { orderId: o.id });
    }

    // 1. market orders queued from the previous bar (keep filling the remainder)
    for (const o of this.openOrders) {
      if (o.type !== 'market') continue;
      if (o.status !== ORDER_STATUS.PENDING_OPEN && o.status !== ORDER_STATUS.PARTIAL) continue;
      this.fillOrder(o, open, { volume, time, reason: o.reason });
    }

    // 2. protective exits — stops first (conservative when both are touched)
    const protective = this.openOrders
      .filter((o) => ['stop_market', 'trailing_stop', 'take_profit'].includes(o.type))
      .sort((a, b) => (a.type === 'take_profit' ? 1 : 0) - (b.type === 'take_profit' ? 1 : 0));
    for (const o of protective) {
      const pos = this.portfolio.position(o.symbol);
      if (!pos && o.side === 'sell') { o.status = ORDER_STATUS.CANCELED; continue; }
      let trigger = null;
      if (o.type === 'stop_market' || o.type === 'take_profit') trigger = o.stopPrice;
      if (o.type === 'trailing_stop') {
        trigger = pos.trailingStopPrice(high);
        o.stopPrice = trigger;
      }
      if (!Number.isFinite(trigger)) continue;
      const hit = o.side === 'sell' ? low <= trigger : high >= trigger;
      if (!hit) continue;
      const fillPrice = o.type === 'take_profit' ? limitPrice(trigger, o.side) : stopPrice(trigger, o.side);
      this.fillOrder(o, fillPrice, { volume, time, reason: o.reason });
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
      this.fillOrder(o, limitPrice(o.price, o.side), { volume, time, isMaker: true, reason: o.reason });
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
        this.fillOrder(o, stopPrice(o.stopPrice, o.side), { volume, time, reason: o.reason });
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
        out.push(this.submit({ ...base, side: 'sell', type: 'trailing_stop', qty: pos.qty, trailingPct: action.value, stopPrice: pos.trailingStopPrice(price), reduceOnly: true, reason: 'trailing_stop' }));
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
        this.leverage = action.value;
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
