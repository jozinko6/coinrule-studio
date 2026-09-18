/** scanner.js — multi-symbol market scanner: presets in, ranked signals out. */

import { h, stat, table, pill, toast, bar, fmtNum, fmtPct, signClass } from '../dom.js';
import { state, store, emit, navigate, loadCandles, market } from '../state.js';
import { MAJOR_SYMBOLS, VOLATILE_SYMBOLS, sanitizeCandles } from '../../data/market.js';
import { SCAN_PRESETS, scanMarket, summariseScan } from '../../core/scanner.js';

const TREND_LABEL = { up: 'rast', down: 'pokles', side: 'bočný', unknown: '?' };
const TREND_KIND = { up: 'ok', down: 'err', side: 'warn', unknown: 'idle' };
const SCAN_LIMIT = 400;

export function render() {
  const wrap = h('div');

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Skenovať trh'),
      h('p', { class: 'muted small' }, `Prejde viac párov cez ${SCAN_PRESETS.length} signálov naraz (offline aj online) a zoradí ich podľa sily.`)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', title: 'Hlavné a likvidné páry', onclick: () => useSymbols(MAJOR_SYMBOLS, 'Hlavné páry') }, 'Hlavné (' + MAJOR_SYMBOLS.length + ')'),
      h('button', { class: 'btn', type: 'button', title: 'Memecoiny a high-beta alty s veľkými výkyvmi', onclick: () => useSymbols(VOLATILE_SYMBOLS, 'Volatilné páry') }, 'Volatilné (' + VOLATILE_SYMBOLS.length + ')'),
      h('button', { class: 'btn', type: 'button', onclick: useWatchlist }, 'Watchlist'),
      h('button', { class: 'btn primary', type: 'button', disabled: state.scanRunning, onclick: runScan },
        state.scanRunning ? 'Skenujem…' : 'Spustiť sken'))));

  wrap.append(setupCard());

  if (state.scanRunning && state.scanProgress) {
    wrap.append(h('div', { class: 'card' },
      h('p', null, `Načítavam dáta… ${state.scanProgress.done}/${state.scanProgress.total} párov`),
      bar((state.scanProgress.done / Math.max(1, state.scanProgress.total)) * 100)));
  }

  const results = state.scan;
  if (results?.length) {
    wrap.append(summaryCard(results));
    wrap.append(resultsCard(results));
  } else {
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'empty' },
      state.scan ? 'Sken nevrátil žiadne výsledky.' : 'Zatiaľ žiadny sken. Vyber signály a spusti sken.')));
  }
  return wrap;
}

/* -------------------------------------------------------------------- setup */

function setupCard() {
  const symbols = h('input', {
    type: 'text',
    value: (state.scanSymbols ?? []).join(', '),
    placeholder: 'BTCUSDT, ETHUSDT, SOLUSDT',
    onchange: (e) => { state.scanSymbols = parseSymbols(e.target.value); },
  });

  const presetBoxes = SCAN_PRESETS.map((preset) => {
    const box = h('input', { type: 'checkbox' });
    if (state.scanPresetIds.includes(preset.id)) box.checked = true;
    box.onchange = () => {
      const set = new Set(state.scanPresetIds);
      if (box.checked) set.add(preset.id); else set.delete(preset.id);
      state.scanPresetIds = [...set];
    };
    return h('label', { title: preset.description }, box, h('span', null, preset.name));
  });

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Nastavenia skenu'),
      h('span', { class: 'muted small' }, `timeframe ${state.timeframe} podľa hornej lišty`)),
    h('div', { class: 'grid cols-2' },
      h('label', { class: 'field' }, h('span', null, 'Páry (oddelené čiarkou)'), symbols),
      h('div', null,
        h('div', { class: 'small muted', style: { marginBottom: '.3rem' } }, 'Signály'),
        h('div', { class: 'scan-presets' }, ...presetBoxes))));
}

