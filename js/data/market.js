/**
 * market.js — the market-data facade used by the UI.
 *
 * Sources:
 *   'binance'   — live public Binance data (no API key)
 *   'synthetic' — deterministic offline simulator
 *   'auto'      — try Binance, silently fall back to synthetic (degraded mode)
 *
 * The facade always returns the same candle shape, so every downstream
 * component (chart, backtester, paper trader) is source-agnostic.
 */

import { BinancePublic, POPULAR_SYMBOLS } from './binance.js';
import { getSeedCandles, SEED_DATASETS } from './seed.js';
import { generateCandles, createTickSimulator, DEMO_PRESETS, SCENARIOS } from './synthetic.js';

export { POPULAR_SYMBOLS, DEMO_PRESETS, SCENARIOS, SEED_DATASETS };

export const SOURCE = { BINANCE: 'binance', SYNTHETIC: 'synthetic', AUTO: 'auto' };

export class MarketData {
  constructor(opts = {}) {
    this.source = opts.source ?? SOURCE.AUTO;
    this.client = opts.client ?? new BinancePublic(opts.clientOptions ?? {});
    this.log = opts.log ?? (() => {});
    this.lastStatus = { mode: this.source, degraded: false, message: 'nepripojené', at: 0 };
    this.cache = new Map();
    this.simulators = new Map();
  }

  /** Is live data reachable right now? Cached for `ttlMs`. */
  async probe({ ttlMs = 60_000 } = {}) {
    if (this.source === SOURCE.SYNTHETIC) return { ok: false, reason: 'synthetic_mode' };
    const now = Date.now();
    if (this._probe && now - this._probeAt < ttlMs) return this._probe;
    try {
      const r = await this.client.ping();
      this._probe = { ok: true, latencyMs: r.latencyMs };
      this.lastStatus = { mode: 'binance', degraded: false, message: `Binance online (${r.latencyMs} ms)`, at: now };
    } catch (err) {
      this._probe = { ok: false, reason: err.message };
      this.lastStatus = { mode: 'synthetic', degraded: true, message: `Offline režim: ${err.message}`, at: now };
    }
    this._probeAt = now;
    return this._probe;
  }

  /**
   * Load candles for a symbol/timeframe.
   * @returns {Promise<{candles:Array, source:string, degraded:boolean, message:string}>}
   */
  async loadCandles({ symbol = 'BTCUSDT', timeframe = '1h', limit = 500, forceSource = null } = {}) {
    const source = forceSource ?? this.source;
    if (source === SOURCE.SYNTHETIC) return this.synthetic({ symbol, timeframe, limit });
    if (source === SOURCE.BINANCE) {
      const candles = await this.client.klinesHistory(symbol, timeframe, limit);
      this.lastStatus = { mode: 'binance', degraded: false, message: `Binance ${symbol} ${timeframe} (${candles.length})`, at: Date.now() };
      return { candles, source: SOURCE.BINANCE, degraded: false, message: this.lastStatus.message };
    }
    // auto
    try {
      const candles = await this.client.klinesHistory(symbol, timeframe, limit);
      if (!candles.length) throw new Error('prázdna odpoveď');
      this.lastStatus = { mode: 'binance', degraded: false, message: `Binance ${symbol} ${timeframe} (${candles.length})`, at: Date.now() };
      return { candles, source: SOURCE.BINANCE, degraded: false, message: this.lastStatus.message };
    } catch (err) {
      this.log('warn', `Binance nedostupná (${err.message}) — prepínam na simulované dáta.`);
      const res = this.synthetic({ symbol, timeframe, limit });
      return { ...res, degraded: true, message: `Simulované dáta (Binance nedostupná: ${err.message})` };
    }
  }

  /** Offline dataset — deterministic, instant, never fails. */
  synthetic({ symbol = 'BTCUSDT', timeframe = '1h', limit = 500 }) {
    let candles = getSeedCandles(symbol, timeframe);
    if (candles.length < limit) {
      candles = generateCandles({
        symbol, timeframe, count: Math.max(limit, 800), scenario: 'sideways', seed: 4242, startPrice: candles[0]?.close ?? 100,
      });
    }
    const sliced = candles.slice(-limit);
    this.lastStatus = { mode: 'synthetic', degraded: true, message: `Simulované dáta ${symbol} ${timeframe} (${sliced.length})`, at: Date.now() };
    return { candles: sliced, source: SOURCE.SYNTHETIC, degraded: true, message: this.lastStatus.message };
  }

  async ticker(symbol) {
    if (this.source === SOURCE.SYNTHETIC) return this.syntheticTicker(symbol);
    try {
      return { ...(await this.client.ticker24h(symbol)), source: SOURCE.BINANCE };
    } catch {
      return { ...this.syntheticTicker(symbol), degraded: true };
    }
  }

  syntheticTicker(symbol) {
    const candles = getSeedCandles(symbol, '1h');
    const lastC = candles[candles.length - 1];
    const prev = candles[candles.length - 25] ?? lastC;
    return {
      symbol,
      price: lastC.close,
      changePct: ((lastC.close - prev.close) / prev.close) * 100,
      high: Math.max(...candles.slice(-24).map((c) => c.high)),
      low: Math.min(...candles.slice(-24).map((c) => c.low)),
      volume: candles.slice(-24).reduce((a, c) => a + c.volume, 0),
      source: SOURCE.SYNTHETIC,
      degraded: true,
    };
  }

  /** Price stream. Uses Binance WS when available, otherwise a deterministic simulator. */
  openFeed({ symbol = 'BTCUSDT', timeframe = '1m', intervalMs = 1000, onTick, onError, onStatus } = {}) {
    const push = (tick) => onTick?.(tick);
    if (this.source !== SOURCE.SYNTHETIC) {
      try {
        const stream = `${symbol.toLowerCase()}@miniTicker`;
        const handle = this.client.subscribe([stream], (msg) => {
          if (msg.kind === 'miniTicker') push({ time: Date.now(), price: msg.price, symbol, source: SOURCE.BINANCE });
        }, {
          onError: (e) => onError?.(e),
          onOpen: () => onStatus?.({ mode: 'binance', degraded: false, message: `WebSocket ${stream}` }),
        });
        return { close: () => handle.close(), mode: SOURCE.BINANCE };
      } catch (err) {
        onError?.(err);
      }
    }
    const key = `${symbol}:${timeframe}`;
    if (!this.simulators.has(key)) this.simulators.set(key, createTickSimulator({ symbol, timeframe }));
    const sim = this.simulators.get(key);
    const timer = setInterval(() => {
      const t = sim.next();
      push({ ...t, symbol, source: SOURCE.SYNTHETIC });
    }, Math.max(50, intervalMs));
    onStatus?.({ mode: 'synthetic', degraded: true, message: `Simulovaný feed ${symbol} (${Math.max(50, intervalMs)} ms)` });
    return { close: () => clearInterval(timer), mode: SOURCE.SYNTHETIC };
  }

  /** Build a synthetic candle series on demand (custom scenarios in the UI). */
  generate(opts) {
    return generateCandles(opts);
  }
}

/** Normalise any candle array: sorted, deduplicated, numeric. */
export function sanitizeCandles(candles) {
  const seen = new Set();
  return candles
    .map((c) => ({
      time: Number(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume ?? 0),
    }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time)
    .filter((c) => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });
}
