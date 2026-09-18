/** money.js — deterministic rounding helpers so numbers stay stable across runs. */

export function round(value, decimals = 8) {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  const r = Math.round((value + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export const roundQty = (v) => round(v, 8);
export const roundCash = (v) => round(v, 8);
export const roundPct = (v) => round(v, 4);
export const roundPrice = (v) => round(v, 8);

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Percent change from a to b. */
export function pctChange(a, b) {
  if (!Number.isFinite(a) || a === 0) return 0;
  return ((b - a) / a) * 100;
}

export function formatMoney(v, decimals = 2, currency = 'USDT') {
  const n = Number.isFinite(v) ? v : 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toLocaleString('sk-SK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${currency}`;
}

export function formatPct(v, decimals = 2) {
  const n = Number.isFinite(v) ? v : 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(decimals)} %`;
}

export function formatQty(v, decimals = 6) {
  const n = Number.isFinite(v) ? v : 0;
  return n.toFixed(decimals).replace(/\.?0+$/, '') || '0';
}
