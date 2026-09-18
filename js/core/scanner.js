/**
 * scanner.js — deterministic multi-symbol market scanner.
 *
 * Pure functions only: candles in, ranked signals out. No DOM, no network and
 * no global state, so the whole scanner is testable under `node --test`.
 */

import {
  bollinger, closes, crossOver, crossUnder, ema, highest, isNum, last, lowest,
  macd, natr, roc, rsi, sum, volumes,
} from './indicators.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const pctChange = (current, base) => (base ? ((current - base) / base) * 100 : 0);

/** Signal families — the UI groups and colours results by these. */
export const SCAN_FAMILIES = {
  reversal: 'Reversal',
  trend: 'Trend',
  breakout: 'Breakout',
  volume: 'Objem',
  momentum: 'Momentum',
  volatility: 'Volatilita',
};

/* ------------------------------------------------------------------ helpers */

/** Percentile rank (0-100) of `value` inside `values`. */
export function percentileOf(values, value) {
  const clean = (values ?? []).filter(isNum);
  if (!clean.length || !isNum(value)) return null;
  const below = clean.filter((v) => v < value).length;
  return (below / clean.length) * 100;
}

/** Linearly interpolated quantile (0-100) of `values`. */
export function quantileOf(values, q) {
  const clean = (values ?? []).filter(isNum).slice().sort((a, b) => a - b);
  if (!clean.length) return null;
  const pos = ((clean.length - 1) * Math.max(0, Math.min(100, q))) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return clean[lo];
  return clean[lo] + (clean[hi] - clean[lo]) * (pos - lo);
}

function lastClose(candles) {
  return candles.length ? candles[candles.length - 1].close : null;
}

/** Average volume of `period` bars ending `offset` bars before the last one. */
function priorAverageVolume(candles, period, offset = 1) {
  const v = volumes(candles);
  const end = v.length - offset;
  const start = end - period;
  if (start < 0 || end <= start) return null;
  const avg = sum(v, start, end) / period;
  return avg > 0 ? avg : null;
}

/**
 * A market with (almost) no range is dead: reversal and volatility presets
 * must not fire on it. ATR below 0.01 % of price counts as dead.
 */
function isAlive(candles, minAtrPct = 0.01) {
  const value = last(natr(candles, 14));
  return isNum(value) && value >= minAtrPct;
}

/* ----------------------------------------------------------------- presets */

/**
 * Every preset is `{ id, name, family, description, warmup, evaluate(candles, params) }`.
 * `evaluate` returns `null` (no signal) or `{ strength: 0..1, detail: string }`.
 */
