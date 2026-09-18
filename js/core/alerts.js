/**
 * alerts.js — local price/indicator alerts.
 *
 * Pure model + evaluation: the UI owns scheduling; this module owns the rules.
 * Alerts are evaluated against candles that are already in memory and never
 * leave the browser. No notifications are sent to any third party.
 */

import {
  closes, crossOver, crossUnder, ema, highest, isNum, last, lowest, natr, rsi, volumes,
} from './indicators.js';

const pct = (current, base) => (base ? ((current - base) / base) * 100 : 0);

let alertSeq = 0;
function alertId() {
  alertSeq += 1;
  return `al_${Date.now().toString(36)}_${alertSeq.toString(36)}`;
}

/** Reset the id sequence (tests only). */
export const __alertSeq = () => alertSeq;

/* ------------------------------------------------------------------- kinds */

/**
 * Every kind carries its parameter schema so the UI can render a form without
 * hard-coding field lists.
 *
 * `{ id, label, description, warmup, params: { key: { label, default, min, step } },
 *    describe(alert), evaluate(alert, candles) }`
 */
export const ALERT_KINDS = [
  {
    id: 'price_above',
    label: 'Cena stúpne nad',
    description: 'Notifikuje, keď posledná cena prekoná zadanú hranicu.',
    warmup: 1,
    params: { value: { label: 'Hranica (USDT)', default: 100_000, min: 0, step: 'any' } },
    describe: (a) => `cena > ${a.params.value}`,
    evaluate(a, candles) {
      const price = candles.at(-1)?.close;
      if (!isNum(price)) return { triggered: false };
      return {
        triggered: price > a.params.value,
        value: price,
        message: `cena ${price} > ${a.params.value}`,
      };
    },
  },
  {
    id: 'price_below',
    label: 'Cena klesne pod',
    description: 'Notifikuje, keď posledná cena spadne pod zadanú hranicu.',
    warmup: 1,
    params: { value: { label: 'Hranica (USDT)', default: 50_000, min: 0, step: 'any' } },
    describe: (a) => `cena < ${a.params.value}`,
    evaluate(a, candles) {
      const price = candles.at(-1)?.close;
      if (!isNum(price)) return { triggered: false };
      return {
        triggered: price < a.params.value,
        value: price,
        message: `cena ${price} < ${a.params.value}`,
      };
    },
  },
  {
    id: 'change_pct_up',
    label: 'Rast o % za N sviečok',
    description: 'Notifikuje pri raste ceny o zadané percento za N sviečok.',
    warmup: 7,
    minBars: (a) => Math.max(1, Math.round(a.params.bars)) + 1,
    params: {
      pct: { label: '% rastu', default: 5, min: 0.01, step: 0.1 },
      bars: { label: 'Za N sviečok', default: 6, min: 1, step: 1 },
    },
    describe: (a) => `cena +${a.params.pct} % za ${a.params.bars} sviečok`,
    evaluate(a, candles) {
      const bars = Math.max(1, Math.round(a.params.bars));
      if (candles.length < bars + 1) return { triggered: false };
      const now = candles.at(-1).close;
      const before = candles[candles.length - 1 - bars].close;
      const change = pct(now, before);
      return {
        triggered: change >= a.params.pct,
        value: change,
        message: `+${change.toFixed(2)} % za ${bars} sviečok`,
      };
    },
  },
  {
    id: 'change_pct_down',
    label: 'Pokles o % za N sviečok',
    description: 'Notifikuje pri poklese ceny o zadané percento za N sviečok.',
    warmup: 7,
    minBars: (a) => Math.max(1, Math.round(a.params.bars)) + 1,
    params: {
      pct: { label: '% poklesu', default: 5, min: 0.01, step: 0.1 },
      bars: { label: 'Za N sviečok', default: 6, min: 1, step: 1 },
    },
    describe: (a) => `cena -${a.params.pct} % za ${a.params.bars} sviečok`,
    evaluate(a, candles) {
      const bars = Math.max(1, Math.round(a.params.bars));
      if (candles.length < bars + 1) return { triggered: false };
      const now = candles.at(-1).close;
      const before = candles[candles.length - 1 - bars].close;
      const change = pct(now, before);
      return {
        triggered: change <= -a.params.pct,
        value: change,
        message: `${change.toFixed(2)} % za ${bars} sviečok`,
      };
    },
  },
  {
    id: 'rsi_above',
    label: 'RSI nad',
    description: 'Notifikuje, keď RSI prekročí hranicu (predvolene 70).',
    warmup: 20,
    minBars: (a) => Math.round(a.params.period) + 1,
    params: {
      value: { label: 'Hranica RSI', default: 70, min: 1, step: 1 },
      period: { label: 'Perióda', default: 14, min: 2, step: 1 },
    },
    describe: (a) => `RSI(${a.params.period}) > ${a.params.value}`,
    evaluate(a, candles) {
      const value = last(rsi(closes(candles), Math.round(a.params.period)));
      if (!isNum(value)) return { triggered: false };
      return {
        triggered: value > a.params.value,
        value,
        message: `RSI(${a.params.period}) ${value.toFixed(1)} > ${a.params.value}`,
      };
    },
  },
  {
    id: 'rsi_below',
    label: 'RSI pod',
    description: 'Notifikuje, keď RSI klesne pod hranicu (predvolene 30).',
    warmup: 20,
    minBars: (a) => Math.round(a.params.period) + 1,
    params: {
      value: { label: 'Hranica RSI', default: 30, min: 1, step: 1 },
      period: { label: 'Perióda', default: 14, min: 2, step: 1 },
    },
    describe: (a) => `RSI(${a.params.period}) < ${a.params.value}`,
    evaluate(a, candles) {
      const value = last(rsi(closes(candles), Math.round(a.params.period)));
      if (!isNum(value)) return { triggered: false };
      return {
        triggered: value < a.params.value,
        value,
        message: `RSI(${a.params.period}) ${value.toFixed(1)} < ${a.params.value}`,
      };
    },
  },
  {
    id: 'volume_spike',
    label: 'Objemový spike',
    description: 'Notifikuje, keď objem poslednej sviečky prekročí násobok priemeru.',
    warmup: 22,
    minBars: (a) => Math.round(a.params.period) + 1,
    params: {
      mult: { label: 'Násobok priemeru', default: 2, min: 1.1, step: 0.1 },
      period: { label: 'Perióda priemeru', default: 20, min: 2, step: 1 },
    },
    describe: (a) => `objem > ${a.params.mult}x priemer(${a.params.period})`,
    evaluate(a, candles) {
      const period = Math.round(a.params.period);
      const v = volumes(candles);
      if (v.length < period + 1) return { triggered: false };
      const slice = v.slice(-period - 1, -1);
      const avg = slice.reduce((acc, x) => acc + x, 0) / slice.length;
      const current = v.at(-1);
      if (!avg || !isNum(current)) return { triggered: false };
      const ratio = current / avg;
      return {
        triggered: ratio >= a.params.mult,
        value: ratio,
        message: `objem ${ratio.toFixed(2)}x priemer(${period})`,
      };
    },
  },
  {
    id: 'breakout_high',
    label: 'Breakout nad maximum',
    description: 'Notifikuje, keď close prekoná maximum za posledných N sviečok.',
    warmup: 22,
    minBars: (a) => Math.round(a.params.period) + 2,
    params: { period: { label: 'Perióda', default: 20, min: 2, step: 1 } },
    describe: (a) => `close > high(${a.params.period})`,
    evaluate(a, candles) {
      const period = Math.round(a.params.period);
      if (candles.length < period + 2) return { triggered: false };
      const n = candles.length;
      const level = highest(candles.map((c) => c.high), n - 1 - period, n - 1);
      const price = candles[n - 1].close;
      return {
        triggered: isNum(level) && price > level,
        value: price,
        message: `close ${price} > high(${period}) ${level}`,
      };
    },
  },
  {
    id: 'breakdown_low',
    label: 'Breakdown pod minimum',
    description: 'Notifikuje, keď close spadne pod minimum za posledných N sviečok.',
    warmup: 22,
    minBars: (a) => Math.round(a.params.period) + 2,
    params: { period: { label: 'Perióda', default: 20, min: 2, step: 1 } },
    describe: (a) => `close < low(${a.params.period})`,
    evaluate(a, candles) {
      const period = Math.round(a.params.period);
      if (candles.length < period + 2) return { triggered: false };
      const n = candles.length;
      const level = lowest(candles.map((c) => c.low), n - 1 - period, n - 1);
      const price = candles[n - 1].close;
      return {
        triggered: isNum(level) && price < level,
        value: price,
        message: `close ${price} < low(${period}) ${level}`,
      };
    },
  },
  {
    id: 'ema_cross_up',
    label: 'EMA pretnutie nahor',
    description: 'Notifikuje, keď rýchla EMA pretne pomalú nahor.',
    warmup: 52,
    minBars: (a) => Math.round(a.params.slow) + 2,
    params: {
      fast: { label: 'Rýchla EMA', default: 20, min: 2, step: 1 },
      slow: { label: 'Pomalá EMA', default: 50, min: 3, step: 1 },
    },
    describe: (a) => `EMA(${a.params.fast}) pretne EMA(${a.params.slow}) nahor`,
    evaluate(a, candles) {
      const c = closes(candles);
      const fast = ema(c, Math.round(a.params.fast));
      const slow = ema(c, Math.round(a.params.slow));
      const hit = crossOver(fast, slow, 0) || crossOver(fast, slow, 1);
      return {
        triggered: hit,
        value: last(fast),
        message: `EMA(${a.params.fast}) pretla EMA(${a.params.slow}) nahor`,
      };
    },
  },
  {
    id: 'ema_cross_down',
    label: 'EMA pretnutie nadol',
    description: 'Notifikuje, keď rýchla EMA pretne pomalú nadol.',
    warmup: 52,
    minBars: (a) => Math.round(a.params.slow) + 2,
    params: {
      fast: { label: 'Rýchla EMA', default: 20, min: 2, step: 1 },
      slow: { label: 'Pomalá EMA', default: 50, min: 3, step: 1 },
    },
    describe: (a) => `EMA(${a.params.fast}) pretne EMA(${a.params.slow}) nadol`,
    evaluate(a, candles) {
      const c = closes(candles);
      const fast = ema(c, Math.round(a.params.fast));
      const slow = ema(c, Math.round(a.params.slow));
      const hit = crossUnder(fast, slow, 0) || crossUnder(fast, slow, 1);
      return {
        triggered: hit,
        value: last(fast),
        message: `EMA(${a.params.fast}) pretla EMA(${a.params.slow}) nadol`,
      };
    },
  },
  {
    id: 'atr_pct_above',
    label: 'Volatilita nad %',
    description: 'Notifikuje, keď ATR ako percento ceny prekročí hranicu.',
    warmup: 20,
    minBars: (a) => Math.round(a.params.period) + 1,
    params: {
      pct: { label: 'ATR %', default: 3, min: 0.01, step: 0.1 },
      period: { label: 'Perióda', default: 14, min: 2, step: 1 },
    },
    describe: (a) => `ATR(${a.params.period}) > ${a.params.pct} %`,
    evaluate(a, candles) {
      const value = last(natr(candles, Math.round(a.params.period)));
      if (!isNum(value)) return { triggered: false };
      return {
        triggered: value > a.params.pct,
        value,
        message: `ATR(${a.params.period}) ${value.toFixed(2)} % > ${a.params.pct} %`,
      };
    },
  },
];

