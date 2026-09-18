/**
 * indicators.js — pure technical-analysis library.
 *
 * Conventions
 *  - Every function takes plain arrays (numbers, or candle objects) and returns
 *    arrays of the SAME length as the input, left-padded with `null` during the
 *    warm-up period. That makes alignment with candles trivial.
 *  - No DOM, no globals, no dependencies: safe under `node --test`.
 *
 * A candle is `{ time, open, high, low, close, volume }`.
 */

/* ------------------------------------------------------------------ helpers */

export const nulls = (n) => new Array(n).fill(null);

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Last non-null value of a series. */
export function last(series) {
  for (let i = series.length - 1; i >= 0; i -= 1) if (isNum(series[i])) return series[i];
  return null;
}

/** Value `offset` bars back from the end (offset 0 = last). */
export function at(series, offset) {
  const i = series.length - 1 - offset;
  return i >= 0 ? series[i] : null;
}

export const closes = (candles) => candles.map((c) => c.close);
export const highs = (candles) => candles.map((c) => c.high);
export const lows = (candles) => candles.map((c) => c.low);
export const opens = (candles) => candles.map((c) => c.open);
export const volumes = (candles) => candles.map((c) => c.volume);
export const typical = (c) => (c.high + c.low + c.close) / 3;
export const medianPrice = (c) => (c.high + c.low) / 2;

export function sum(values, from = 0, to = values.length) {
  let s = 0;
  for (let i = from; i < to; i += 1) s += values[i];
  return s;
}

export function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

export function stdev(values, { sample = false } = {}) {
  const n = values.length;
  if (n === 0) return null;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  const denom = sample ? Math.max(1, n - 1) : n;
  return Math.sqrt(acc / denom);
}

export function highest(values, from = 0, to = values.length) {
  let m = -Infinity;
  for (let i = from; i < to; i += 1) if (values[i] > m) m = values[i];
  return m === -Infinity ? null : m;
}

export function lowest(values, from = 0, to = values.length) {
  let m = Infinity;
  for (let i = from; i < to; i += 1) if (values[i] < m) m = values[i];
  return m === Infinity ? null : m;
}

export function highestIndex(values, from = 0, to = values.length) {
  let m = -Infinity;
  let idx = -1;
  for (let i = from; i < to; i += 1) if (values[i] > m) { m = values[i]; idx = i; }
  return idx;
}

export function lowestIndex(values, from = 0, to = values.length) {
  let m = Infinity;
  let idx = -1;
  for (let i = from; i < to; i += 1) if (values[i] < m) { m = values[i]; idx = i; }
  return idx;
}

/** Rolling window application with a reducer over [i-period+1 .. i]. */
function rolling(values, period, fn) {
  const out = nulls(values.length);
  if (!(period > 0)) return out;
  for (let i = period - 1; i < values.length; i += 1) {
    out[i] = fn(values.slice(i - period + 1, i + 1), i);
  }
  return out;
}

/* ------------------------------------------------------- moving averages */

/** Simple moving average. */
export function sma(values, period) {
  return rolling(values, period, (w) => sum(w) / w.length);
}