export const SCAN_PRESETS = [
  {
    id: 'rsi_oversold',
    name: 'RSI pod prahom',
    family: 'reversal',
    description: 'RSI(14) klesne pod 30 — možné dno a odraz.',
    warmup: 20,
    evaluate(candles, params = {}) {
      if (!isAlive(candles)) return null;
      const period = params.period ?? 14;
      const threshold = params.threshold ?? 30;
      const value = last(rsi(closes(candles), period));
      if (!isNum(value) || value >= threshold) return null;
      return {
        strength: clamp01((threshold - value) / threshold),
        detail: `RSI(${period}) ${value.toFixed(1)} < ${threshold}`,
      };
    },
  },
  {
    id: 'rsi_overbought',
    name: 'RSI nad prahom',
    family: 'reversal',
    description: 'RSI(14) stúpne nad 70 — možné prehriatie.',
    warmup: 20,
    evaluate(candles, params = {}) {
      if (!isAlive(candles)) return null;
      const period = params.period ?? 14;
      const threshold = params.threshold ?? 70;
      const value = last(rsi(closes(candles), period));
      if (!isNum(value) || value <= threshold) return null;
      return {
        strength: clamp01((value - threshold) / (100 - threshold)),
        detail: `RSI(${period}) ${value.toFixed(1)} > ${threshold}`,
      };
    },
  },
  {
    id: 'trend_up',
    name: 'Rastúci trend',
    family: 'trend',
    description: 'EMA20 > EMA50 > EMA200 a cena nad EMA20.',
    warmup: 60,
    evaluate(candles, params = {}) {
      const c = closes(candles);
      const fast = params.fast ?? 20;
      const mid = params.mid ?? 50;
      const slow = params.slow ?? 200;
      const f = last(ema(c, fast));
      const m = last(ema(c, mid));
      const s = last(ema(c, slow));
      const price = lastClose(candles);
      if (![f, m, s, price].every(isNum) || !(f > m && m > s && price > f)) return null;
      return {
        strength: clamp01(pctChange(f, s) / 8),
        detail: `EMA${fast} ${f.toFixed(2)} > EMA${mid} ${m.toFixed(2)} > EMA${slow} ${s.toFixed(2)}`,
      };
    },
  },
  {
    id: 'trend_down',
    name: 'Klesajúci trend',
    family: 'trend',
    description: 'EMA20 < EMA50 < EMA200 a cena pod EMA20.',
    warmup: 60,
    evaluate(candles, params = {}) {
      const c = closes(candles);
      const fast = params.fast ?? 20;
      const mid = params.mid ?? 50;
      const slow = params.slow ?? 200;
      const f = last(ema(c, fast));
      const m = last(ema(c, mid));
      const s = last(ema(c, slow));
      const price = lastClose(candles);
      if (![f, m, s, price].every(isNum) || !(f < m && m < s && price < f)) return null;
      return {
        strength: clamp01(-pctChange(f, s) / 8),
        detail: `EMA${fast} ${f.toFixed(2)} < EMA${mid} ${m.toFixed(2)} < EMA${slow} ${s.toFixed(2)}`,
      };
    },
  },
  {
    id: 'pullback_uptrend',
    name: 'Pullback v raste',
    family: 'trend',
    description: 'Cena pod EMA20, ale EMA50 > EMA200 a RSI je v neutrále (35-55).',
    warmup: 60,
    evaluate(candles, params = {}) {
      const c = closes(candles);
      const e20 = last(ema(c, params.fast ?? 20));
      const e50 = last(ema(c, params.mid ?? 50));
      const e200 = last(ema(c, params.slow ?? 200));
      const price = lastClose(candles);
      const r = last(rsi(c, 14));
      const lo = params.lowRsi ?? 35;
      const hi = params.highRsi ?? 55;
      if (![e20, e50, e200, price, r].every(isNum)) return null;
      if (!(e50 > e200 && price < e20 && r >= lo && r <= hi)) return null;
      const distance = pctChange(e20, price);
      return {
        strength: clamp01(0.5 + distance / 5),
        detail: `cena ${price.toFixed(4)} pod EMA20 ${e20.toFixed(4)}, RSI ${r.toFixed(1)}`,
      };
    },
  },
  {
    id: 'breakout_20',
    name: 'Breakout nad maximum',
    family: 'breakout',
    description: 'Close prekoná najvyššie high za posledných 20 sviečok.',
    warmup: 25,
    evaluate(candles, params = {}) {
      const period = params.period ?? 20;
      const n = candles.length;
      if (n < period + 2) return null;
      const priorHigh = highest(candles.map((c) => c.high), n - 1 - period, n - 1);
      const price = candles[n - 1].close;
      if (!isNum(priorHigh) || !(price > priorHigh)) return null;
      return {
        strength: clamp01(pctChange(price, priorHigh) / 2),
        detail: `close ${price.toFixed(4)} > high(${period}) ${priorHigh.toFixed(4)}`,
      };
    },
  },
  {
    id: 'breakdown_20',
    name: 'Breakdown pod minimum',
    family: 'breakout',
    description: 'Close prekoná najnižšie low za posledných 20 sviečok.',
    warmup: 25,
    evaluate(candles, params = {}) {
      const period = params.period ?? 20;
      const n = candles.length;
      if (n < period + 2) return null;
      const priorLow = lowest(candles.map((c) => c.low), n - 1 - period, n - 1);
      const price = candles[n - 1].close;
      if (!isNum(priorLow) || !(price < priorLow)) return null;
      return {
        strength: clamp01(-pctChange(price, priorLow) / 2),
        detail: `close ${price.toFixed(4)} < low(${period}) ${priorLow.toFixed(4)}`,
      };
    },
  },
  {
    id: 'volume_spike',
    name: 'Objemový spike',
    family: 'volume',
    description: 'Objem poslednej sviečky je aspoň 2x priemer predchádzajúcich 20.',
    warmup: 22,
    evaluate(candles, params = {}) {
      const period = params.period ?? 20;
      const mult = params.mult ?? 2;
      const avg = priorAverageVolume(candles, period);
      const cur = volumes(candles).at(-1);
      if (!avg || !isNum(cur)) return null;
      const ratio = cur / avg;
      if (ratio < mult) return null;
      return {
        strength: clamp01((ratio - mult) / mult),
        detail: `objem ${ratio.toFixed(2)}x priemer(${period})`,
      };
    },
  },
  {
    id: 'macd_bull_cross',
    name: 'MACD pretnutie nahor',
    family: 'momentum',
    description: 'MACD čiara pretne signálnu líniu nahor (v posledných 3 sviečkach).',
    warmup: 40,
    evaluate(candles, params = {}) {
      const bars = params.lookback ?? 3;
      const { macd: line, signal } = macd(closes(candles));
      for (let k = 0; k < bars; k += 1) {
        if (crossOver(line, signal, k)) {
          return {
            strength: clamp01(1 - k / Math.max(1, bars)),
            detail: `MACD pretnutie nahor (pred ${k + 1} sv.)`,
          };
        }
      }
      return null;
    },
  },
  {
    id: 'macd_bear_cross',
    name: 'MACD pretnutie nadol',
    family: 'momentum',
    description: 'MACD čiara pretne signálnu líniu nadol (v posledných 3 sviečkach).',
    warmup: 40,
    evaluate(candles, params = {}) {
      const bars = params.lookback ?? 3;
      const { macd: line, signal } = macd(closes(candles));
      for (let k = 0; k < bars; k += 1) {
        if (crossUnder(line, signal, k)) {
          return {
            strength: clamp01(1 - k / Math.max(1, bars)),
            detail: `MACD pretnutie nadol (pred ${k + 1} sv.)`,
          };
        }
      }
      return null;
    },
  },
  {
    id: 'bb_squeeze',
    name: 'Squeeze volatility',
    family: 'volatility',
    description: 'Šírka Bollingerovho pásma je pod 20. percentilom za posledných 120 sviečok.',
    warmup: 80,
    evaluate(candles, params = {}) {
      if (!isAlive(candles)) return null;
      const period = params.period ?? 20;
      const threshold = params.threshold ?? 20;
      const { bandwidth } = bollinger(closes(candles), period, 2);
      const valid = bandwidth.filter(isNum).slice(-120);
      if (valid.length < 60) return null;
      const current = valid[valid.length - 1];
      const cut = quantileOf(valid, threshold);
      if (!isNum(current) || !isNum(cut) || !(current < cut)) return null;
      return {
        strength: clamp01(1 - current / cut),
        detail: `šírka pásma ${current.toFixed(3)} pod ${threshold}. percentilom ${cut.toFixed(3)}`,
      };
    },
  },
  {
    id: 'momentum_burst',
    name: 'Momentum burst',
    family: 'momentum',
    description: 'ROC(10) nad 5 % a nadpriemerný objem (aspoň 1,2x).',
    warmup: 30,
    evaluate(candles, params = {}) {
      const period = params.period ?? 10;
      const minPct = params.minPct ?? 5;
      const r = last(roc(closes(candles), period));
      if (!isNum(r) || r < minPct) return null;
      const avg = priorAverageVolume(candles, params.volumePeriod ?? 20);
      const cur = volumes(candles).at(-1);
      const ratio = avg && isNum(cur) ? cur / avg : null;
      if (ratio === null || ratio < (params.minVolumeRatio ?? 1.2)) return null;
      return {
        strength: clamp01(r / (minPct * 3)),
        detail: `ROC(${period}) +${r.toFixed(2)} %, objem ${ratio.toFixed(2)}x`,
      };
    },
  },
];

