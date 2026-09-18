/**
 * state.js — shared application state + the small set of actions the views use.
 * Keeps the views free of wiring details and prevents circular imports.
 */

import { Store } from '../store/store.js';
import { MarketData, SOURCE, sanitizeCandles } from '../data/market.js';
import { LivePaperEngine } from '../core/session.js';
import { toast } from './dom.js';

export const store = new Store();
store.load();

export const market = new MarketData({
  source: store.settings.source ?? SOURCE.AUTO,
  log: (level, message) => {
    if (level === 'warn') toast(message, 'warn');
  },
});

export const state = {
  view: 'dashboard',
  symbol: store.settings.symbol,
  timeframe: store.settings.timeframe,
  source: store.settings.source,
  candleLimit: store.settings.candleLimit ?? 500,
  candles: [],
  dataInfo: { source: '—', degraded: false, message: 'nepripojené' },
  loading: false,
  error: null,
  backtest: null,
  backtestRunning: false,
  engine: null,
  feed: null,
  paperRunning: false,
  paperSpeedMs: 900,
  editorStrategyId: null,
  indicatorSelection: 'rsi',
  strategyFilter: 'all',
  strategyQuery: '',

  // scanner
  scan: null,
  scanRunning: false,
  scanProgress: null,
  scanSymbols: [...(store.state.watchlist ?? [])],
  scanPresetIds: ['rsi_oversold', 'trend_up', 'breakout_20', 'volume_spike'],

  // alerts
  alertDraft: null,
  alertCheckRunning: false,
  alertLastCheck: 0,
  alertLastTriggers: [],
};

/* ------------------------------------------------------------- observers */

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } }

/* -------------------------------------------------------------- navigation */

export function navigate(view) {
  state.view = view;
  if (typeof location !== 'undefined') {
    const hash = `#/${view}`;
    if (location.hash !== hash) location.hash = hash;
  }
  emit();
}

export function viewFromHash() {
  const raw = (typeof location !== 'undefined' ? location.hash : '') || '';
  const m = raw.match(/^#\/([a-z-]+)/i);
  const known = ['dashboard', 'strategies', 'editor', 'scanner', 'alerts', 'backtest', 'paper', 'trades', 'indicators', 'settings'];
  return m && known.includes(m[1]) ? m[1] : 'dashboard';
}

/* ------------------------------------------------------------ market data */

export async function loadCandles({ symbol = state.symbol, timeframe = state.timeframe, limit = state.candleLimit, forceSource = null } = {}) {
  state.loading = true;
  state.error = null;
  emit();
  try {
    const res = await market.loadCandles({ symbol, timeframe, limit, forceSource });
    state.candles = sanitizeCandles(res.candles);
    state.dataInfo = { source: res.source, degraded: res.degraded, message: res.message };
    state.symbol = symbol;
    state.timeframe = timeframe;
    store.updateSettings({ symbol, timeframe });
    if (!state.candles.length) throw new Error('prázdny dataset');
  } catch (err) {
    state.error = err.message;
    toast(`Nepodarilo sa načítať dáta: ${err.message}`, 'err');
  } finally {
    state.loading = false;
    emit();
  }
  return state.candles;
}

export function setSource(source) {
  state.source = source;
  market.source = source;
  store.updateSettings({ source });
  return loadCandles({ forceSource: source });
}

/* ---------------------------------------------------------------- strategies */

export function currentStrategy() {
  if (!state.editorStrategyId) return null;
  return store.getStrategy(state.editorStrategyId);
}

export function openInEditor(strategyId) {
  state.editorStrategyId = strategyId;
  navigate('editor');
}

/* ------------------------------------------------------------------ paper */

export function ensureEngine(strategyIds = null) {
  const strategies = (strategyIds ?? store.settings.paperStrategyIds ?? store.strategies.map((s) => s.id))
    .map((id) => store.getStrategy(id))
    .filter(Boolean);
  if (!state.engine) {
    state.engine = new LivePaperEngine({
      symbol: state.symbol,
      timeframe: state.timeframe,
      startingCash: store.settings.startingCash,
      feePct: store.settings.feePct,
      slippagePct: store.settings.slippagePct,
      participationRate: store.settings.participationRate,
      strategies,
      options: {
        allowPyramiding: store.settings.allowPyramiding,
        maxDrawdownPct: store.settings.maxDrawdownPct,
        maxDailyLossPct: store.settings.maxDailyLossPct,
      },
    });
  } else {
    state.engine.setStrategies(strategies);
  }
  return state.engine;
}

export function resetEngine() {
  stopFeed();
  state.engine = null;
  state.paperRunning = false;
  emit();
}

export function stopFeed() {
  if (state.feed) {
    try { state.feed.close(); } catch { /* already closed */ }
    state.feed = null;
  }
  state.paperRunning = false;
}

export function startFeed() {
  stopFeed();
  if (!state.engine) ensureEngine();
  // Rendering on every tick would rebuild the whole view; throttle to ~4 fps.
  let lastPaint = 0;
  const handle = market.openFeed({
    symbol: state.symbol,
    timeframe: state.timeframe,
    intervalMs: state.paperSpeedMs,
    onTick: (tick) => {
      state.engine.onTick(tick);
      const now = Date.now();
      if (now - lastPaint >= 250) { lastPaint = now; emit(); }
    },
    onError: (err) => toast(`Chyba feedu: ${err.message}`, 'err'),
    onStatus: (s) => { state.dataInfo = { ...state.dataInfo, ...s }; },
  });
  state.feed = handle;
  state.paperRunning = true;
  emit();
  return handle;
}