/** Wilder's smoothing (a.k.a. RMA / SMMA). */
export function rma(values, period) {
  const out = nulls(values.length);
  if (!(period > 0) || values.length < period) return out;
  let prev = sum(values, 0, period) / period;
  out[period - 1] = prev;
  const alpha = 1 / period;
  for (let i = period; i < values.length; i += 1) {
    prev += alpha * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values, period) {
  const out = nulls(values.length);
  if (!(period > 0) || values.length < period) return out;
  const alpha = 2 / (period + 1);
  let prev = sum(values, 0, period) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = prev + alpha * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** Weighted moving average (linear weights, most recent = period). */
export function wma(values, period) {
  const wsum = (period * (period + 1)) / 2;
  return rolling(values, period, (w) => {
    let acc = 0;
    for (let k = 0; k < w.length; k += 1) acc += w[k] * (k + 1);
    return acc / wsum;
  });
}

/** Double exponential moving average. */
export function dema(values, period) {
  const e1 = ema(values, period);
  const e2 = ema(e1.filter(isNum), period);
  const offset = e1.length - e2.length;
  return e1.map((v, i) => (isNum(v) && i - offset >= 0 && isNum(e2[i - offset]) ? 2 * v - e2[i - offset] : null));
}

/** Triple exponential moving average. */
export function tema(values, period) {
  const e1 = ema(values, period);
  const c1 = e1.filter(isNum);
  const e2 = ema(c1, period);
  const e3 = ema(e2.filter(isNum), period);
  const o2 = e1.length - e2.length;
  const o3 = e1.length - e3.length;
  return e1.map((v, i) => {
    const a = i - o2 >= 0 ? e2[i - o2] : null;
    const b = i - o3 >= 0 ? e3[i - o3] : null;
    return isNum(v) && isNum(a) && isNum(b) ? 3 * v - 3 * a + b : null;
  });
}

/** Hull moving average. */
export function hma(values, period) {
  const half = Math.round(period / 2);
  const root = Math.round(Math.sqrt(period));
  const w1 = wma(values, half);
  const w2 = wma(values, period);
  const raw = values.map((_, i) => (isNum(w1[i]) && isNum(w2[i]) ? 2 * w1[i] - w2[i] : null));
  return wma(raw.filter(isNum), root).reduce((acc, v, i) => {
    acc[i + (raw.length - raw.filter(isNum).length)] = v;
    return acc;
  }, nulls(raw.length));
}

/** Kaufman adaptive moving average. */
export function kama(values, period = 10, fast = 2, slow = 30) {
  const out = nulls(values.length);
  if (values.length <= period) return out;
  const fastSC = 2 / (fast + 1);
  const slowSC = 2 / (slow + 1);
  let prev = values[period - 1];
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    const change = Math.abs(values[i] - values[i - period]);
    let vol = 0;
    for (let k = i - period + 1; k <= i; k += 1) vol += Math.abs(values[k] - values[k - 1]);
    const er = vol === 0 ? 0 : change / vol;
    const sc = (er * (fastSC - slowSC) + slowSC) ** 2;
    prev += sc * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** Volume weighted moving average. */
export function vwma(candles, period) {
  const out = nulls(candles.length);
  for (let i = period - 1; i < candles.length; i += 1) {
    let pv = 0;
    let v = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      pv += candles[k].close * candles[k].volume;
      v += candles[k].volume;
    }
    out[i] = v === 0 ? null : pv / v;
  }
  return out;
}

/** Rolling volume weighted average price (session-anchored when anchor=true). */
export function vwap(candles, { anchor = true, period = 0 } = {}) {
  const out = nulls(candles.length);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (anchor && i > 0 && isNewSession(candles[i], candles[i - 1])) {
      cumPV = 0;
      cumV = 0;
    }
    if (period > 0 && i >= period) {
      cumPV -= typical(candles[i - period]) * candles[i - period].volume;
      cumV -= candles[i - period].volume;
    }
    cumPV += typical(candles[i]) * candles[i].volume;
    cumV += candles[i].volume;
    out[i] = cumV === 0 ? null : cumPV / cumV;
  }
  return out;
}

function isNewSession(cur, prev) {
  if (!isNum(cur.time) || !isNum(prev.time)) return false;
  return Math.floor(cur.time / 86400000) !== Math.floor(prev.time / 86400000);
}

/* --------------------------------------------------------------- momentum */

/** Relative Strength Index (Wilder). */
export function rsi(values, period = 14) {
  const out = nulls(values.length);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Moving Average Convergence Divergence. */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastE = ema(values, fast);
  const slowE = ema(values, slow);
  const macdLine = values.map((_, i) => (isNum(fastE[i]) && isNum(slowE[i]) ? fastE[i] - slowE[i] : null));
  const dense = macdLine.filter(isNum);
  const sig = ema(dense, signalPeriod);
  const offset = macdLine.length - dense.length;
  const signal = macdLine.map((_, i) => (i - offset >= 0 ? sig[i - offset] : null));
  const histogram = macdLine.map((v, i) => (isNum(v) && isNum(signal[i]) ? v - signal[i] : null));
  return { macd: macdLine, signal, histogram };
}

/** Bollinger Bands. */
export function bollinger(values, period = 20, mult = 2, { sample = false } = {}) {
  const middle = sma(values, period);
  const upper = nulls(values.length);
  const lower = nulls(values.length);
  const bandwidth = nulls(values.length);
  const percentB = nulls(values.length);
  for (let i = period - 1; i < values.length; i += 1) {
    const w = values.slice(i - period + 1, i + 1);
    const sd = stdev(w, { sample });
    const m = middle[i];
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    bandwidth[i] = m === 0 ? null : ((upper[i] - lower[i]) / m) * 100;
    const span = upper[i] - lower[i];
    percentB[i] = span === 0 ? 50 : ((values[i] - lower[i]) / span) * 100;
  }
  return { middle, upper, lower, bandwidth, percentB };
}

/** Keltner Channels (EMA +/- mult * ATR). */
export function keltner(candles, period = 20, mult = 2, atrPeriod = 10) {
  const c = closes(candles);
  const middle = ema(c, period);
  const a = atr(candles, atrPeriod);
  const upper = c.map((_, i) => (isNum(middle[i]) && isNum(a[i]) ? middle[i] + mult * a[i] : null));
  const lower = c.map((_, i) => (isNum(middle[i]) && isNum(a[i]) ? middle[i] - mult * a[i] : null));
  return { middle, upper, lower };
}

/** Donchian channels. */
export function donchian(candles, period = 20) {
  const h = highs(candles);
  const l = lows(candles);
  const upper = nulls(candles.length);
  const lower = nulls(candles.length);
  const middle = nulls(candles.length);
  for (let i = period - 1; i < candles.length; i += 1) {
    upper[i] = highest(h, i - period + 1, i + 1);
    lower[i] = lowest(l, i - period + 1, i + 1);
    middle[i] = (upper[i] + lower[i]) / 2;
  }
  return { upper, middle, lower };
}

/** Rate of change in percent. */
export function roc(values, period = 9) {
  const out = nulls(values.length);
  for (let i = period; i < values.length; i += 1) {
    const base = values[i - period];
    out[i] = base === 0 ? null : ((values[i] - base) / base) * 100;
  }
  return out;
}

/** Absolute momentum (price difference). */
export function momentum(values, period = 10) {
  const out = nulls(values.length);
  for (let i = period; i < values.length; i += 1) out[i] = values[i] - values[i - period];
  return out;
}

/** Commodity Channel Index. */
export function cci(candles, period = 20) {
  const tp = candles.map(typical);
  const ma = sma(tp, period);
  const out = nulls(candles.length);
  for (let i = period - 1; i < candles.length; i += 1) {
    const w = tp.slice(i - period + 1, i + 1);
    const md = mean(w.map((v) => Math.abs(v - ma[i])));
    out[i] = md === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * md);
  }
  return out;
}

/** Williams %R (0..-100). */
export function williamsR(candles, period = 14) {
  const h = highs(candles);
  const l = lows(candles);
  const out = nulls(candles.length);
  for (let i = period - 1; i < candles.length; i += 1) {
    const hh = highest(h, i - period + 1, i + 1);
    const ll = lowest(l, i - period + 1, i + 1);
    out[i] = hh === ll ? -50 : ((hh - candles[i].close) / (hh - ll)) * -100;
  }
  return out;
}