export const SCANNER_DEFAULT_PRESETS = ['rsi_oversold', 'trend_up', 'breakout_20', 'volume_spike'];
export const SCANNER_PRESET_IDS = SCAN_PRESETS.map((p) => p.id);

export function getPreset(id) {
  return SCAN_PRESETS.find((p) => p.id === id) ?? null;
}

/* ------------------------------------------------------------------- scan */

/**
 * Scan one candle series.
 * @returns {{symbol:?string,candles:number,notReady:boolean,price:?number,changePct:?number,
 *   rsi:?number,atrPct:?number,trend:string,signals:Array,matched:number,score:number,presetCount:number}}
 */
export function scanSymbol(candles = [], { symbol = null, presetIds = null, params = {}, minBars = 200 } = {}) {
  const list = Array.isArray(candles) ? candles : [];
  const presets = presetIds?.length ? presetIds.map(getPreset).filter(Boolean) : SCAN_PRESETS;
  const signals = [];

  for (const preset of presets) {
    if (list.length < preset.warmup) continue;
    let hit = null;
    try {
      hit = preset.evaluate(list, params[preset.id] ?? {});
    } catch {
      hit = null;
    }
    if (!hit) continue;
    signals.push({
      id: preset.id,
      name: preset.name,
      family: preset.family,
      strength: Number(clamp01(hit.strength ?? 0).toFixed(4)),
      detail: hit.detail ?? preset.description,
    });
  }

  const strengths = signals.reduce((acc, s) => acc + s.strength, 0);
  const score = presets.length ? Number(((strengths / presets.length) * 100).toFixed(2)) : 0;
  const c = closes(list);
  const close = lastClose(list);
  const rsiNow = last(rsi(c, 14));
  const atrPct = last(natr(list, 14));
  const e50 = last(ema(c, 50));
  const e200 = last(ema(c, 200));
  let trend = 'unknown';
  if (isNum(e50) && isNum(e200)) {
    trend = e50 > e200 * 1.0005 ? 'up' : e50 < e200 * 0.9995 ? 'down' : 'side';
  }
  const base = c.length > 24 ? c[c.length - 25] : c[0];

  return {
    symbol: symbol ?? null,
    candles: list.length,
    notReady: list.length < minBars,
    price: close,
    changePct: isNum(close) && isNum(base) ? pctChange(close, base) : null,
    rsi: rsiNow,
    atrPct,
    trend,
    signals,
    matched: signals.length,
    score,
    presetCount: presets.length,
  };
}

