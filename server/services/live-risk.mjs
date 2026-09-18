/**
 * live-risk.mjs — deterministic pre-trade risk gate for TESTNET/LIVE (Phase 8).
 *
 * Every order must pass checkOrder() BEFORE it reaches the exchange. The gate
 * is pure logic with an injectable clock so all limits are unit-testable.
 * The kill switch starts ENGAGED: no live order can leave until the operator
 * explicitly enables trading for the session.
 */

export const RISK_DEFAULTS = Object.freeze({
  maxOrderQuote: 1000,          // max notional of a single order
  maxPositionQuote: 5000,       // max notional of one open position
  maxPositionPct: 25,           // max position as % of equity (0 = ignore)
  maxDailyLossPct: 5,           // max realized daily loss as % of equity
  maxDrawdownPct: 20,           // max peak-to-trough equity drop
  maxTradesPerHour: 20,
  maxOpenOrders: 10,
  maxConsecutiveLosses: 5,
  cooldownAfterLossMs: 15 * 60_000,
  allowedSymbols: null,         // null = all symbols allowed
  blockedSymbols: [],
});

export class RiskViolation extends Error {
  constructor(check, message, details = {}) {
    super(message);
    this.name = 'RiskViolation';
    this.check = check;
    this.details = details;
  }
}

export class LiveRiskGuard {
  constructor({ limits = {}, clock = () => Date.now() } = {}) {
    this.limits = { ...RISK_DEFAULTS, ...limits };
    this.clock = clock;
    const now = this.clock();
    this.killSwitchEngaged = true;
    this.sessionStartedAt = now;
    this.equityQuote = 0;
    this.peakEquity = 0;
    this.dailyRealizedPnl = 0;
    this.dayStartedAt = now;
    this.consecutiveLosses = 0;
    this.lastLossAt = 0;
    this.tradeTimes = [];
    this.openOrders = new Map();          // clientOrderId -> { symbol, quote }
    this.openQuoteBySymbol = new Map();   // symbol -> quote
    this.violations = 0;
  }

  /* --------------------------------------------------------------- controls */

  startSession({ equityQuote = 0, killSwitch = true } = {}) {
    this.equityQuote = Number(equityQuote) || 0;
    this.peakEquity = Math.max(this.peakEquity, this.equityQuote);
    this.killSwitchEngaged = Boolean(killSwitch);
    this.sessionStartedAt = this.clock();
    return this.snapshot();
  }

  setKillSwitch(engaged) {
    this.killSwitchEngaged = Boolean(engaged);
    return this.killSwitchEngaged;
  }

  onEquity(equityQuote) {
    const equity = Number(equityQuote);
    if (!Number.isFinite(equity) || equity < 0) return;
    this.equityQuote = equity;
    this.peakEquity = Math.max(this.peakEquity, equity);
  }

  /* ------------------------------------------------------------ book-keeping */

  onOrderPlaced({ clientOrderId, symbol, quote }) {
    if (clientOrderId) this.openOrders.set(clientOrderId, { symbol, quote: Number(quote) || 0 });
    const open = (this.openQuoteBySymbol.get(symbol) ?? 0) + (Number(quote) || 0);
    this.openQuoteBySymbol.set(symbol, open);
    this.tradeTimes.push(this.clock());
  }

  onOrderSettled({ clientOrderId = null, symbol = null, quote = 0, pnl = null }) {
    if (clientOrderId && this.openOrders.has(clientOrderId)) {
      const order = this.openOrders.get(clientOrderId);
      this.openOrders.delete(clientOrderId);
      if (order.symbol) {
        const open = Math.max(0, (this.openQuoteBySymbol.get(order.symbol) ?? 0) - order.quote);
        this.openQuoteBySymbol.set(order.symbol, open);
      }
    } else if (symbol) {
      const open = Math.max(0, (this.openQuoteBySymbol.get(symbol) ?? 0) - (Number(quote) || 0));
      this.openQuoteBySymbol.set(symbol, open);
    }
    if (pnl !== null && pnl !== undefined) this.onTradeClosed({ pnl });
  }

  onTradeClosed({ pnl }) {
    const value = Number(pnl) || 0;
    this.dailyRealizedPnl += value;
    if (value < 0) {
      this.consecutiveLosses += 1;
      this.lastLossAt = this.clock();
    } else if (value > 0) {
      this.consecutiveLosses = 0;
    }
  }

  resetDaily() {
    this.dailyRealizedPnl = 0;
    this.dayStartedAt = this.clock();
    this.consecutiveLosses = 0;
  }

  tradesInLastHour() {
    const cutoff = this.clock() - 60 * 60_000;
    this.tradeTimes = this.tradeTimes.filter((t) => t >= cutoff);
    return this.tradeTimes.length;
  }