/** Stochastic oscillator. */
export function stochastic(candles, kPeriod = 14, dPeriod = 3, smoothing = 3) {
  const h = highs(candles);
  const l = lows(candles);
  const rawK = nulls(candles.length);
  for (let i = kPeriod - 1; i < candles.length; i += 1) {
    const hh = highest(h, i - kPeriod + 1, i + 1);
    const ll = lowest(l, i - kPeriod + 1, i + 1);
    rawK[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const k = sma(rawK.filter(isNum), smoothing);
  const kAligned = realign(k, rawK);
  const d = sma(kAligned.filter(isNum), dPeriod);
  return { k: kAligned, d: realign(d, kAligned), rawK };
}

/** Stochastic RSI. */
export function stochRsi(values, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
  const r = rsi(values, rsiPeriod);
  const dense = r.filter(isNum);
  const k = nulls(r.length);
  for (let i = stochPeriod - 1; i < dense.length; i += 1) {
    const w = dense.slice(i - stochPeriod + 1, i + 1);
    const hh = Math.max(...w);
    const ll = Math.min(...w);
    k[i + (r.length - dense.length)] = hh === ll ? 0 : ((dense[i] - ll) / (hh - ll)) * 100;
  }
  const kS = sma(k.filter(isNum), kPeriod);
  const kAligned = realign(kS, k);
  const dS = sma(kAligned.filter(isNum), dPeriod);
  return { k: kAligned, d: realign(dS, kAligned) };
}

/** Align a shorter dense series back onto a longer sparse series. */
export function realign(dense, sparse) {
  const out = nulls(sparse.length);
  const offset = sparse.length - dense.length;
  for (let i = 0; i < dense.length; i += 1) out[i + offset] = dense[i];
  return out;
}

/* ---------------------------------------------------------- trend strength */

export function trueRange(candles) {
  const out = nulls(candles.length);
  for (let i = 0; i < candles.length; i += 1) {
    if (i === 0) { out[i] = candles[i].high - candles[i].low; continue; }
    const p = candles[i - 1].close;
    out[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - p), Math.abs(candles[i].low - p));
  }
  return out;
}

/** Average True Range (Wilder smoothing). */
export function atr(candles, period = 14) {
  return rma(trueRange(candles), period);
}

/** Normalised ATR in percent of price. */
export function natr(candles, period = 14) {
  const a = atr(candles, period);
  return candles.map((c, i) => (isNum(a[i]) && c.close ? (a[i] / c.close) * 100 : null));
}

/** Average Directional Index with +DI/-DI. */
export function adx(candles, period = 14) {
  const n = candles.length;
  const plusDM = nulls(n);
  const minusDM = nulls(n);
  for (let i = 1; i < n; i += 1) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(candles);
  const atrS = rma(tr.filter(isNum), period);
  const atrAligned = realign(atrS, tr);
  const pdi = nulls(n);
  const mdi = nulls(n);
  const p = rma(plusDM.filter(isNum), period);
  const m = rma(minusDM.filter(isNum), period);
  const pA = realign(p, plusDM);
  const mA = realign(m, minusDM);
  for (let i = 0; i < n; i += 1) {
    if (!isNum(atrAligned[i]) || atrAligned[i] === 0) continue;
    pdi[i] = (100 * pA[i]) / atrAligned[i];
    mdi[i] = (100 * mA[i]) / atrAligned[i];
  }
  const dx = nulls(n);
  for (let i = 0; i < n; i += 1) {
    if (!isNum(pdi[i]) || !isNum(mdi[i])) continue;
    const s = pdi[i] + mdi[i];
    dx[i] = s === 0 ? 0 : (Math.abs(pdi[i] - mdi[i]) / s) * 100;
  }
  const adxDense = rma(dx.filter(isNum), period);
  return { adx: realign(adxDense, dx), plusDI: pdi, minusDI: mdi, dx };
}

/** Aroon up/down + oscillator. */
export function aroon(candles, period = 25) {
  const h = highs(candles);
  const l = lows(candles);
  const up = nulls(candles.length);
  const down = nulls(candles.length);
  const osc = nulls(candles.length);
  for (let i = period; i < candles.length; i += 1) {
    const hi = highestIndex(h, i - period, i + 1);
    const li = lowestIndex(l, i - period, i + 1);
    up[i] = ((period - (i - hi)) / period) * 100;
    down[i] = ((period - (i - li)) / period) * 100;
    osc[i] = up[i] - down[i];
  }
  return { up, down, osc };
}

/** Parabolic SAR. */
export function psar(candles, step = 0.02, max = 0.2) {
  const out = nulls(candles.length);
  if (candles.length < 2) return out;
  let bull = candles[1].close >= candles[0].close;
  let af = step;
  let ep = bull ? candles[0].high : candles[0].low;
  let sar = bull ? candles[0].low : candles[0].high;
  out[0] = sar;
  for (let i = 1; i < candles.length; i += 1) {
    sar += af * (ep - sar);
    if (bull) {
      sar = Math.min(sar, candles[i - 1].low, i >= 2 ? candles[i - 2].low : candles[i - 1].low);
      if (candles[i].low < sar) {
        bull = false; sar = ep; ep = candles[i].low; af = step;
      } else if (candles[i].high > ep) {
        ep = candles[i].high; af = Math.min(af + step, max);
      }
    } else {
      sar = Math.max(sar, candles[i - 1].high, i >= 2 ? candles[i - 2].high : candles[i - 1].high);
      if (candles[i].high > sar) {
        bull = true; sar = ep; ep = candles[i].high; af = step;
      } else if (candles[i].low < ep) {
        ep = candles[i].low; af = Math.min(af + step, max);
      }
    }
    out[i] = sar;
  }
  return out;
}

/** Supertrend. Returns { line, trend } where trend is 1 (up) / -1 (down). */
export function supertrend(candles, period = 10, mult = 3) {
  const n = candles.length;
  const a = atr(candles, period);
  const line = nulls(n);
  const trend = nulls(n);
  let up = null;
  let dn = null;
  let dir = 1;
  for (let i = 0; i < n; i += 1) {
    if (!isNum(a[i])) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUp = hl2 - mult * a[i];
    const basicDn = hl2 + mult * a[i];
    up = up === null ? basicUp : Math.max(basicUp, up);
    dn = dn === null ? basicDn : Math.min(basicDn, dn);
    if (candles[i].close > (dn ?? Infinity)) {
      dir = 1;
    } else if (candles[i].close < (up ?? -Infinity)) {
      dir = -1;
    }
    if (dir === 1 && (up === null || candles[i].close < up)) { up = basicUp; dir = -1; }
    if (dir === -1 && (dn === null || candles[i].close > dn)) { dn = basicDn; dir = 1; }
    trend[i] = dir;
    line[i] = dir === 1 ? up : dn;
  }
  return { line, trend };
}

/** Ichimoku Kinko Hyo. */
export function ichimoku(candles, tenkanP = 9, kijunP = 26, senkouP = 52, displacement = 26) {
  const h = highs(candles);
  const l = lows(candles);
  const mid = (p) => {
    const out = nulls(candles.length);
    for (let i = p - 1; i < candles.length; i += 1) {
      out[i] = (highest(h, i - p + 1, i + 1) + lowest(l, i - p + 1, i + 1)) / 2;
    }
    return out;
  };
  const tenkan = mid(tenkanP);
  const kijun = mid(kijunP);
  const senkouA = candles.map((_, i) => (isNum(tenkan[i]) && isNum(kijun[i]) ? (tenkan[i] + kijun[i]) / 2 : null));
  const senkouBRaw = mid(senkouP);
  const shift = (series, n) => series.map((_, i) => (i - n >= 0 ? series[i - n] : null));
  return {
    tenkan,
    kijun,
    senkouA: shift(senkouA, displacement),
    senkouB: shift(senkouBRaw, displacement),
    chikou: shift(closes(candles), -displacement),
    senkouARaw: senkouA,
    senkouBRaw,
  };
}

/** TRIX (triple smoothed EMA rate of change, %). */
export function trix(values, period = 15) {
  const e1 = ema(values, period).filter(isNum);
  const e2 = ema(e1, period).filter(isNum);
  const e3 = ema(e2, period).filter(isNum);
  const out = nulls(values.length);
  const offset = values.length - e3.length;
  for (let i = 1; i < e3.length; i += 1) {
    if (e3[i - 1] === 0) continue;
    out[i + offset] = ((e3[i] - e3[i - 1]) / e3[i - 1]) * 100;
  }
  return out;
}

/** Detrended Price Oscillator. */
export function dpo(values, period = 20) {
  const m = Math.floor(period / 2) + 1;
  const s = sma(values, period);
  return values.map((v, i) => (i - m >= 0 && isNum(s[i - m]) ? v - s[i - m] : null));
}

/** Vortex indicator. */
export function vortex(candles, period = 14) {
  const n = candles.length;
  const vmPlus = nulls(n);
  const vmMinus = nulls(n);
  for (let i = 1; i < n; i += 1) {
    vmPlus[i] = Math.abs(candles[i].high - candles[i - 1].low);
    vmMinus[i] = Math.abs(candles[i].low - candles[i - 1].high);
  }
  const tr = trueRange(candles);
  const plus = nulls(n);
  const minus = nulls(n);
  for (let i = period; i < n; i += 1) {
    const trSum = sum(tr, i - period + 1, i + 1);
    if (trSum === 0) continue;
    plus[i] = sum(vmPlus, i - period + 1, i + 1) / trSum;
    minus[i] = sum(vmMinus, i - period + 1, i + 1) / trSum;
  }
  return { plus, minus };
}

/** Ulcer index (drawdown-based risk measure). */
export function ulcer(values, period = 14) {
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i += 1) {
    const w = values.slice(i - period + 1, i + 1);
    let peak = -Infinity;
    let acc = 0;
    for (const v of w) {
      peak = Math.max(peak, v);
      acc += peak === 0 ? 0 : ((v - peak) / peak) ** 2;
    }
    out[i] = Math.sqrt(acc / period) * 100;
  }
  return out;
}