/**
 * Scan many datasets: `[{ symbol, candles }]`.
 * Sorted: ready series first, then by score desc, then symbol asc.
 */
export function scanMarket({ datasets = [], presetIds = null, params = {}, minBars = 200 } = {}) {
  const results = [];
  for (const dataset of datasets) {
    if (!dataset || !Array.isArray(dataset.candles)) continue;
    results.push(scanSymbol(dataset.candles, { symbol: dataset.symbol, presetIds, params, minBars }));
  }
  results.sort((a, b) => (Number(a.notReady) - Number(b.notReady))
    || (b.score - a.score)
    || String(a.symbol).localeCompare(String(b.symbol)));
  return results;
}

/** Aggregate stats for the results header. */
export function summariseScan(results = []) {
  const ready = results.filter((r) => !r.notReady);
  const matched = ready.filter((r) => r.matched > 0);
  const top = [...ready].sort((a, b) => (b.score - a.score) || String(a.symbol).localeCompare(String(b.symbol)))[0];
  return {
    scanned: results.length,
    ready: ready.length,
    matched: matched.length,
    top: top?.symbol ?? null,
    avgScore: ready.length
      ? Number((ready.reduce((acc, r) => acc + r.score, 0) / ready.length).toFixed(2))
      : 0,
  };
}