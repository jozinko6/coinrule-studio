/**
 * filters.mjs — Binance exchangeInfo filters (PRICE_FILTER, LOT_SIZE,
 * MARKET_LOT_SIZE, NOTIONAL / MIN_NOTIONAL).
 *
 * Every real order must be normalised with the rules of its symbol BEFORE it is
 * submitted; invalid orders are blocked locally.
 */

/** Number of SIGNIFICANT decimals implied by a step/tick ("0.00100000" -> 3). */
export function decimalsFromStep(step) {
  const text = String(step ?? '').trim();
  if (!text || Number(text) === 0) return 0;
  const dot = text.indexOf('.');
  if (dot < 0) return 0;
  // Trailing zeros are not decimals: 0.00100000 -> "001" -> 3.
  const fraction = text.slice(dot + 1).replace(/0+$/, '');
  return fraction.length;
}

/** Floor to the market step (never exceed the requested quantity). */
export function floorToStep(value, step) {
  const s = Number(step);
  const v = Number(value);
  if (!(s > 0) || !Number.isFinite(v)) return Number(value);
  const decimals = decimalsFromStep(step);
  const units = Math.floor(v / s + 1e-9);
  return Number((units * s).toFixed(decimals));
}

/** Round to the market tick (nearest valid price). */
export function roundToTick(price, tick) {
  const t = Number(tick);
  const p = Number(price);
  if (!(t > 0) || !Number.isFinite(p)) return Number(price);
  const decimals = decimalsFromStep(tick);
  return Number((Math.round(p / t) * t).toFixed(decimals));
}

function filterOf(info, symbol, type) {
  const entry = (info?.symbols ?? []).find((s) => s.symbol === symbol);
  if (!entry) return null;
  return { entry, filter: (entry.filters ?? []).find((f) => f.filterType === type) ?? null };
}

/** Build a normalised rule set for one symbol from an exchangeInfo payload. */
export function rulesFromExchangeInfo(info, symbol) {
  const price = filterOf(info, symbol, 'PRICE_FILTER');
  const lot = filterOf(info, symbol, 'LOT_SIZE');
  const marketLot = filterOf(info, symbol, 'MARKET_LOT_SIZE');
  const notional = filterOf(info, symbol, 'NOTIONAL') ?? filterOf(info, symbol, 'MIN_NOTIONAL');
  if (!price?.entry) return null;
  return {
    symbol,
    status: String(price.entry.status ?? 'UNKNOWN'),
    tickSize: price.filter?.tickSize ?? '0.00000001',
    stepSize: lot.filter?.stepSize ?? '0.00000001',
    minQty: Number(lot.filter?.minQty ?? 0),
    maxQty: Number(lot.filter?.maxQty ?? Infinity),
    marketStepSize: marketLot.filter?.stepSize ?? lot.filter?.stepSize ?? '0.00000001',
    marketMinQty: Number(marketLot.filter?.minQty ?? lot.filter?.minQty ?? 0),
    marketMaxQty: Number(marketLot.filter?.maxQty ?? lot.filter?.maxQty ?? Infinity),
    minNotional: Number(notional?.filter?.minNotional ?? 0),
    applyMinNotional: String(notional?.filter?.applyMinNotional ?? 'false') === 'true' || notional?.filter?.filterType === 'MIN_NOTIONAL',
    quotePrecision: Number(price.entry.quotePrecision ?? 8),
  };
}

export function normalizePrice(price, rules) {
  return roundToTick(price, rules?.tickSize ?? '0.00000001');
}

export function normalizeQuantity(qty, rules, { market = false } = {}) {
  const step = market ? (rules?.marketStepSize ?? rules?.stepSize) : (rules?.stepSize ?? rules?.marketStepSize);
  const min = market ? (rules?.marketMinQty ?? rules?.minQty ?? 0) : (rules?.minQty ?? 0);
  const max = market ? (rules?.marketMaxQty ?? rules?.maxQty ?? Infinity) : (rules?.maxQty ?? Infinity);
  let normalized = floorToStep(qty, step);
  if (normalized < min && qty > 0) return { qty: 0, error: `qty ${qty} je pod minQty ${min}` };
  if (normalized > max) normalized = floorToStep(max, step);
  return { qty: normalized, error: null };
}

/** @returns {{ok:boolean, errors:string[], order:object}} */
export function normalizeOrder(order, rules) {
  const errors = [];
  const out = { ...order, symbol: rules?.symbol ?? order.symbol };
  if (!rules) return { ok: false, errors: ['chýbajú pravidlá symbolu (exchangeInfo)'], order: out };
  if (rules.status !== 'TRADING') errors.push(`symbol ${rules.symbol} nemá status TRADING (${rules.status})`);

  const isMarket = order.type === 'MARKET';
  const qtyResult = normalizeQuantity(order.quantity, rules, { market: isMarket });
  if (qtyResult.error) errors.push(qtyResult.error);
  out.quantity = qtyResult.qty;

  if (!isMarket) {
    if (!Number.isFinite(Number(order.price))) errors.push('limitový príkaz musí mať price');
    else out.price = normalizePrice(order.price, rules);
  }

  const referencePrice = Number(out.price ?? order.referencePrice ?? 0);
  if (rules.applyMinNotional && rules.minNotional > 0 && referencePrice > 0) {
    const notional = out.quantity * referencePrice;
    if (notional < rules.minNotional) errors.push(`notional ${notional.toFixed(8)} < minNotional ${rules.minNotional}`);
  }
  return { ok: errors.length === 0, errors, order: out };
}

/** Cache for exchangeInfo-derived rules (TTL + explicit invalidation). */
export class SymbolRulesCache {
  constructor({ fetchExchangeInfo, ttlMs = 30 * 60_000, clock = () => Date.now() } = {}) {
    this.fetchExchangeInfo = fetchExchangeInfo;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.info = null;
    this.fetchedAt = 0;
  }

  async rules(symbol, { force = false } = {}) {
    const stale = force || !this.info || this.clock() - this.fetchedAt > this.ttlMs;
    if (stale) {
      if (typeof this.fetchExchangeInfo !== 'function') throw new Error('SymbolRulesCache: chýba fetchExchangeInfo.');
      this.info = await this.fetchExchangeInfo();
      this.fetchedAt = this.clock();
    }
    return rulesFromExchangeInfo(this.info, symbol);
  }

  clear() {
    this.info = null;
    this.fetchedAt = 0;
  }
}