/** Chandelier exit (long side). */
export function chandelierExit(candles, period = 22, mult = 3) {
  const h = highs(candles);
  const a = atr(candles, period);
  const out = nulls(candles.length);
  for (let i = period - 1; i < candles.length; i += 1) {
    const hh = highest(h, i - period + 1, i + 1);
    out[i] = isNum(a[i]) ? hh - mult * a[i] : null;
  }
  return out;
}

/* ----------------------------------------------------------------- volume */

/** On Balance Volume. */
export function obv(candles) {
  const out = nulls(candles.length);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const d = candles[i].close - candles[i - 1].close;
    acc += d > 0 ? candles[i].volume : d < 0 ? -candles[i].volume : 0;
    out[i] = acc;
  }
  return out;
}

/** Money Flow Index. */
export function mfi(candles, period = 14) {
  const n = candles.length;
  const pos = nulls(n);
  const neg = nulls(n);
  for (let i = 1; i < n; i += 1) {
    const flow = typical(candles[i]) * candles[i].volume;
    const up = typical(candles[i]) > typical(candles[i - 1]);
    pos[i] = up ? flow : 0;
    neg[i] = up ? 0 : flow;
  }
  const out = nulls(n);
  for (let i = period; i < n; i += 1) {
    const p = sum(pos, i - period + 1, i + 1);
    const m = sum(neg, i - period + 1, i + 1);
    out[i] = m === 0 ? 100 : 100 - 100 / (1 + p / m);
  }
  return out;
}

/** Chaikin Money Flow. */
export function cmf(candles, period = 20) {
  const n = candles.length;
  const mfv = candles.map((c) => {
    const range = c.high - c.low;
    const m = range === 0 ? 0 : ((c.close - c.low) - (c.high - c.close)) / range;
    return m * c.volume;
  });
  const out = nulls(n);
  for (let i = period - 1; i < n; i += 1) {
    const v = sum(volumes(candles), i - period + 1, i + 1);
    out[i] = v === 0 ? 0 : sum(mfv, i - period + 1, i + 1) / v;
  }
  return out;
}

/** Accumulation / Distribution line. */
export function adLine(candles) {
  const out = nulls(candles.length);
  let acc = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const range = c.high - c.low;
    const m = range === 0 ? 0 : ((c.close - c.low) - (c.high - c.close)) / range;
    acc += m * c.volume;
    out[i] = acc;
  }
  return out;
}

/** Ease of Movement. */
export function eom(candles, period = 14) {
  const n = candles.length;
  const raw = nulls(n);
  for (let i = 1; i < n; i += 1) {
    const dm = (candles[i].high + candles[i].low) / 2 - (candles[i - 1].high + candles[i - 1].low) / 2;
    const range = candles[i].high - candles[i].low;
    const br = candles[i].volume === 0 ? 0 : candles[i].volume / 1e8 / Math.max(range, 1e-9);
    raw[i] = br === 0 ? 0 : dm / br;
  }
  return sma(raw.filter(isNum), period).reduce((acc, v, i) => {
    acc[i + (n - raw.filter(isNum).length)] = v;
    return acc;
  }, nulls(n));
}

/** Force index. */
export function forceIndex(candles, period = 13) {
  const raw = candles.map((c, i) => (i === 0 ? 0 : (c.close - candles[i - 1].close) * c.volume));
  return ema(raw, period);
}

/** Know Sure Thing. */
export function kst(values, periods = [10, 15, 20, 30], smas = [10, 10, 10, 15], signalPeriod = 9) {
  const rocs = periods.map((p) => sma(roc(values, p).map((v) => (isNum(v) ? v : 0)), smas[periods.indexOf(p)]));
  const kstLine = values.map((_, i) => {
    const vals = rocs.map((r) => r[i]);
    if (vals.some((v) => !isNum(v))) return null;
    return vals[0] * 1 + vals[1] * 2 + vals[2] * 3 + vals[3] * 4;
  });
  const dense = kstLine.filter(isNum);
  return { kst: kstLine, signal: realign(sma(dense, signalPeriod), kstLine) };
}

/** Volume ratio vs its own average. */
export function volumeRatio(candles, period = 20) {
  const v = volumes(candles);
  const avg = sma(v, period);
  return v.map((x, i) => (isNum(avg[i]) && avg[i] > 0 ? x / avg[i] : null));
}

/* ---------------------------------------------------- statistics & math */

