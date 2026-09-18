/** dashboard.js — overview: market status, KPIs, chart, watchlist, activity. */

import { h, stat, table, pill, fmtNum, fmtMoney, fmtPct, fmtDate, signClass, bar } from '../dom.js';
import { drawCandles, drawEquity } from '../charts.js';
import { state, store, navigate, loadCandles } from '../state.js';
import { sma, ema, rsi, atr, last } from '../../core/indicators.js';
import { STRATEGY_COUNT } from '../../core/strategies.js';
import { createBackendClient, defaultBackendUrl } from '../../data/backend.js';

let chartCanvas = null;
let equityCanvas = null;
let backendBadge = null;

/** Non-blocking badge: the page must work fine when no backend is running. */
async function refreshBackendBadge() {
  if (!backendBadge) return;
  try {
    const client = createBackendClient({ baseUrl: defaultBackendUrl() });
    const health = await client.health();
    backendBadge.textContent = 'backend: ' + health.mode + (health.db?.ok ? '' : ' (db chyba)');
    backendBadge.className = 'pill ' + (health.db?.ok ? 'pill-ok' : 'pill-warn');
  } catch {
    backendBadge.textContent = 'backend: offline';
    backendBadge.className = 'pill pill-warn';
  }
}

export function render() {
  const wrap = h('div');
  const candles = state.candles;
  const lastCandle = candles[candles.length - 1];

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Prehľad'),
      h('p', { class: 'muted small' }, `Trh ${state.symbol} · ${state.timeframe} · ${candles.length} sviečok`)),
    h('div', { class: 'actions' },
      (() => { backendBadge = h('span', { class: 'pill' }, 'backend: …'); return backendBadge; })(),
      h('button', { class: 'btn', type: 'button', onclick: () => loadCandles({ forceSource: 'binance' }) }, 'Binance online'),
      h('button', { class: 'btn', type: 'button', onclick: () => loadCandles({ forceSource: 'synthetic' }) }, 'Simulované dáta'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => loadCandles() }, 'Obnoviť'))));

  if (state.error) {
    wrap.append(h('div', { class: 'card' }, h('p', { class: 'neg' }, `Chyba: ${state.error}`)));
  }

  /* ------------------------------------------------------------- KPI cards */
  const closes = candles.map((c) => c.close);
  const change24 = candles.length > 24 ? ((closes[closes.length - 1] - closes[closes.length - 25]) / closes[closes.length - 25]) * 100 : 0;
  const rsiNow = last(rsi(closes, 14));
  const atrNow = last(atr(candles, 14));
  const sma200 = last(sma(closes, 200));

  const kpis = h('div', { class: 'grid cols-4' },
    stat('Cena', lastCandle ? fmtNum(lastCandle.close, lastCandle.close > 100 ? 2 : 4) : '—', state.symbol),
    stat('Zmena 24 barov', fmtPct(change24), 'podľa sviečok', signClass(change24)),
    stat('RSI (14)', rsiNow === null ? '—' : fmtNum(rsiNow, 1), rsiNow === null ? '' : rsiNow > 70 ? 'prekúpené' : rsiNow < 30 ? 'prepredané' : 'neutrálne', rsiNow === null ? '' : rsiNow > 70 ? 'neg' : rsiNow < 30 ? 'pos' : ''),
    stat('ATR (14)', atrNow === null ? '—' : fmtNum(atrNow, 4), sma200 ? `nad SMA200: ${closes.at(-1) > sma200 ? 'áno' : 'nie'}` : ''));
  wrap.append(kpis);

  /* ----------------------------------------------------------------- chart */
  chartCanvas = h('canvas', { style: { height: '380px' } });
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, `Cena ${state.symbol}`),
      h('div', { class: 'split' },
        pill(state.dataInfo.degraded ? 'simulované dáta' : 'Binance verejné API', state.dataInfo.degraded ? 'warn' : 'ok'),
        h('span', { class: 'muted small' }, state.dataInfo.message))),
    h('div', { class: 'chart-box' }, chartCanvas),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: '#f0b90b' } }), 'SMA 20'),
      h('span', null, h('i', { style: { background: '#4c9aff' } }), 'EMA 50'),
      h('span', null, h('i', { style: { background: '#b06bff' } }), 'SMA 200'))));

  /* ------------------------------------------------------------- watchlist */
  const watchRows = (store.state.watchlist ?? []).map((sym) => {
    const isCurrent = sym === state.symbol;
    return [
      h('a', { href: '#/dashboard', onclick: (e) => { e.preventDefault(); loadCandles({ symbol: sym }); } }, sym),
      isCurrent ? pill('aktívny', 'info') : h('span', { class: 'muted small' }, 'klikni pre načítanie'),
    ];
  });
  wrap.append(h('div', { class: 'grid cols-2' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Sledované páry')),
      table([{ label: 'Pár' }, { label: 'Stav' }], watchRows, { empty: 'Žiadne páry' })),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Knižnica stratégií')),
      h('p', { class: 'muted small' }, `${STRATEGY_COUNT} hotových šablón v 12 rodinách (trend, mean reversion, breakout, momentum, scalping, DCA, grid, martingale, risk, volatilita, hybrid, portfólio).`),
      h('div', { class: 'split' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('strategies') }, 'Prezrieť stratégie'),
        h('button', { class: 'btn', type: 'button', onclick: () => navigate('editor') }, 'Vytvoriť vlastnú')),
      h('p', { class: 'muted small' }, `Uložené stratégie: ${store.strategies.length}`))));

  /* -------------------------------------------------------- paper session */
  const engine = state.engine;
  if (engine) {
    const snap = engine.snapshot();
    equityCanvas = h('canvas', { style: { height: '220px' } });
    wrap.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, 'Bežiaca virtuálna session'),
        pill(state.paperRunning ? 'beží' : 'pozastavené', state.paperRunning ? 'ok' : 'warn')),
      h('div', { class: 'grid cols-4' },
        stat('Kapitál', fmtMoney(snap.equity), `štart ${fmtMoney(snap.startEquity)}`),
        stat('Výnos', fmtPct(snap.returnPct), '', signClass(snap.returnPct)),
        stat('Otvorené pozície', String(snap.positions.length), `expozícia ${fmtNum(snap.exposurePct, 1)} %`),
        stat('Obchody', String(snap.trades), `poplatky ${fmtMoney(snap.feesPaid, 2)}`)),
      h('div', { class: 'chart-box', style: { marginTop: '.6rem' } }, equityCanvas),
      h('div', { class: 'split', style: { marginTop: '.5rem' } },
        h('button', { class: 'btn', type: 'button', onclick: () => navigate('paper') }, 'Otvoriť panel obchodovania'))));
  }

  /* ------------------------------------------------------------- activity */
  const signals = engine ? engine.runtime.signals.slice(-8).reverse() : [];
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Posledné signály')),
    table(
      [{ label: 'Čas' }, { label: 'Stratégia' }, { label: 'Pravidlo' }, { label: 'Cena', num: true }],
      signals.map((s) => [fmtDate(s.time), s.strategyName ?? '—', s.ruleName ?? s.message ?? '—', fmtNum(s.price ?? 0, 4)]),
      { empty: 'Zatiaľ žiadne signály — spusti virtuálne obchodovanie.' })));

  return wrap;
}

export function afterMount() {
  void refreshBackendBadge();
  if (chartCanvas && state.candles.length) {
    const closes = state.candles.map((c) => c.close);
    drawCandles(chartCanvas, {
      candles: state.candles,
      overlays: [
        { label: 'SMA 20', series: sma(closes, 20) },
        { label: 'EMA 50', series: ema(closes, 50) },
        { label: 'SMA 200', series: sma(closes, 200) },
      ],
      height: 380,
    });
  }
  const engine = state.engine;
  if (equityCanvas && engine && engine.equityCurve.length > 1) {
    drawEquity(equityCanvas, engine.equityCurve, { height: 220 });
  }
}
