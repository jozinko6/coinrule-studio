/**
 * risk.js — position sizing and portfolio-level risk guards.
 *
 * Pure functions + one small stateful guard so both the backtester and the live
 * session share exactly the same risk behaviour.
 */

import { roundQty, roundCash } from './money.js';

/** Modes that need a stop distance to size the trade. */
export const RISK_BASED_MODES = new Set(['risk_percent', 'atr_risk']);

/**
 * Resolve an order quantity from a sizing instruction.
 *
 * @param {object} args
 * @param {string} args.mode      one of ENTRY_SIZING_MODES
 * @param {number} args.value     mode-dependent amount
 * @param {number} args.price     reference price
 * @param {number} args.cash      free quote balance
 * @param {number} args.equity    total account equity
 * @param {number} [args.stopPct] stop distance in percent (risk_percent)
 * @param {number} [args.atr]     ATR value (atr_risk)
 * @param {number} [args.atrMult] ATR multiplier (atr_risk)
 * @param {number} [args.feePct]  taker fee, used to keep the balance non-negative
 * @returns {number} quantity, never negative and never larger than the cash allows
 */
export function positionSize({
  mode = 'percent_cash',
  value = 0,
  price,
  cash = 0,
  equity = 0,
  stopPct = 2,
  atr = 0,
  atrMult = 2,
  feePct = 0.1,
} = {}) {
  if (!(price > 0)) return 0;
  const amount = Number(value) || 0;
  let qty = 0;

  switch (mode) {
    case 'fixed_quote': qty = amount / price; break;
    case 'fixed_base': qty = amount; break;
    case 'percent_cash': qty = ((cash * amount) / 100) / price; break;
    case 'percent_equity': qty = ((equity * amount) / 100) / price; break;
    case 'all_cash': qty = (cash * (1 - feePct / 100)) / price; break;
    case 'risk_percent': {
      const riskQuote = (equity * amount) / 100;
      qty = stopPct > 0 ? riskQuote / ((stopPct / 100) * price) : 0;
      break;
    }
    case 'atr_risk': {
      const stopDistance = atr * atrMult;
      const riskQuote = (equity * amount) / 100;
      qty = stopDistance > 0 ? riskQuote / stopDistance : 0;
      break;
    }
    case 'percent_position': // exit modes are resolved by the broker, not here
    case 'all':
    default:
      qty = 0;
  }

  const maxQty = (cash * (1 - feePct / 100)) / price;
  return roundQty(Math.max(0, Math.min(qty, maxQty)));
}

/**
 * Cap a quantity so the resulting position never exceeds `maxPositionPct` of
 * equity (counting what is already held).
 */
export function capByMaxPosition({ qty, price, equity, maxPositionPct = 100, currentNotional = 0 }) {
  if (!(price > 0) || !(equity > 0)) return 0;
  const room = Math.max(0, (equity * maxPositionPct) / 100 - currentNotional);
  const maxQty = room / price;
  return roundQty(Math.max(0, Math.min(qty, maxQty)));
}

/** Absolute protective price levels implied by percent settings. */
export function protectiveLevels(entryPrice, { stopLossPct = 0, takeProfitPct = 0, trailingPct = 0 } = {}) {
  return {
    stopLoss: stopLossPct > 0 ? roundCash(entryPrice * (1 - stopLossPct / 100)) : null,
    takeProfit: takeProfitPct > 0 ? roundCash(entryPrice * (1 + takeProfitPct / 100)) : null,
    trailing: trailingPct > 0 ? roundCash(entryPrice * (1 - trailingPct / 100)) : null,
  };
}

/** Risk/reward ratio for a long trade. */
export function rewardRisk(entryPrice, stopPrice, targetPrice) {
  const risk = entryPrice - stopPrice;
  const reward = targetPrice - entryPrice;
  if (!(risk > 0)) return null;
  return roundCash(reward / risk);
}

/** Kelly fraction (0..1) from a win rate and payoff ratio. */
export function kellyFraction(winRatePct, payoffRatio) {
  const p = winRatePct / 100;
  if (!(payoffRatio > 0)) return 0;
  const f = p - (1 - p) / payoffRatio;
  return Math.max(0, Math.min(1, f));
}

/**
 * Portfolio-level guard: hard drawdown stop + daily loss limit + cooldown.
 * Deterministic and side-effect free apart from its own counters.
 */
export class RiskGuard {
  constructor({ maxDrawdownPct = 0, maxDailyLossPct = 0, cooldownBars = 0, msPerDay = 86_400_000 } = {}) {
    this.maxDrawdownPct = maxDrawdownPct;
    this.maxDailyLossPct = maxDailyLossPct;
    this.cooldownBars = cooldownBars;
    this.msPerDay = msPerDay;
    this.killed = false;
    this.blockedUntilNextDay = false;
    this.dayAnchor = null;
    this.dayStartEquity = null;
    this.events = [];
  }

  /** Reset the per-day bookkeeping at the start of a new UTC day. */
  rollDay(time, equity) {
    const day = Math.floor(time / this.msPerDay);
    if (this.dayAnchor === day) return false;
    this.dayAnchor = day;
    this.dayStartEquity = equity;
    this.blockedUntilNextDay = false;
    return true;
  }

  /**
   * Evaluate the guards for one bar.
   * @returns {{kill:boolean, blockEntries:boolean, dayLossPct:number, reason:string|null}}
   */
  evaluate({ time, equity, drawdownPct }) {
    this.rollDay(time, equity);

    if (!this.killed && this.maxDrawdownPct > 0 && drawdownPct >= this.maxDrawdownPct) {
      this.killed = true;
      this.events.push({ type: 'kill_switch', time, message: `Maximálny drawdown ${this.maxDrawdownPct} % dosiahnutý — zatváram všetky pozície.` });
      return { kill: true, blockEntries: true, dayLossPct: 0, reason: 'max_drawdown' };
    }

    const dayLossPct = this.dayStartEquity > 0
      ? ((this.dayStartEquity - equity) / this.dayStartEquity) * 100
      : 0;

    if (!this.blockedUntilNextDay && this.maxDailyLossPct > 0 && dayLossPct >= this.maxDailyLossPct) {
      this.blockedUntilNextDay = true;
      this.events.push({ type: 'guard', time, message: `Denný limit straty ${this.maxDailyLossPct} % dosiahnutý — nové vstupy zastavené.` });
      return { kill: false, blockEntries: true, dayLossPct, reason: 'daily_loss' };
    }

    return { kill: false, blockEntries: this.blockedUntilNextDay || this.killed, dayLossPct, reason: null };
  }

  /** Cooldown helper shared by rule evaluation. */
  cooldownActive(barsSinceLastTrigger) {
    return this.cooldownBars > 0 && barsSinceLastTrigger < this.cooldownBars;
  }
}
