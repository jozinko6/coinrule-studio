/**
 * store.js — persistence for strategies, paper-trading state and settings.
 *
 * Backed by `localStorage` in the browser and by an in-memory Map under Node
 * (so tests never need a DOM). Writes are versioned and migrated forward.
 * Nothing is ever sent anywhere: export produces a JSON string the user can
 * save; import validates before touching existing data.
 */

export const STORE_KEY = 'coinrule-studio/v1';
export const STORE_SCHEMA = 5;

export class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  key(i) { return [...this.map.keys()][i] ?? null; }
  get length() { return this.map.size; }
}

export function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch { /* access can throw in sandboxed iframes */ }
  return new MemoryStorage();
}

/** Fresh-install watchlist: majors plus a few very volatile pairs. */
export function defaultWatchlist() {
  return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'PEPEUSDT', 'WIFUSDT', 'INJUSDT', 'SUIUSDT'];
}

export function defaultState() {
  return {
    schema: STORE_SCHEMA,
    settings: {
      source: 'auto',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      startingCash: 10_000,
      feePct: 0.1,
      slippagePct: 0.05,
      participationRate: 0.25,
      maxDrawdownPct: 0,
      maxDailyLossPct: 0,
      allowPyramiding: false,
      theme: 'dark',
      locale: 'sk',
      candleLimit: 500,
    },
    strategies: [],
    watchlist: defaultWatchlist(),
    backtests: [],
    paper: {
      running: false,
      symbol: 'BTCUSDT',
      timeframe: '1h',
      cash: 10_000,
      equityCurve: [],
      trades: [],
      events: [],
      positions: [],
      startedAt: 0,
    },
    favourites: [],
    alerts: [],
    alertLog: [],
    updatedAt: 0,
  };
}

export class Store {
  constructor({ storage = defaultStorage(), key = STORE_KEY } = {}) {
    this.storage = storage;
    this.key = key;
    this.state = defaultState();
    this.listeners = new Set();
  }

  /* ------------------------------------------------------------ lifecycle */

