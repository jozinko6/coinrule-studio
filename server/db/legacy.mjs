/**
 * legacy.mjs — one-time, idempotent import of the old localStorage document.
 *
 * The browser store (`coinrule-studio/v1`) held strategies, settings, backtest
 * summaries, a paper session and alerts. This module imports all of it into
 * SQLite without duplicating anything: the import is guarded by a marker and
 * every row uses a deterministic legacy id with INSERT OR IGNORE.
 */

import {
  appendPaperEquity, appendPaperTrades, getSetting, insertLegacyBacktest,
  savePaperSession, setSetting, upsertStrategy,
} from './repositories.mjs';

export const LEGACY_MARKER_KEY = 'legacy_import_v1';

function parse(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const data = doc?.data ?? doc;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Neplatný legacy dokument: chýba objekt "data".');
  }
  return data;
}

/**
 * Import a legacy store document.
 * @returns {{imported:boolean, skipped:boolean, counts:object}}
 */
export function importLegacyState(db, input) {
  const data = parse(input);
  const marker = getSetting(db, LEGACY_MARKER_KEY);
  if (marker?.done) {
    return { imported: false, skipped: true, counts: marker.counts ?? {} };
  }

  const counts = { strategies: 0, backtests: 0, paperTrades: 0, paperEquity: 0, alerts: 0, settings: 0 };

  const strategies = Array.isArray(data.strategies) ? data.strategies : [];
  for (const strategy of strategies) {
    if (!strategy?.id) continue;
    upsertStrategy(db, strategy, { source: 'legacy', createdAt: strategy.createdAt });
    counts.strategies += 1;
  }

  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  if (Object.keys(settings).length) {
    setSetting(db, 'settings', settings);
    counts.settings = Object.keys(settings).length;
  }
  if (Array.isArray(data.watchlist)) setSetting(db, 'watchlist', data.watchlist);
  if (Array.isArray(data.favourites)) setSetting(db, 'favourites', data.favourites);
  if (Array.isArray(data.alerts)) {
    setSetting(db, 'alerts', data.alerts);
    counts.alerts = data.alerts.length;
  }

  const backtests = Array.isArray(data.backtests) ? data.backtests : [];
  for (const record of backtests) {
    if (!record?.id) continue;
    if (insertLegacyBacktest(db, record)) counts.backtests += 1;
  }

  const paper = data.paper && typeof data.paper === 'object' ? data.paper : null;
  if (paper) {
    const sessionId = `legacy_paper_${paper.startedAt || 0}`;
    savePaperSession(db, {
      id: sessionId,
      symbol: paper.symbol ?? 'BTCUSDT',
      timeframe: paper.timeframe ?? '1h',
      startingCash: paper.cash ?? 0,
      cash: paper.cash ?? 0,
      equity: Array.isArray(paper.equityCurve) && paper.equityCurve.length
        ? paper.equityCurve[paper.equityCurve.length - 1].equity
        : null,
      status: 'legacy',
      settings: { running: Boolean(paper.running), imported: true },
      startedAt: paper.startedAt || 0,
      endedAt: null,
    });
    counts.paperTrades = appendPaperTrades(db, sessionId, Array.isArray(paper.trades) ? paper.trades : []);
    counts.paperEquity = appendPaperEquity(db, sessionId, Array.isArray(paper.equityCurve) ? paper.equityCurve : []);
  }

  setSetting(db, LEGACY_MARKER_KEY, {
    done: true,
    at: Date.now(),
    counts,
  });
  return { imported: true, skipped: false, counts };
}