export const ALERT_KIND_IDS = ALERT_KINDS.map((k) => k.id);

export function getAlertKind(id) {
  return ALERT_KINDS.find((k) => k.id === id) ?? null;
}

/** Default parameters for a kind (fresh object every call). */
export function defaultParams(kindOrId) {
  const kind = typeof kindOrId === 'string' ? getAlertKind(kindOrId) : kindOrId;
  if (!kind) return {};
  const params = {};
  for (const [key, spec] of Object.entries(kind.params)) params[key] = spec.default;
  return params;
}

/* ------------------------------------------------------------------- model */

export function createAlert(patch = {}) {
  const kind = getAlertKind(patch.kind) ?? ALERT_KINDS[0];
  return {
    schema: 1,
    id: patch.id ?? alertId(),
    symbol: String(patch.symbol ?? 'BTCUSDT').toUpperCase(),
    timeframe: patch.timeframe ?? '1h',
    kind: kind.id,
    params: { ...defaultParams(kind), ...(patch.params ?? {}) },
    note: patch.note ?? '',
    enabled: patch.enabled !== false,
    createdAt: patch.createdAt ?? 0,
    lastTriggeredAt: patch.lastTriggeredAt ?? 0,
    triggerCount: patch.triggerCount ?? 0,
  };
}

