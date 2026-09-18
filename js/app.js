/**
 * app.js — application bootstrap: routing, topbar wiring, view rendering.
 */

import { qs, qsa, mount, toast } from './ui/dom.js';
import {
  state, store, market, emit, onChange, navigate, viewFromHash, loadCandles, setSource,
} from './ui/state.js';
import { POPULAR_SYMBOLS, SYMBOL_CATEGORIES } from './data/market.js';
import { TIMEFRAMES } from './core/rules.js';

import * as dashboard from './ui/views/dashboard.js';
import * as strategies from './ui/views/strategies.js';
import * as editor from './ui/views/editor.js';
import * as backtest from './ui/views/backtest.js';
import * as paper from './ui/views/paper.js';
import * as trades from './ui/views/trades.js';
import * as indicators from './ui/views/indicators.js';
import * as settings from './ui/views/settings.js';
import * as scanner from './ui/views/scanner.js';
import * as alerts from './ui/views/alerts.js';

const VIEWS = { dashboard, strategies, editor, scanner, alerts, backtest, paper, trades, indicators, settings };
const TITLES = {
  dashboard: 'Prehľad',
  strategies: 'Stratégie',
  editor: 'Editor pravidiel',
  scanner: 'Skenovať trh',
  alerts: 'Upozornenia',
  backtest: 'Backtest',
  paper: 'Virtuálne obchodovanie',
  trades: 'Obchody a portfólio',
  indicators: 'Indikátory',
  settings: 'Nastavenia',
};


/* ------------------------------------------------------------------ topbar */

function buildSelectors() {
  const symbolSelect = qs('#symbol-select');
  const known = new Set([...POPULAR_SYMBOLS, ...(store.state.watchlist ?? []), state.symbol]);
  const option = (sym) => {
    const o = document.createElement('option');
    o.value = sym;
    o.textContent = sym;
    if (sym === state.symbol) o.selected = true;
    return o;
  };
  const grouped = new Set();
  const groups = [];
  for (const category of SYMBOL_CATEGORIES) {
    const symbols = category.symbols.filter((sym) => known.has(sym));
    if (!symbols.length) continue;
    const group = document.createElement('optgroup');
    group.label = category.label;
    for (const sym of symbols) { grouped.add(sym); group.append(option(sym)); }
    groups.push(group);
  }
  const extra = [...known].filter((sym) => !grouped.has(sym));
  if (extra.length) {
    const group = document.createElement('optgroup');
    group.label = 'Sledované a ďalšie';
    for (const sym of extra) group.append(option(sym));
    groups.push(group);
  }
  mount(symbolSelect, ...groups);
  symbolSelect.onchange = () => {
    loadCandles({ symbol: symbolSelect.value }).then(emit);
  };

  const tfSelect = qs('#timeframe-select');
  mount(tfSelect, ...TIMEFRAMES.map((tf) => {
    const o = document.createElement('option');
    o.value = tf;
    o.textContent = tf;
    if (tf === state.timeframe) o.selected = true;
    return o;
  }));
  tfSelect.onchange = () => loadCandles({ timeframe: tfSelect.value }).then(emit);

  const sourceSelect = qs('#source-select');
  sourceSelect.value = state.source;
  sourceSelect.onchange = () => setSource(sourceSelect.value).then(emit);

  qs('#reload-data').onclick = () => loadCandles().then(emit);
}

function updateTopbar() {
  const status = qs('#market-status');
  const degraded = state.dataInfo.degraded;
  status.className = `pill ${state.loading ? 'pill-warn' : degraded ? 'pill-warn' : 'pill-ok'}`;
  status.textContent = state.loading
    ? 'načítavam…'
    : degraded
      ? `offline režim (${state.dataInfo.source})`
      : `Binance online`;

  const ticker = qs('#price-ticker');
  const last = state.candles[state.candles.length - 1];
  if (state.engine) {
    const price = state.engine.broker.lastPrice;
    ticker.textContent = price ? `${state.symbol} ${price}` : '—';
  } else {
    ticker.textContent = last ? `${state.symbol} ${last.close}` : '—';
  }

  for (const btn of qsa('.nav-btn')) btn.classList.toggle('active', btn.dataset.view === state.view);
}

/* ------------------------------------------------------------------ routing */

function renderView() {
  const container = qs('#view');
  const view = VIEWS[state.view] ?? VIEWS.dashboard;
  document.title = `CoinRule Studio — ${TITLES[state.view] ?? 'Prehľad'}`;
  let node;
  try {
    node = view.render();
  } catch (err) {
    node = document.createElement('div');
    node.className = 'card';
    node.innerHTML = `<h3>Chyba zobrazenia</h3><p class="neg"></p>`;
    node.querySelector('p').textContent = err.message;
    console.error(err);
  }
  mount(container, node);
  try {
    view.afterMount?.(container);
  } catch (err) {
    console.error('afterMount failed', err);
  }
  updateTopbar();
}

function render() {
  renderView();
}

/* -------------------------------------------------------------------- start */

function bindNav() {
  for (const btn of qsa('.nav-btn')) {
    btn.onclick = () => navigate(btn.dataset.view);
  }
  window.addEventListener('hashchange', () => {
    const next = viewFromHash();
    if (next !== state.view) {
      state.view = next;
      emit();
    }
  });
}

async function boot() {
  state.view = viewFromHash();
  buildSelectors();
  bindNav();
  onChange(render);

  // First paint with whatever data we can get; the loader falls back to the
  // deterministic simulator when Binance is unreachable.
  render();
  await loadCandles({ limit: state.candleLimit });
  render();

  if (state.dataInfo.degraded) {
    toast('Bežíš v offline režime so simulovanými dátami. Všetko funguje rovnako.', 'warn', 6000);
  }
}

window.addEventListener('error', (e) => {
  console.error(e.error ?? e.message);
});

boot().catch((err) => {
  console.error(err);
  const container = qs('#view');
  if (container) {
    container.textContent = `Štart zlyhal: ${err.message}`;
  }
});

// Exposed for debugging in the browser console (no secrets, read-only usage).
window.CoinRuleStudio = { state, store, market };