  load() {
    const raw = this.storage.getItem(this.key);
    if (!raw) { this.state = defaultState(); return this.state; }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.state = defaultState();
      return this.state;
    }
    this.state = migrate(parsed);
    return this.state;
  }

  save() {
    this.state.schema = STORE_SCHEMA;
    this.state.updatedAt = Date.now();
    this.storage.setItem(this.key, JSON.stringify(this.state));
    this.emit();
    return this.state;
  }

  reset() {
    this.state = defaultState();
    this.save();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try { fn(this.state); } catch { /* listener errors must not break persistence */ }
    }
  }

  /* ------------------------------------------------------------ strategies */

  get strategies() { return this.state.strategies; }

  getStrategy(id) { return this.state.strategies.find((s) => s.id === id) ?? null; }

  upsertStrategy(strategy) {
    const idx = this.state.strategies.findIndex((s) => s.id === strategy.id);
    if (idx >= 0) this.state.strategies[idx] = { ...strategy };
    else this.state.strategies.push({ ...strategy });
    this.save();
    return strategy;
  }

  removeStrategy(id) {
    const before = this.state.strategies.length;
    this.state.strategies = this.state.strategies.filter((s) => s.id !== id);
    this.save();
    return before !== this.state.strategies.length;
  }

  duplicateStrategy(id) {
    const s = this.getStrategy(id);
    if (!s) return null;
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = `${s.id}_copy_${Math.random().toString(36).slice(2, 6)}`;
    copy.name = `${s.name} (kópia)`;
    this.state.strategies.push(copy);
    this.save();
    return copy;
  }

  /* -------------------------------------------------------------- settings */

  get settings() { return this.state.settings; }

  updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
    return this.state.settings;
  }

  /* ------------------------------------------------------------- backtests */

  saveBacktest(record) {
    const trimmed = {
      id: record.id ?? `bt_${Date.now().toString(36)}`,
      strategyId: record.strategyId,
      strategyName: record.strategyName,
      symbol: record.symbol,
      timeframe: record.timeframe,
      at: Date.now(),
      metrics: record.metrics,
      tradeCount: record.tradeCount ?? record.metrics?.trades ?? 0,
    };
    this.state.backtests.unshift(trimmed);
    this.state.backtests = this.state.backtests.slice(0, 50);
    this.save();
    return trimmed;
  }

  /* ----------------------------------------------------------------- paper */

  setPaper(patch) {
    this.state.paper = { ...this.state.paper, ...patch };
    this.save();
    return this.state.paper;
  }

  appendPaperTrades(trades) {
    this.state.paper.trades = [...trades, ...this.state.paper.trades].slice(0, 1000);
    this.save();
  }

  appendEquityPoint(point) {
    const curve = this.state.paper.equityCurve;
    curve.push(point);
    if (curve.length > 5000) curve.splice(0, curve.length - 5000);
    this.save();
  }

  /* ---------------------------------------------------------------- alerts */

  get alerts() { return this.state.alerts; }

  upsertAlert(alert) {
    const idx = this.state.alerts.findIndex((a) => a.id === alert.id);
    if (idx >= 0) this.state.alerts[idx] = { ...alert };
    else this.state.alerts.push({ ...alert });
    this.save();
    return alert;
  }

  removeAlert(id) {
    const before = this.state.alerts.length;
    this.state.alerts = this.state.alerts.filter((a) => a.id !== id);
    this.save();
    return before !== this.state.alerts.length;
  }

  toggleAlert(id, enabled = null) {
    const alert = this.state.alerts.find((a) => a.id === id);
    if (!alert) return null;
    alert.enabled = enabled === null ? !alert.enabled : Boolean(enabled);
    this.save();
    return alert;
  }

  replaceAlerts(alerts) {
    this.state.alerts = Array.isArray(alerts) ? alerts.map((a) => ({ ...a })) : [];
    this.save();
    return this.state.alerts;
  }

  appendAlertLog(entries) {
    const list = (Array.isArray(entries) ? entries : [entries])
      .slice()
      .sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0));
    this.state.alertLog = [...list, ...this.state.alertLog].slice(0, 500);
    this.save();
    return this.state.alertLog;
  }

  clearAlertLog() {
    this.state.alertLog = [];
    this.save();
    return this.state.alertLog;
  }

  /* ------------------------------------------------------------ favourites */

  toggleFavourite(id) {
    const set = new Set(this.state.favourites);
    if (set.has(id)) set.delete(id); else set.add(id);
    this.state.favourites = [...set];
    this.save();
    return this.state.favourites;
  }

  /* ----------------------------------------------------------- import/export */

  exportJSON({ pretty = true } = {}) {
    return JSON.stringify({ schema: STORE_SCHEMA, exportedAt: new Date(0).toISOString(), data: this.state }, null, pretty ? 2 : 0);
  }

  /**
   * Import a previously exported document.
   * @param {string|object} input
   * @param {{merge?:boolean}} [opts] merge=true keeps existing strategies
   */
  importJSON(input, { merge = true } = {}) {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    const data = parsed?.data ?? parsed;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Neplatný súbor: chýba objekt "data".');
    }
    const looksLikeState = ['schema', 'strategies', 'settings', 'paper', 'backtests'].some((k) => k in data);
    if (!looksLikeState) {
      throw new Error('Neplatný súbor: dokument neobsahuje rozpoznateľný stav aplikácie.');
    }
    const migrated = migrate(data);
    if (!merge) {
      this.state = migrated;
    } else {
      const byId = new Map(this.state.strategies.map((s) => [s.id, s]));
      for (const s of migrated.strategies ?? []) byId.set(s.id, s);
      this.state.strategies = [...byId.values()];
      this.state.settings = { ...this.state.settings, ...(migrated.settings ?? {}) };
      this.state.watchlist = [...new Set([...(this.state.watchlist ?? []), ...(migrated.watchlist ?? [])])];
      this.state.favourites = [...new Set([...(this.state.favourites ?? []), ...(migrated.favourites ?? [])])];
      const alertsById = new Map(this.state.alerts.map((a) => [a.id, a]));
      for (const a of migrated.alerts ?? []) alertsById.set(a.id, a);
      this.state.alerts = [...alertsById.values()];
      const logKeys = new Set(this.state.alertLog.map((e) => `${e.alertId}@${e.at}`));
      for (const entry of migrated.alertLog ?? []) {
        const key = `${entry.alertId}@${entry.at}`;
        if (!logKeys.has(key)) { this.state.alertLog.push(entry); logKeys.add(key); }
      }
    }
    this.save();
    return this.state;
  }

  /** Storage usage estimate in bytes. */
  size() {
    return (this.storage.getItem(this.key) ?? '').length;
  }
}

/** Forward-migrate a persisted document. Never throws on unknown shapes. */
export function migrate(raw) {
  const state = { ...defaultState(), ...(raw ?? {}) };
  const v = Number(raw?.schema ?? 1);

  if (v < 2) {
    // v1 kept a single "rules" array at the top level instead of strategies.
    if (Array.isArray(raw?.rules) && !raw.strategies) {
      state.strategies = [{
        schema: 2,
        id: 'migrated_v1',
        name: raw.name ?? 'Migrovaná stratégia',
        symbol: raw.symbol ?? 'BTCUSDT',
        timeframe: raw.timeframe ?? '1h',
        rules: raw.rules,
      }];
    }
  }
  if (v < 3) {
    state.paper = { ...defaultState().paper, ...(raw?.paper ?? {}) };
    state.favourites = raw?.favourites ?? [];
    state.watchlist = raw?.watchlist ?? defaultState().watchlist;
  }
  if (v < 4) {
    state.alerts = Array.isArray(raw?.alerts) ? raw.alerts : [];
    state.alertLog = Array.isArray(raw?.alertLog) ? raw.alertLog : [];
  }
  if (v < 5) {
    // v5 widens the default watchlist with volatile pairs. Only untouched
    // defaults are upgraded; curated user lists stay exactly as they are.
    const oldDefault = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const current = state.watchlist ?? [];
    const isOldDefault = current.length === oldDefault.length
      && oldDefault.every((sym) => current.includes(sym));
    if (isOldDefault) state.watchlist = defaultWatchlist();
  }

  state.settings = { ...defaultState().settings, ...(state.settings ?? {}) };
  state.strategies = Array.isArray(state.strategies) ? state.strategies : [];
  state.backtests = Array.isArray(state.backtests) ? state.backtests : [];
  state.alerts = Array.isArray(state.alerts) ? state.alerts : [];
  state.alertLog = Array.isArray(state.alertLog) ? state.alertLog : [];
  state.schema = STORE_SCHEMA;
  return state;
}
