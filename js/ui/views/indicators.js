/** indicators.js — indicator reference with a live preview on the loaded data. */

import { h, table, stat, pill, fmtNum, fmtDate, select } from '../dom.js';
import { drawCandles, drawBars } from '../charts.js';
import { state, emit } from '../state.js';
import { INDICATOR_REGISTRY, computeIndicator } from '../../core/indicators.js';

let overlayCanvas = null;
let histogramCanvas = null;
let currentParams = {};

export function render() {
  const wrap = h('div');
  const candles = state.candles;
  const def = INDICATOR_REGISTRY.find((i) => i.id === state.indicatorSelection) ?? INDICATOR_REGISTRY[0];
  currentParams = { ...Object.fromEntries(def.params.map((p) => [p.key, p.def])), ...(currentParams.__id === def.id ? currentParams : {}) };
  currentParams.__id = def.id;

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Indikátory'),
      h('p', { class: 'muted small' }, `${INDICATOR_REGISTRY.length} indikátorov dostupných v pravidlách — všetky počítané lokálne z OHLCV dát.`)),
    h('div', { class: 'actions' }, pill(`${candles.length} sviečok ${state.symbol} ${state.timeframe}`, 'info'))));

  /* --------------------------------------------------------------- selector */
  const groups = [...new Set(INDICATOR_REGISTRY.map((i) => i.group))];
  const picker = h('select', {
    onchange: (e) => {
      state.indicatorSelection = e.target.value;
      currentParams = {};
      emit();
    },
  });
  for (const g of groups) {
    const og = h('optgroup', { label: g });
    for (const item of INDICATOR_REGISTRY.filter((i) => i.group === g)) {
      const o = h('option', { value: item.id }, `${item.label} (${item.id})`);
      if (item.id === def.id) o.selected = true;
      og.append(o);
    }
    picker.append(og);
  }

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, `Náhľad: ${def.label}`),
      h('div', { class: 'split' }, picker)),
    h('div', { class: 'grid cols-4' }, def.params.length
      ? def.params.map((p) => h('label', { class: 'field' },
        h('span', null, `${p.key} (${p.min}–${p.max})`),
        h('input', {
          type: 'number', value: currentParams[p.key] ?? p.def, min: p.min, max: p.max, step: 'any',
          onchange: (e) => { currentParams[p.key] = Number(e.target.value); emit(); },
        })))
      : [h('p', { class: 'muted small' }, 'Tento indikátor nemá parametre.')])));

  /* ------------------------------------------------------------------ values */
  let series = [];
  try {
    series = computeIndicator(def.id, candles, currentParams);
  } catch (err) {
    wrap.append(h('div', { class: 'card' }, h('p', { class: 'neg' }, `Nepodarilo sa vypočítať: ${err.message}`)));
    return wrap;
  }

  const numeric = series.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const now = numeric.at(-1);
  const min = numeric.length ? Math.min(...numeric) : 0;
  const max = numeric.length ? Math.max(...numeric) : 0;
  const avg = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : 0;
  const percentile = numeric.length ? (numeric.filter((v) => v < now).length / numeric.length) * 100 : 0;

  wrap.append(h('div', { class: 'grid cols-4' },
    stat('Aktuálna hodnota', now === undefined ? '—' : fmtNum(now, 4), fmtDate(candles.at(-1)?.time)),
    stat('Minimum', fmtNum(min, 4), 'v nahranom okne'),
    stat('Maximum', fmtNum(max, 4), 'v nahranom okne'),
    stat('Priemer', fmtNum(avg, 4), `percentil ${fmtNum(percentile, 1)} %`)));

  overlayCanvas = h('canvas', { style: { height: '300px' } });
  histogramCanvas = h('canvas', { style: { height: '150px' } });

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Cena s indikátorom')),
    h('div', { class: 'chart-box' }, overlayCanvas),
    h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: '#f0b90b' } }), def.label))));

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Samostatný priebeh indikátora')),
    h('div', { class: 'chart-box' }, histogramCanvas)));

  /* ------------------------------------------------------------------ table */
  const tail = candles.slice(-25);
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Posledných 25 hodnôt')),
    table(
      [{ label: 'Čas' }, { label: 'Close', num: true }, { label: def.label, num: true }],
      tail.map((c, i) => {
        const idx = candles.length - tail.length + i;
        return [fmtDate(c.time), fmtNum(c.close, 4), series[idx] === null ? '—' : fmtNum(series[idx], 4)];
      }))));

  /* ---------------------------------------------------------------- catalog */
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Katalóg indikátorov')),
    table(
      [{ label: 'ID' }, { label: 'Názov' }, { label: 'Skupina' }, { label: 'Parametre' }],
      INDICATOR_REGISTRY.map((i) => [
        h('span', { class: 'mono small' }, i.id),
        i.label,
        h('span', { class: 'tag' }, i.group),
        i.params.length ? i.params.map((p) => `${p.key}=${p.def}`).join(', ') : '—',
      ]))));

  return wrap;
}

export function afterMount() {
  const candles = state.candles;
  const def = INDICATOR_REGISTRY.find((i) => i.id === state.indicatorSelection) ?? INDICATOR_REGISTRY[0];
  let series = [];
  try {
    series = computeIndicator(def.id, candles, currentParams);
  } catch {
    return;
  }
  if (overlayCanvas) {
    drawCandles(overlayCanvas, {
      candles,
      overlays: [{ label: def.label, series }],
      height: 300,
    });
  }
  if (histogramCanvas) {
    const tail = series.slice(-120).map((v, i) => ({ label: String(i), value: typeof v === 'number' ? v : 0 }));
    // Only centre the axis when the indicator actually oscillates around zero.
    const hasNegative = tail.some((t) => t.value < 0);
    drawBars(histogramCanvas, tail, { height: 150, zeroCentered: hasNegative });
  }
}