  /* ------------------------------------------------------------------- gate */

  /**
   * @throws {RiskViolation} when the order must not be sent.
   * @returns {{ok: true, notional: number}}
   */
  checkOrder({ symbol, side = 'BUY', type = 'MARKET', quantity = 0, price = 0, referencePrice = 0, reduceOnly = false, clientOrderId = null }) {
    const fail = (check, message, details = {}) => {
      this.violations += 1;
      throw new RiskViolation(check, message, { symbol, side, ...details });
    };

    if (this.killSwitchEngaged) fail('kill_switch', 'Kill switch je aktívny — obchodovanie je pozastavené.');

    const allowed = this.limits.allowedSymbols;
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(symbol)) fail('symbol_not_allowed', `Symbol ${symbol} nie je na zozname povolených.`);
    if ((this.limits.blockedSymbols ?? []).includes(symbol)) fail('symbol_blocked', `Symbol ${symbol} je blokovaný.`);

    const unitPrice = Number(price) > 0 ? Number(price) : Number(referencePrice);
    if (!(Number(quantity) > 0)) fail('invalid_quantity', 'Množstvo musí byť kladné.');
    if (!(unitPrice > 0)) fail('invalid_price', 'Chýba cena alebo referenčná cena pre výpočet notionalu.');

    const notional = Number(quantity) * unitPrice;

    if (!reduceOnly) {
      if (notional > this.limits.maxOrderQuote) {
        fail('max_order_quote', `Notional ${notional.toFixed(2)} > limit ${this.limits.maxOrderQuote}.`, { notional });
      }
      const open = this.openQuoteBySymbol.get(symbol) ?? 0;
      if (open + notional > this.limits.maxPositionQuote) {
        fail('max_position_quote', `Pozícia ${open + notional} > limit ${this.limits.maxPositionQuote}.`, { notional, open });
      }
      if (this.limits.maxPositionPct > 0 && this.equityQuote > 0) {
        const cap = (this.equityQuote * this.limits.maxPositionPct) / 100;
        if (open + notional > cap) {
          fail('max_position_pct', `Pozícia ${open + notional} > ${this.limits.maxPositionPct}% equity (${cap.toFixed(2)}).`, { notional, open });
        }
      }
      if (this.openOrders.size >= this.limits.maxOpenOrders) {
        fail('max_open_orders', `Otvorených objednávok ${this.openOrders.size} >= ${this.limits.maxOpenOrders}.`);
      }
      if (this.tradesInLastHour() >= this.limits.maxTradesPerHour) {
        fail('max_trades_per_hour', `Za poslednú hodinu už ${this.limits.maxTradesPerHour} obchodov.`);
      }
      if (this.consecutiveLosses > 0 && this.lastLossAt && this.clock() - this.lastLossAt < this.limits.cooldownAfterLossMs) {
        const wait = Math.ceil((this.limits.cooldownAfterLossMs - (this.clock() - this.lastLossAt)) / 1000);
        fail('cooldown_after_loss', `Po strate platí ${wait}s cooldown.`, { waitSeconds: wait });
      }
      if (this.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
        fail('max_consecutive_losses', `${this.consecutiveLosses} strát za sebou — nové vstupy sú zastavené.`);
      }
      if (this.limits.maxDailyLossPct > 0 && this.equityQuote > 0) {
        const lossPct = (-Math.min(0, this.dailyRealizedPnl) / this.equityQuote) * 100;
        if (lossPct >= this.limits.maxDailyLossPct) {
          fail('max_daily_loss', `Denná strata ${lossPct.toFixed(2)}% >= ${this.limits.maxDailyLossPct}%.`, { lossPct });
        }
      }
      if (this.limits.maxDrawdownPct > 0 && this.peakEquity > 0) {
        const drawdownPct = ((this.peakEquity - this.equityQuote) / this.peakEquity) * 100;
        if (drawdownPct >= this.limits.maxDrawdownPct) {
          fail('max_drawdown', `Drawdown ${drawdownPct.toFixed(2)}% >= ${this.limits.maxDrawdownPct}%.`, { drawdownPct });
        }
      }
    }

    void type;
    void clientOrderId;
    return { ok: true, notional };
  }

  snapshot() {
    return {
      killSwitchEngaged: this.killSwitchEngaged,
      equityQuote: this.equityQuote,
      peakEquity: this.peakEquity,
      dailyRealizedPnl: this.dailyRealizedPnl,
      consecutiveLosses: this.consecutiveLosses,
      openOrders: this.openOrders.size,
      openQuoteBySymbol: Object.fromEntries(this.openQuoteBySymbol),
      tradesLastHour: this.tradesInLastHour(),
      violations: this.violations,
      limits: { ...this.limits },
    };
  }
}