/** Linear regression over a rolling window -> { slope, intercept, r2, value }. */
export function linreg(values, period = 20) {
  const out = { slope: nulls(values.length), intercept: nulls(values.length), r2: nulls(values.length), value: nulls(values.length) };
  for (let i = period - 1; i < values.length; i += 1) {
    const w = values.slice(i - period + 1, i + 1);
    const xm = (period - 1) / 2;
    const ym = mean(w);
    let num = 0;
    let den = 0;
    for (let k = 0; k < period; k += 1) {
      num += (k - xm) * (w[k] - ym);
      den += (k - xm) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = ym - slope * xm;
    let ssTot = 0;
    let ssRes = 0;
    for (let k = 0; k < period; k += 1) {
      ssTot += (w[k] - ym) ** 2;
      ssRes += (w[k] - (intercept + slope * k)) ** 2;
    }
    out.slope[i] = slope;
    out.intercept[i] = intercept;
    out.r2[i] = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    out.value[i] = intercept + slope * (period - 1);
  }
  return out;
}

/** Z-score of price vs its rolling mean/stdev. */
export function zscore(values, period = 20) {
  const m = sma(values, period);
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i += 1) {
    const sd = stdev(values.slice(i - period + 1, i + 1));
    out[i] = sd === 0 ? 0 : (values[i] - m[i]) / sd;
  }
  return out;
}

/** Rolling Pearson correlation of two equal-length series. */
export function correlation(a, b, period = 20) {
  const out = nulls(Math.min(a.length, b.length));
  const n = out.length;
  for (let i = period - 1; i < n; i += 1) {
    const wa = a.slice(i - period + 1, i + 1);
    const wb = b.slice(i - period + 1, i + 1);
    if (wa.some((v) => !isNum(v)) || wb.some((v) => !isNum(v))) continue;
    const ma = mean(wa);
    const mb = mean(wb);
    let num = 0;
    let da = 0;
    let db = 0;
    for (let k = 0; k < period; k += 1) {
      num += (wa[k] - ma) * (wb[k] - mb);
      da += (wa[k] - ma) ** 2;
      db += (wb[k] - mb) ** 2;
    }
    out[i] = da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
  }
  return out;
}

/** Percentile rank of the current value within its rolling window (0..100). */
export function percentRank(values, period = 20) {
  return rolling(values, period, (w) => {
    const v = w[w.length - 1];
    let below = 0;
    for (const x of w) if (x < v) below += 1;
    return (below / (w.length - 1 || 1)) * 100;
  });
}

/** Rolling drawdown from the running peak, in percent (negative). */
export function drawdownSeries(values) {
  let peak = -Infinity;
  return values.map((v) => {
    peak = Math.max(peak, v);
    return peak === 0 ? 0 : ((v - peak) / peak) * 100;
  });
}

/* -------------------------------------------------------------- patterns */

export function crossOver(a, b, offset = 0) {
  const i = a.length - 1 - offset;
  const j = i - 1;
  if (j < 0 || !isNum(a[i]) || !isNum(b[i]) || !isNum(a[j]) || !isNum(b[j])) return false;
  return a[j] <= b[j] && a[i] > b[i];
}

export function crossUnder(a, b, offset = 0) {
  const i = a.length - 1 - offset;
  const j = i - 1;
  if (j < 0 || !isNum(a[i]) || !isNum(b[i]) || !isNum(a[j]) || !isNum(b[j])) return false;
  return a[j] >= b[j] && a[i] < b[i];
}

export function rising(series, bars = 3, offset = 0) {
  for (let k = 0; k < bars; k += 1) {
    const i = series.length - 1 - offset - k;
    const j = i - 1;
    if (j < 0 || !isNum(series[i]) || !isNum(series[j]) || series[i] <= series[j]) return false;
  }
  return true;
}

export function falling(series, bars = 3, offset = 0) {
  for (let k = 0; k < bars; k += 1) {
    const i = series.length - 1 - offset - k;
    const j = i - 1;
    if (j < 0 || !isNum(series[i]) || !isNum(series[j]) || series[i] >= series[j]) return false;
  }
  return true;
}

/** Heikin-Ashi candles (smoother trend representation). */
export function heikinAshi(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: c.time, open, close, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), volume: c.volume });
  }
  return out;
}

/** Swing pivot highs/lows -> arrays of { index, price, time }. */
export function swingPoints(candles, left = 2, right = 2) {
  const highsOut = [];
  const lowsOut = [];
  for (let i = left; i < candles.length - right; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - left; k <= i + right; k += 1) {
      if (k === i) continue;
      if (candles[k].high >= candles[i].high) isHigh = false;
      if (candles[k].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highsOut.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isLow) lowsOut.push({ index: i, price: candles[i].low, time: candles[i].time });
  }
  return { highs: highsOut, lows: lowsOut };
}

/**
 * Simple support/resistance detection via pivot clustering.
 * Returns { supports: [price], resistances: [price] } sorted by strength.
 */
export function supportResistance(candles, lookback = 3, maxLevels = 5, tolerancePct = 0.5) {
  const { highs: ph, lows: pl } = swingPoints(candles, lookback, lookback);
  const price = candles.length ? candles[candles.length - 1].close : 0;
  const cluster = (pts) => {
    const levels = [];
    for (const p of pts) {
      const hit = levels.find((l) => Math.abs(l.price - p.price) / p.price * 100 <= tolerancePct);
      if (hit) {
        hit.price = (hit.price * hit.count + p.price) / (hit.count + 1);
        hit.count += 1;
      } else {
        levels.push({ price: p.price, count: 1 });
      }
    }
    return levels.sort((a, b) => b.count - a.count).slice(0, maxLevels).map((l) => l.price);
  };
  const supports = cluster(pl).filter((p) => p < price).sort((a, b) => b - a);
  const resistances = cluster(ph).filter((p) => p > price).sort((a, b) => a - b);
  return { supports, resistances };
}

/** Classic pivot points from the previous candle. */
export function pivotPoints(candle) {
  const { high: h, low: l, close: c } = candle;
  const p = (h + l + c) / 3;
  return {
    p,
    r1: 2 * p - l,
    s1: 2 * p - h,
    r2: p + (h - l),
    s2: p - (h - l),
    r3: h + 2 * (p - l),
    s3: l - 2 * (h - p),
  };
}

/** Fibonacci retracement levels between a low and a high. */
export function fibLevels(low, high) {
  const d = high - low;
  return {
    '0.0': low,
    '0.236': low + d * 0.236,
    '0.382': low + d * 0.382,
    '0.5': low + d * 0.5,
    '0.618': low + d * 0.618,
    '0.786': low + d * 0.786,
    '1.0': high,
    '1.272': low + d * 1.272,
    '1.618': low + d * 1.618,
  };
}