/** @returns {string[]} human-readable problems (empty = valid). */
export function validateAlert(alert) {
  if (!alert || typeof alert !== 'object') return ['Upozornenie chýba.'];
  const errors = [];
  const kind = getAlertKind(alert.kind);
  if (!kind) errors.push(`Neznámy typ upozornenia: ${alert.kind}.`);
  if (!alert.symbol || typeof alert.symbol !== 'string') errors.push('Chýba obchodný pár (napr. BTCUSDT).');
  for (const [key, spec] of Object.entries(kind?.params ?? {})) {
    const value = alert.params?.[key];
    if (!Number.isFinite(value)) {
      errors.push(`Parameter "${spec.label}" musí byť číslo.`);
    } else if (spec.min !== undefined && value < spec.min) {
      errors.push(`Parameter "${spec.label}" musí byť aspoň ${spec.min}.`);
    }
  }
  return errors;
}

export function describeAlert(alert) {
  const kind = getAlertKind(alert?.kind);
  if (!kind) return 'Neznáme upozornenie';
  try {
    return kind.describe(alert);
  } catch {
    return kind.label;
  }
}

/* -------------------------------------------------------------- evaluation */

function requiredBars(alert, kind) {
  if (typeof kind.minBars === 'function') {
    try {
      const n = Math.floor(kind.minBars(alert));
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall back to the default warmup */ }
  }
  return kind.warmup;
}