function parseSymbols(text) {
  return String(text ?? '')
    .split(/[,\s;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{4,20}$/.test(s))
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .slice(0, 48);
}

function useWatchlist() {
  state.scanSymbols = [...(store.state.watchlist ?? [])];
  toast('Watchlist: ' + state.scanSymbols.length + ' párov', 'info');
  emit();
}

function useSymbols(list, label) {
  state.scanSymbols = [...list];
  toast(label + ': ' + list.length + ' párov', 'info');
  emit();
}

/* --------------------------------------------------------------------- scan */

async function runScan() {
  const symbols = parseSymbols(state.scanSymbols);
  if (!symbols.length) { toast('Zadaj aspoň jeden pár, napr. BTCUSDT', 'warn'); return; }
  if (!state.scanPresetIds.length) { toast('Vyber aspoň jeden signál', 'warn'); return; }

  state.scanRunning = true;
  state.scanProgress = { done: 0, total: symbols.length };
  emit();

  const forceSource = state.dataInfo.degraded ? 'synthetic' : null;
  const datasets = [];
  for (const symbol of symbols) {
    try {
      const res = await market.loadCandles({ symbol, timeframe: state.timeframe, limit: SCAN_LIMIT, forceSource });
      const candles = sanitizeCandles(res.candles);
      if (candles.length) datasets.push({ symbol, candles });
    } catch (err) {
      toast(`${symbol}: ${err.message}`, 'err');
    }
    state.scanProgress = { done: datasets.length, total: symbols.length };
    emit();
  }

  state.scan = scanMarket({ datasets, presetIds: state.scanPresetIds, minBars: 200 });
  state.scanRunning = false;
  state.scanProgress = null;
  emit();

  const summary = summariseScan(state.scan);
  toast(`Sken hotový: ${summary.scanned} párov, ${summary.matched} so signálom`, 'ok');
}

/* ----------------------------------------------------------------- results */

function summaryCard(results) {
  const s = summariseScan(results);
  return h('div', { class: 'grid cols-4' },
    stat('Skenovaných párov', String(s.scanned), `${s.ready} s dostatkom dát`),
    stat('So signálom', String(s.matched), 'aspoň jeden preset'),
    stat('Najsilnejší', s.top ?? '—', `Ø skóre ${fmtNum(s.avgScore, 1)}`),
    stat('Signálov v ponuke', String(state.scanPresetIds.length), 'vybrané presety'));
}

function resultsCard(results) {
  const rows = results.map((r) => [
    h('a', {
      href: '#/dashboard',
      onclick: (e) => { e.preventDefault(); loadCandles({ symbol: r.symbol }).then(() => navigate('dashboard')); },
    }, r.symbol),
    r.price === null ? '—' : fmtNum(r.price, r.price > 100 ? 2 : 4),
    h('span', { class: signClass(r.changePct ?? 0) }, fmtPct(r.changePct ?? 0)),
    r.rsi === null ? '—' : fmtNum(r.rsi, 1),
    pill(TREND_LABEL[r.trend] ?? '?', TREND_KIND[r.trend] ?? 'idle'),
    h('div', { class: 'score' }, bar(r.score), h('span', { class: 'small muted' }, `${fmtNum(r.score, 1)}`)),
    r.signals.length
      ? h('div', { class: 'signal-list' }, ...r.signals.map((sig) => h('span', { class: 'pill pill-info signal-pill', title: sig.detail }, sig.name)))
      : h('span', { class: 'muted small' }, '—'),
  ]);

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, `Výsledky (${results.length})`),
      h('span', { class: 'muted small' }, 'klikni na pár pre graf')),
    table([
      { label: 'Pár' }, { label: 'Cena', num: true }, { label: '24b', num: true },
      { label: 'RSI', num: true }, { label: 'Trend' }, { label: 'Skóre', num: true },
      { label: 'Signály' },
    ], rows, { empty: 'Žiadne výsledky.' }));
}