/** Candlestick pattern detection at the last bar. Returns array of pattern ids. */
export function candlePatterns(candles) {
  const n = candles.length;
  if (n < 3) return [];
  const c = candles[n - 1];
  const p = candles[n - 2];
  const p2 = candles[n - 3];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 1e-9;
  const upper = c.high - Math.max(c.close, c.open);
  const lower = Math.min(c.close, c.open) - c.low;
  const bull = c.close > c.open;
  const pBody = Math.abs(p.close - p.open);
  const found = [];
  if (body / range < 0.1) found.push('doji');
  if (lower > body * 2 && upper < body) found.push(bull ? 'hammer' : 'hanging_man');
  if (upper > body * 2 && lower < body) found.push(bull ? 'inverted_hammer' : 'shooting_star');
  if (body / range > 0.85) found.push(bull ? 'bullish_marubozu' : 'bearish_marubozu');
  if (bull && p.close < p.open && c.close > p.open && c.open < p.close) found.push('bullish_engulfing');
  if (!bull && p.close > p.open && c.close < p.open && c.open > p.close) found.push('bearish_engulfing');
  if (bull && p.close < p.open && c.open < p.close && c.close > (p.open + p.close) / 2) found.push('piercing_line');
  if (!bull && p.close > p.open && c.open > p.close && c.close < (p.open + p.close) / 2) found.push('dark_cloud_cover');
  if (pBody > 0 && body < pBody * 0.4) found.push(bull ? 'bullish_harami' : 'bearish_harami');
  const p2Body = Math.abs(p2.close - p2.open);
  if (p2.close < p2.open && Math.abs(p.close - p.open) < p2Body * 0.5 && bull && c.close > p2.open) found.push('morning_star');
  if (p2.close > p2.open && Math.abs(p.close - p.open) < p2Body * 0.5 && !bull && c.close < p2.open) found.push('evening_star');
  const threeUp = bull && p.close > p.open && p2.close > p2.open && c.close > p.close && p.close > p2.close;
  if (threeUp) found.push('three_white_soldiers');
  const threeDown = !bull && p.close < p.open && p2.close < p2.open && c.close < p.close && p.close < p2.close;
  if (threeDown) found.push('three_black_crows');
  return found;
}

/**
 * Divergence detection between price and an oscillator.
 * Compares the last two price pivots with the oscillator at the same bars.
 * Returns 'bullish' | 'bearish' | 'hidden_bullish' | 'hidden_bearish' | null.
 */
export function divergence(candles, oscillator, { left = 2, right = 2 } = {}) {
  const { highs: ph, lows: pl } = swingPoints(candles, left, right);
  const lastTwo = (arr) => (arr.length >= 2 ? arr.slice(-2) : null);
  const hl = lastTwo(ph);
  const ll = lastTwo(pl);
  if (ll) {
    const [a, b] = ll;
    const oa = oscillator[a.index];
    const ob = oscillator[b.index];
    if (isNum(oa) && isNum(ob)) {
      if (b.price < a.price && ob > oa) return 'bullish';
      if (b.price > a.price && ob < oa) return 'hidden_bullish';
    }
  }
  if (hl) {
    const [a, b] = hl;
    const oa = oscillator[a.index];
    const ob = oscillator[b.index];
    if (isNum(oa) && isNum(ob)) {
      if (b.price > a.price && ob < oa) return 'bearish';
      if (b.price < a.price && ob > oa) return 'hidden_bearish';
    }
  }
  return null;
}

/** Volume profile: price buckets with traded volume. */
export function volumeProfile(candles, buckets = 24) {
  if (!candles.length) return { buckets: [], poc: null, valueArea: [null, null] };
  const hi = highest(highs(candles));
  const lo = lowest(lows(candles));
  const step = (hi - lo) / buckets || 1;
  const acc = new Array(buckets).fill(0);
  for (const c of candles) {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((typical(c) - lo) / step)));
    acc[idx] += c.volume;
  }
  const total = sum(acc);
  const order = acc.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
  const target = total * 0.7;
  let running = 0;
  const picked = [];
  for (const o of order) {
    picked.push(o.i);
    running += o.v;
    if (running >= target) break;
  }
  const loIdx = Math.min(...picked);
  const hiIdx = Math.max(...picked);
  return {
    buckets: acc.map((v, i) => ({ price: lo + step * (i + 0.5), volume: v })),
    poc: lo + step * (order[0].i + 0.5),
    valueArea: [lo + step * loIdx, lo + step * (hiIdx + 1)],
  };
}

/* ------------------------------------------------------------ convenience */

/** Percentage change between the last value and `bars` ago. */
export function percentChange(values, bars = 1) {
  const out = nulls(values.length);
  for (let i = bars; i < values.length; i += 1) {
    const base = values[i - bars];
    out[i] = base === 0 ? null : ((values[i] - base) / base) * 100;
  }
  return out;
}

