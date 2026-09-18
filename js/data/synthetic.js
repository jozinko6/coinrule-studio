/**
 * synthetic.js — deterministic offline market simulator.
 *
 * Used when the Binance public API is unreachable (no internet, rate limited,
 * blocked network) and as the fixed dataset for unit tests. Everything is
 * reproducible from a seed, so tests are exact.
 *
 * Model: GARCH(1,1)-ish volatility clustering + regime switching drift +
 * intrabar range expansion + volume correlated with |return|.
 */

/** Small, fast, deterministic PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string -> 32-bit seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Standard normal via Box–Muller using the supplied uniform generator. */
function gaussian(rnd) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const TIMEFRAME_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
};

export const SCENARIOS = {
  bull: { drift: 0.00045, vol: 0.012, label: 'Býčí trend' },
  bear: { drift: -0.00045, vol: 0.016, label: 'Medvedí trend' },
  sideways: { drift: 0.0, vol: 0.008, label: 'Bočný trh' },
  volatile: { drift: 0.0002, vol: 0.03, label: 'Vysoká volatilita' },
  calm: { drift: 0.0002, vol: 0.004, label: 'Nízka volatilita' },
  crash: { drift: -0.0012, vol: 0.035, label: 'Krach' },
  moon: { drift: 0.0015, vol: 0.02, label: 'Parabola' },
};

/**
 * Generate deterministic OHLCV candles.
 *
 * @param {object} opts
 * @param {string} [opts.symbol]      symbol, part of the default seed
 * @param {string} [opts.timeframe]   e.g. '1h'
 * @param {number} [opts.count]       number of candles
 * @param {number} [opts.endTime]     ms timestamp of the last candle's open
 * @param {number} [opts.seed]        explicit seed (defaults to hash of symbol+timeframe)
 * @param {number} [opts.startPrice]  initial price
 * @param {string} [opts.scenario]    key of SCENARIOS
 * @param {number} [opts.drift]       per-bar drift (overrides scenario)
 * @param {number} [opts.vol]         per-bar base volatility (overrides scenario)
 * @returns {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>}
 */
export function generateCandles(opts = {}) {
  const {
    symbol = 'BTCUSDT',
    timeframe = '1h',
    count = 1000,
    endTime = 1_700_000_000_000,
    seed = hashSeed(`${symbol}|${timeframe}`),
    startPrice = 20_000,
    scenario = 'sideways',
  } = opts;
  const preset = SCENARIOS[scenario] ?? SCENARIOS.sideways;
  const drift = opts.drift ?? preset.drift;
  const baseVol = opts.vol ?? preset.vol;
  const step = TIMEFRAME_MS[timeframe] ?? 3_600_000;
  const rnd = mulberry32(seed >>> 0);

  const candles = [];
  let price = startPrice;
  let sigma = baseVol;
  let eps2 = baseVol * baseVol;
  let regimeLeft = 40 + Math.floor(rnd() * 60);
  let regimeDrift = drift;

  const omega = baseVol * baseVol * 0.15;
  const alpha = 0.12;
  const beta = 0.8;

  for (let i = 0; i < count; i += 1) {
    // GARCH(1,1) variance update
    const variance = omega + alpha * eps2 + beta * sigma * sigma;
    sigma = Math.sqrt(Math.max(variance, 1e-12));
    eps2 = 0; // updated after the shock

    // regime switching: new drift every 40..100 bars
    regimeLeft -= 1;
    if (regimeLeft <= 0) {
      regimeLeft = 40 + Math.floor(rnd() * 60);
      // A regime shift nudges the drift by at most half a bar's volatility.
      regimeDrift = drift + (rnd() - 0.5) * baseVol * 0.5;
    }

    const shock = gaussian(rnd) * sigma;
    eps2 = shock * shock;
    const ret = regimeDrift + shock;
    const open = price;
    const close = Math.max(open * (1 + ret), 1e-6);

    // intrabar range: proportional to realised move plus extra noise
    const extra = Math.abs(gaussian(rnd)) * sigma * 0.55 * open;
    const high = Math.max(open, close) + extra * rnd();
    const low = Math.min(open, close) - extra * rnd();

    const volBase = opts.baseVolume ?? 120;
    const volume = Math.max(1, volBase * (0.6 + Math.abs(ret) / Math.max(sigma, 1e-9) * 0.5) * (0.7 + rnd() * 0.6));

    candles.push({
      time: endTime - (count - 1 - i) * step,
      open: round(open),
      high: round(high),
      low: round(Math.max(low, 1e-6)),
      close: round(close),
      volume: round(volume, 4),
    });
    price = close;
  }
  return candles;
}

function round(v, d = 4) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/**
 * Deterministic live-tick simulator: each call advances the price by one step.
 * Used by the "offline live" mode of the virtual trading screen.
 */
export function createTickSimulator({ symbol = 'BTCUSDT', timeframe = '1m', startPrice = 20_000, seed = null, scenario = 'volatile' } = {}) {
  const preset = SCENARIOS[scenario] ?? SCENARIOS.volatile;
  const rnd = mulberry32((seed ?? hashSeed(`${symbol}|ticks`)) >>> 0);
  const step = TIMEFRAME_MS[timeframe] ?? 60_000;
  let price = startPrice;
  let time = 1_700_000_000_000;
  return {
    next() {
      const ret = preset.drift + gaussian(rnd) * preset.vol * 0.6;
      price = Math.max(price * (1 + ret), 1e-6);
      time += step;
      const extra = Math.abs(gaussian(rnd)) * preset.vol * price * 0.5;
      return {
        time,
        price: round(price, 4),
        open: round(price / (1 + ret), 4),
        high: round(price + extra, 4),
        low: round(Math.max(price - extra, 1e-6), 4),
        close: round(price, 4),
        volume: round(50 + rnd() * 400, 4),
      };
    },
    get price() { return round(price, 4); },
  };
}

/** Named presets used by the UI's offline demo button. */
export const DEMO_PRESETS = [
  { id: 'btc-bull', symbol: 'BTCUSDT', timeframe: '1h', scenario: 'bull', count: 1200, startPrice: 26_000, label: 'BTC/USDT — býčí cyklus (1h)' },
  { id: 'btc-crash', symbol: 'BTCUSDT', timeframe: '1h', scenario: 'crash', count: 900, startPrice: 64_000, label: 'BTC/USDT — krach (1h)' },
  { id: 'eth-sideways', symbol: 'ETHUSDT', timeframe: '4h', scenario: 'sideways', count: 800, startPrice: 2_400, label: 'ETH/USDT — bočný trh (4h)' },
  { id: 'sol-volatile', symbol: 'SOLUSDT', timeframe: '15m', scenario: 'volatile', count: 1500, startPrice: 140, label: 'SOL/USDT — volatilný (15m)' },
  { id: 'btc-daily', symbol: 'BTCUSDT', timeframe: '1d', scenario: 'bull', count: 730, startPrice: 16_500, label: 'BTC/USDT — 2 roky denných dát' },
];