/**
 * Evaluate one alert against a candle series.
 * @returns {{triggered:boolean, skipped?:boolean, reason?:string, value?:?number, message?:string}}
 */
export function evaluateAlert(alert, candles) {
  const kind = getAlertKind(alert?.kind);
  if (!kind) return { triggered: false, skipped: true, reason: 'neznámy typ' };
  if (alert.enabled === false) return { triggered: false, skipped: true, reason: 'vypnuté' };
  if (!Array.isArray(candles) || candles.length < requiredBars(alert, kind)) {
    return { triggered: false, skipped: true, reason: 'málo dát' };
  }
  let out;
  try {
    out = kind.evaluate(alert, candles) ?? {};
  } catch (err) {
    return { triggered: false, skipped: true, reason: err.message };
  }
  return {
    triggered: Boolean(out.triggered),
    value: out.value ?? null,
    message: out.message ?? describeAlert(alert),
    skipped: false,
  };
}

/** Normalise datasets into a Map<symbol, candles>. */
function datasetMap(datasets) {
  if (datasets instanceof Map) return datasets;
  if (Array.isArray(datasets)) {
    return new Map(datasets.filter(Boolean).map((d) => [d.symbol, d.candles ?? []]));
  }
  if (datasets && typeof datasets === 'object') return new Map(Object.entries(datasets));
  return new Map();
}

/**
 * Check every alert against the provided datasets.
 * @param {Array} alerts
 * @param {Array|Map|object} datasets
 * @param {{cooldownMs?:number, now?:number}} [opts]
 */
export function checkAlerts(alerts = [], datasets = [], { cooldownMs = 0, now = 0 } = {}) {
  const bySymbol = datasetMap(datasets);
  const triggers = [];
  let checked = 0;
  let skipped = 0;

  for (const alert of alerts) {
    const candles = bySymbol.get(alert.symbol);
    if (!candles) {
      skipped += 1;
      continue;
    }
    const result = evaluateAlert(alert, candles);
    if (result.skipped) {
      skipped += 1;
      continue;
    }
    checked += 1;
    if (!result.triggered) continue;
    if (cooldownMs > 0 && alert.lastTriggeredAt && now - alert.lastTriggeredAt < cooldownMs) continue;
    triggers.push({
      alertId: alert.id,
      symbol: alert.symbol,
      kind: alert.kind,
      message: result.message,
      value: result.value,
      at: now,
    });
  }

  return { triggers, checked, skipped };
}

/** Immutably update lastTriggeredAt / triggerCount on the triggered alerts. */
export function applyTriggers(alerts = [], triggers = [], at = 0) {
  const counts = new Map();
  for (const trigger of triggers) {
    counts.set(trigger.alertId, (counts.get(trigger.alertId) ?? 0) + 1);
  }
  return alerts.map((alert) => (counts.has(alert.id)
    ? {
      ...alert,
      lastTriggeredAt: at,
      triggerCount: (alert.triggerCount ?? 0) + counts.get(alert.id),
    }
    : alert));
}