/** Median of a numeric array. */
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Registry of every indicator, used by the UI to build condition menus. */
export const INDICATOR_REGISTRY = [
  { id: 'price', label: 'Cena (close)', group: 'price', fn: (c) => closes(c), params: [] },
  { id: 'open', label: 'Open', group: 'price', fn: (c) => opens(c), params: [] },
  { id: 'high', label: 'High', group: 'price', fn: (c) => highs(c), params: [] },
  { id: 'low', label: 'Low', group: 'price', fn: (c) => lows(c), params: [] },
  { id: 'volume', label: 'Objem', group: 'volume', fn: (c) => volumes(c), params: [] },
  { id: 'change_pct', label: 'Zmena ceny %', group: 'price', fn: (c, p) => percentChange(closes(c), p.bars ?? 1), params: [{ key: 'bars', def: 1, min: 1, max: 500 }] },
  { id: 'sma', label: 'SMA', group: 'trend', fn: (c, p) => sma(closes(c), p.period), params: [{ key: 'period', def: 20, min: 2, max: 400 }] },
  { id: 'ema', label: 'EMA', group: 'trend', fn: (c, p) => ema(closes(c), p.period), params: [{ key: 'period', def: 20, min: 2, max: 400 }] },
  { id: 'wma', label: 'WMA', group: 'trend', fn: (c, p) => wma(closes(c), p.period), params: [{ key: 'period', def: 20, min: 2, max: 400 }] },
  { id: 'dema', label: 'DEMA', group: 'trend', fn: (c, p) => dema(closes(c), p.period), params: [{ key: 'period', def: 20, min: 2, max: 400 }] },
  { id: 'tema', label: 'TEMA', group: 'trend', fn: (c, p) => tema(closes(c), p.period), params: [{ key: 'period', def: 20, min: 2, max: 400 }] },
  { id: 'hma', label: 'HMA', group: 'trend', fn: (c, p) => hma(closes(c), p.period), params: [{ key: 'period', def: 16, min: 3, max: 400 }] },
  { id: 'kama', label: 'KAMA', group: 'trend', fn: (c, p) => kama(closes(c), p.period), params: [{ key: 'period', def: 10, min: 2, max: 400 }] },
  { id: 'vwma', label: 'VWMA', group: 'trend', fn: (c, p) => vwma(c, p.period), params: [{ key: 'period', def: 20, min: 2, max: 400 }] },
  { id: 'vwap', label: 'VWAP', group: 'trend', fn: (c) => vwap(c), params: [] },
  { id: 'rsi', label: 'RSI', group: 'momentum', fn: (c, p) => rsi(closes(c), p.period), params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'macd', label: 'MACD línia', group: 'momentum', fn: (c, p) => macd(closes(c), p.fast, p.slow, p.signal).macd, params: [{ key: 'fast', def: 12, min: 2, max: 100 }, { key: 'slow', def: 26, min: 3, max: 200 }, { key: 'signal', def: 9, min: 2, max: 100 }] },
  { id: 'macd_signal', label: 'MACD signál', group: 'momentum', fn: (c, p) => macd(closes(c), p.fast, p.slow, p.signal).signal, params: [{ key: 'fast', def: 12, min: 2, max: 100 }, { key: 'slow', def: 26, min: 3, max: 200 }, { key: 'signal', def: 9, min: 2, max: 100 }] },
  { id: 'macd_hist', label: 'MACD histogram', group: 'momentum', fn: (c, p) => macd(closes(c), p.fast, p.slow, p.signal).histogram, params: [{ key: 'fast', def: 12, min: 2, max: 100 }, { key: 'slow', def: 26, min: 3, max: 200 }, { key: 'signal', def: 9, min: 2, max: 100 }] },
  { id: 'stoch_k', label: 'Stochastic %K', group: 'momentum', fn: (c, p) => stochastic(c, p.k, p.d, p.smooth).k, params: [{ key: 'k', def: 14, min: 2, max: 100 }, { key: 'd', def: 3, min: 1, max: 50 }, { key: 'smooth', def: 3, min: 1, max: 50 }] },
  { id: 'stoch_d', label: 'Stochastic %D', group: 'momentum', fn: (c, p) => stochastic(c, p.k, p.d, p.smooth).d, params: [{ key: 'k', def: 14, min: 2, max: 100 }, { key: 'd', def: 3, min: 1, max: 50 }, { key: 'smooth', def: 3, min: 1, max: 50 }] },
  { id: 'stoch_rsi_k', label: 'Stoch RSI %K', group: 'momentum', fn: (c, p) => stochRsi(closes(c), p.rsi, p.stoch, p.k, p.d).k, params: [{ key: 'rsi', def: 14, min: 2, max: 100 }, { key: 'stoch', def: 14, min: 2, max: 100 }, { key: 'k', def: 3, min: 1, max: 50 }, { key: 'd', def: 3, min: 1, max: 50 }] },
  { id: 'stoch_rsi_d', label: 'Stoch RSI %D', group: 'momentum', fn: (c, p) => stochRsi(closes(c), p.rsi, p.stoch, p.k, p.d).d, params: [{ key: 'rsi', def: 14, min: 2, max: 100 }, { key: 'stoch', def: 14, min: 2, max: 100 }, { key: 'k', def: 3, min: 1, max: 50 }, { key: 'd', def: 3, min: 1, max: 50 }] },
  { id: 'vortex_plus', label: 'Vortex VI+', group: 'trend', fn: (c, p) => vortex(c, p.period).plus, params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'vortex_minus', label: 'Vortex VI-', group: 'trend', fn: (c, p) => vortex(c, p.period).minus, params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'kst', label: 'KST', group: 'momentum', fn: (c) => kst(closes(c)).kst, params: [] },
  { id: 'kst_signal', label: 'KST signál', group: 'momentum', fn: (c) => kst(closes(c)).signal, params: [] },
  { id: 'cci', label: 'CCI', group: 'momentum', fn: (c, p) => cci(c, p.period), params: [{ key: 'period', def: 20, min: 2, max: 200 }] },
  { id: 'williams_r', label: 'Williams %R', group: 'momentum', fn: (c, p) => williamsR(c, p.period), params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'roc', label: 'ROC %', group: 'momentum', fn: (c, p) => roc(closes(c), p.period), params: [{ key: 'period', def: 9, min: 1, max: 200 }] },
  { id: 'momentum', label: 'Momentum', group: 'momentum', fn: (c, p) => momentum(closes(c), p.period), params: [{ key: 'period', def: 10, min: 1, max: 200 }] },
  { id: 'trix', label: 'TRIX', group: 'momentum', fn: (c, p) => trix(closes(c), p.period), params: [{ key: 'period', def: 15, min: 2, max: 200 }] },
  { id: 'dpo', label: 'DPO', group: 'momentum', fn: (c, p) => dpo(closes(c), p.period), params: [{ key: 'period', def: 20, min: 3, max: 200 }] },
  { id: 'boll_upper', label: 'Bollinger horná', group: 'volatility', fn: (c, p) => bollinger(closes(c), p.period, p.mult).upper, params: [{ key: 'period', def: 20, min: 2, max: 200 }, { key: 'mult', def: 2, min: 0.5, max: 6 }] },
  { id: 'boll_middle', label: 'Bollinger stred', group: 'volatility', fn: (c, p) => bollinger(closes(c), p.period, p.mult).middle, params: [{ key: 'period', def: 20, min: 2, max: 200 }, { key: 'mult', def: 2, min: 0.5, max: 6 }] },
  { id: 'boll_lower', label: 'Bollinger dolná', group: 'volatility', fn: (c, p) => bollinger(closes(c), p.period, p.mult).lower, params: [{ key: 'period', def: 20, min: 2, max: 200 }, { key: 'mult', def: 2, min: 0.5, max: 6 }] },
  { id: 'boll_bw', label: 'Bollinger šírka', group: 'volatility', fn: (c, p) => bollinger(closes(c), p.period, p.mult).bandwidth, params: [{ key: 'period', def: 20, min: 2, max: 200 }, { key: 'mult', def: 2, min: 0.5, max: 6 }] },
  { id: 'boll_pb', label: 'Bollinger %B', group: 'volatility', fn: (c, p) => bollinger(closes(c), p.period, p.mult).percentB, params: [{ key: 'period', def: 20, min: 2, max: 200 }, { key: 'mult', def: 2, min: 0.5, max: 6 }] },
  { id: 'atr', label: 'ATR', group: 'volatility', fn: (c, p) => atr(c, p.period), params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'natr', label: 'NATR %', group: 'volatility', fn: (c, p) => natr(c, p.period), params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'keltner_upper', label: 'Keltner horná', group: 'volatility', fn: (c, p) => keltner(c, p.period, p.mult).upper, params: [{ key: 'period', def: 20, min: 2, max: 200 }, { key: 'mult', def: 2, min: 0.5, max: 6 }] },
  { id: 'keltner_lower', label: 'Keltner dolná', group: 'volatility', fn: (c, p) => keltner(c, p.period, p.mult).lower, params: [{ key: 'period', def: 20, min: 2, max: 200 }, { key: 'mult', def: 2, min: 0.5, max: 6 }] },
  { id: 'donchian_upper', label: 'Donchian horná', group: 'breakout', fn: (c, p) => donchian(c, p.period).upper, params: [{ key: 'period', def: 20, min: 2, max: 400 }] },
  { id: 'donchian_lower', label: 'Donchian dolná', group: 'breakout', fn: (c, p) => donchian(c, p.period).lower, params: [{ key: 'period', def: 20, min: 2, max: 400 }] },
  { id: 'adx', label: 'ADX', group: 'trend', fn: (c, p) => adx(c, p.period).adx, params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'plus_di', label: '+DI', group: 'trend', fn: (c, p) => adx(c, p.period).plusDI, params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'minus_di', label: '-DI', group: 'trend', fn: (c, p) => adx(c, p.period).minusDI, params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'aroon_up', label: 'Aroon Up', group: 'trend', fn: (c, p) => aroon(c, p.period).up, params: [{ key: 'period', def: 25, min: 2, max: 200 }] },
  { id: 'aroon_down', label: 'Aroon Down', group: 'trend', fn: (c, p) => aroon(c, p.period).down, params: [{ key: 'period', def: 25, min: 2, max: 200 }] },
  { id: 'psar', label: 'Parabolic SAR', group: 'trend', fn: (c, p) => psar(c, p.step, p.max), params: [{ key: 'step', def: 0.02, min: 0.001, max: 0.5 }, { key: 'max', def: 0.2, min: 0.01, max: 1 }] },
  { id: 'supertrend', label: 'Supertrend', group: 'trend', fn: (c, p) => supertrend(c, p.period, p.mult).line, params: [{ key: 'period', def: 10, min: 1, max: 200 }, { key: 'mult', def: 3, min: 0.5, max: 10 }] },
  { id: 'ichimoku_tenkan', label: 'Ichimoku Tenkan', group: 'trend', fn: (c, p) => ichimoku(c, p.tenkan, p.kijun, p.senkou).tenkan, params: [{ key: 'tenkan', def: 9, min: 2, max: 100 }, { key: 'kijun', def: 26, min: 3, max: 200 }, { key: 'senkou', def: 52, min: 4, max: 400 }] },
  { id: 'ichimoku_kijun', label: 'Ichimoku Kijun', group: 'trend', fn: (c, p) => ichimoku(c, p.tenkan, p.kijun, p.senkou).kijun, params: [{ key: 'tenkan', def: 9, min: 2, max: 100 }, { key: 'kijun', def: 26, min: 3, max: 200 }, { key: 'senkou', def: 52, min: 4, max: 400 }] },
  { id: 'obv', label: 'OBV', group: 'volume', fn: (c) => obv(c), params: [] },
  { id: 'mfi', label: 'MFI', group: 'volume', fn: (c, p) => mfi(c, p.period), params: [{ key: 'period', def: 14, min: 2, max: 200 }] },
  { id: 'cmf', label: 'Chaikin MF', group: 'volume', fn: (c, p) => cmf(c, p.period), params: [{ key: 'period', def: 20, min: 2, max: 200 }] },
  { id: 'volume_ratio', label: 'Objem / priemer', group: 'volume', fn: (c, p) => volumeRatio(c, p.period), params: [{ key: 'period', def: 20, min: 2, max: 200 }] },
  { id: 'zscore', label: 'Z-Score', group: 'stats', fn: (c, p) => zscore(closes(c), p.period), params: [{ key: 'period', def: 20, min: 3, max: 400 }] },
  { id: 'percent_rank', label: 'Percentil ceny', group: 'stats', fn: (c, p) => percentRank(closes(c), p.period), params: [{ key: 'period', def: 100, min: 3, max: 1000 }] },
  { id: 'linreg_slope', label: 'Sklon regresie', group: 'stats', fn: (c, p) => linreg(closes(c), p.period).slope, params: [{ key: 'period', def: 20, min: 3, max: 400 }] },
  { id: 'linreg_r2', label: 'Regresia R²', group: 'stats', fn: (c, p) => linreg(closes(c), p.period).r2, params: [{ key: 'period', def: 20, min: 3, max: 400 }] },
  { id: 'ulcer', label: 'Ulcer Index', group: 'stats', fn: (c, p) => ulcer(closes(c), p.period), params: [{ key: 'period', def: 14, min: 3, max: 400 }] },
  { id: 'chandelier', label: 'Chandelier Exit', group: 'volatility', fn: (c, p) => chandelierExit(c, p.period, p.mult), params: [{ key: 'period', def: 22, min: 2, max: 200 }, { key: 'mult', def: 3, min: 0.5, max: 10 }] },
  { id: 'highest', label: 'Maximum N', group: 'stats', fn: (c, p) => rolling(closes(c), p.period, (w) => Math.max(...w)), params: [{ key: 'period', def: 20, min: 2, max: 1000 }] },
  { id: 'lowest', label: 'Minimum N', group: 'stats', fn: (c, p) => rolling(closes(c), p.period, (w) => Math.min(...w)), params: [{ key: 'period', def: 20, min: 2, max: 1000 }] },
];

export const INDICATOR_IDS = INDICATOR_REGISTRY.map((i) => i.id);

/** Compute an indicator series by registry id. Throws on unknown id. */
export function computeIndicator(id, candles, params = {}) {
  const def = INDICATOR_REGISTRY.find((i) => i.id === id);
  if (!def) throw new Error(`Unknown indicator: ${id}`);
  const merged = { ...Object.fromEntries(def.params.map((p) => [p.key, p.def])), ...params };
  return def.fn(candles, merged);
}
