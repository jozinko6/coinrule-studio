/**
 * repositories.mjs — typed access to the local SQLite schema.
 *
 * Every function takes the `DatabaseSync` handle as its first argument so the
 * layer stays trivially testable and the server can share one connection.
 * Secrets are never stored here: `exchange_accounts` keeps only a masked key.
 */

import { withTransaction } from './database.mjs';

const nowMs = () => Date.now();

function json(value) { return JSON.stringify(value ?? null); }
function parse(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/* ---------------------------------------------------------------- settings */

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(key, json(value), nowMs());
  return value;
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key);
  return row ? parse(row.value_json, fallback) : fallback;
}

export function allSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value_json FROM app_settings ORDER BY key').all()) {
    out[String(row.key)] = parse(row.value_json, null);
  }
  return out;
}

/* -------------------------------------------------------------- strategies */

export function upsertStrategy(db, strategy, { source = 'user', createdAt = null } = {}) {
  if (!strategy?.id) throw new Error('upsertStrategy: stratégia musí mať id.');
  const at = createdAt ?? strategy.createdAt ?? nowMs();
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT id, document_json, created_at FROM strategies WHERE id = ?').get(strategy.id);
    if (!existing) {
      db.prepare(`INSERT INTO strategies
        (id, name, symbol, timeframe, family, risk_level, document_json, source, archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(strategy.id, strategy.name ?? 'Bez názvu', strategy.symbol ?? '', strategy.timeframe ?? '1h',
          strategy.family ?? null, strategy.riskLevel ?? null, json(strategy), source, at, at);
      db.prepare('INSERT INTO strategy_versions (strategy_id, version, document_json, created_at) VALUES (?, 1, ?, ?)')
        .run(strategy.id, json(strategy), at);
      return { id: strategy.id, version: 1, created: true };
    }
    const unchanged = existing.document_json === json(strategy);
    db.prepare(`UPDATE strategies SET name = ?, symbol = ?, timeframe = ?, family = ?, risk_level = ?,
      document_json = ?, updated_at = ? WHERE id = ?`)
      .run(strategy.name ?? 'Bez názvu', strategy.symbol ?? '', strategy.timeframe ?? '1h',
        strategy.family ?? null, strategy.riskLevel ?? null, json(strategy), nowMs(), strategy.id);
    if (unchanged) return { id: strategy.id, version: null, created: false, unchanged: true };
    const last = db.prepare('SELECT MAX(version) AS v FROM strategy_versions WHERE strategy_id = ?').get(strategy.id);
    const next = Number(last?.v ?? 0) + 1;
    db.prepare('INSERT INTO strategy_versions (strategy_id, version, document_json, created_at) VALUES (?, ?, ?, ?)')
      .run(strategy.id, next, json(strategy), nowMs());
    return { id: strategy.id, version: next, created: false };
  });
}

export function getStrategy(db, id) {
  const row = db.prepare('SELECT document_json FROM strategies WHERE id = ?').get(id);
  return row ? parse(row.document_json) : null;
}

export function listStrategies(db, { includeArchived = false } = {}) {
  const sql = `SELECT document_json, archived, updated_at FROM strategies ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC`;
  return db.prepare(sql).all().map((r) => parse(r.document_json));
}

export function listStrategyVersions(db, strategyId) {
  return db.prepare('SELECT version, document_json, created_at FROM strategy_versions WHERE strategy_id = ? ORDER BY version')
    .all(strategyId)
    .map((r) => ({ version: Number(r.version), document: parse(r.document_json), createdAt: Number(r.created_at) }));
}

export function archiveStrategy(db, id) {
  const res = db.prepare('UPDATE strategies SET archived = 1, updated_at = ? WHERE id = ?').run(nowMs(), id);
  return res.changes > 0;
}

export function deleteStrategy(db, id) {
  const res = db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
  return res.changes > 0;
}

/* --------------------------------------------------------------- backtests */

export function newRunId(prefix = 'bt') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist a backtest result. The run id is immutable: writing the same id twice
 * throws instead of silently overwriting history.
 */
export function saveBacktestRun(db, { id = null, strategy, result, dataSource = 'unknown', note = null, createdAt = null }) {
  if (!result || typeof result !== 'object') throw new Error('saveBacktestRun: chýba výsledok.');
  const runId = id ?? newRunId();
  const assumptions = result.assumptions ?? {};
  const metrics = result.metrics ?? {};
  const finishedAt = createdAt ?? nowMs();
  const strategies = Array.isArray(result.strategies) ? result.strategies : [];
  const strategyName = strategy?.name ?? strategies[0]?.name ?? 'Neznáma stratégia';

  withTransaction(db, () => {
    db.prepare(`INSERT INTO backtest_runs
      (id, strategy_id, strategy_name, strategy_snapshot_json, symbol, timeframe, data_source, date_from, date_to,
       starting_cash, fee_pct, maker_fee_pct, slippage_pct, participation_rate, execution_model,
       risk_json, assumptions_json, metrics_json, trade_count, note, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, strategy?.id ?? null, strategyName, json(strategy ?? null), result.symbol ?? '',
        strategy?.timeframe ?? '', dataSource,
        metrics.startTime ?? null, metrics.endTime ?? null,
        assumptions.startingCash ?? metrics.startingCash ?? 0,
        assumptions.feePct ?? 0, assumptions.makerFeePct ?? assumptions.feePct ?? 0,
        assumptions.slippagePct ?? 0, assumptions.participationRate ?? 0.25,
        assumptions.executionModel ?? 'conservative',
        json(strategy?.risk ?? {}), json(assumptions), json(metrics),
        Array.isArray(result.trades) ? result.trades.length : 0, note, finishedAt, finishedAt);

    const insertTrade = db.prepare(`INSERT INTO backtest_trades
      (run_id, seq, symbol, qty, entry_price, exit_price, gross_pnl, entry_fee, exit_fee, total_fees,
       net_pnl, net_pnl_pct, opened_at, closed_at, reason, rule_id, strategy_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (result.trades ?? []).forEach((t, i) => {
      insertTrade.run(runId, i, t.symbol ?? result.symbol ?? '', t.qty ?? 0, t.entryPrice ?? 0, t.exitPrice ?? 0,
        t.grossPnl ?? 0, t.entryFee ?? 0, t.exitFee ?? 0, t.totalFees ?? t.fees ?? 0,
        t.netPnl ?? t.pnl ?? 0, t.netPnlPct ?? t.pnlPct ?? 0,
        t.openedAt ?? null, t.closedAt ?? null, t.reason ?? null, t.ruleId ?? null, t.strategyId ?? null);
    });

    const insertEquity = db.prepare('INSERT INTO backtest_equity (run_id, seq, time, equity, price) VALUES (?, ?, ?, ?, ?)');
    (result.equityCurve ?? []).forEach((p, i) => {
      insertEquity.run(runId, i, p.time ?? 0, p.equity ?? 0, p.price ?? null);
    });
  });

  return runId;
}

/** Import a legacy (localStorage) backtest summary. INSERT OR IGNORE keeps it idempotent. */
export function insertLegacyBacktest(db, record) {
  const id = `legacy_bt_${record.id}`;
  const res = db.prepare(`INSERT OR IGNORE INTO backtest_runs
    (id, strategy_id, strategy_name, strategy_snapshot_json, symbol, timeframe, data_source, date_from, date_to,
     starting_cash, fee_pct, maker_fee_pct, slippage_pct, participation_rate, execution_model,
     risk_json, assumptions_json, metrics_json, trade_count, note, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, 0, 0, 0.25, 'legacy-unknown', '{}', ?, ?, ?, ?, ?, ?)`)
    .run(id, record.strategyId ?? null, record.strategyName ?? 'Legacy', '{}', record.symbol ?? '',
      record.timeframe ?? '', 'legacy-localStorage', 0, json({ legacy: true }),
      json(record.metrics ?? {}), record.tradeCount ?? 0,
      'Importované z localStorage (pred migráciou na SQLite)', record.at ?? nowMs(), record.at ?? nowMs());
  return res.changes > 0;
}

export function getBacktestRun(db, id) {
  const row = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id);
  if (!row) return null;
  const trades = db.prepare('SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY seq').all(id);
  const equity = db.prepare('SELECT time, equity, price FROM backtest_equity WHERE run_id = ? ORDER BY seq').all(id);
  return {
    id: String(row.id),
    strategyId: row.strategy_id ?? null,
    strategyName: String(row.strategy_name),
    strategySnapshot: parse(row.strategy_snapshot_json),
    symbol: String(row.symbol),
    timeframe: String(row.timeframe),
    dataSource: String(row.data_source),
    startingCash: Number(row.starting_cash),
    assumptions: parse(row.assumptions_json, {}),
    metrics: parse(row.metrics_json, {}),
    tradeCount: Number(row.trade_count),
    note: row.note ?? null,
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    trades: trades.map((t) => ({
      seq: Number(t.seq), symbol: String(t.symbol), qty: Number(t.qty),
      entryPrice: Number(t.entry_price), exitPrice: Number(t.exit_price),
      grossPnl: Number(t.gross_pnl), entryFee: Number(t.entry_fee), exitFee: Number(t.exit_fee),
      totalFees: Number(t.total_fees), netPnl: Number(t.net_pnl), netPnlPct: Number(t.net_pnl_pct),
      openedAt: t.opened_at === null ? null : Number(t.opened_at),
      closedAt: t.closed_at === null ? null : Number(t.closed_at),
      reason: t.reason ?? null, ruleId: t.rule_id ?? null, strategyId: t.strategy_id ?? null,
    })),
    equityCurve: equity.map((p) => ({ time: Number(p.time), equity: Number(p.equity), price: p.price === null ? null : Number(p.price) })),
  };
}

export function listBacktestRuns(db, { limit = 100, symbol = null, strategyId = null } = {}) {
  const where = [];
  const params = [];
  if (symbol) { where.push('symbol = ?'); params.push(symbol); }
  if (strategyId) { where.push('strategy_id = ?'); params.push(strategyId); }
  const sql = `SELECT id, strategy_id, strategy_name, symbol, timeframe, data_source, metrics_json, trade_count, created_at
    FROM backtest_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit).map((r) => ({
    id: String(r.id),
    strategyId: r.strategy_id ?? null,
    strategyName: String(r.strategy_name),
    symbol: String(r.symbol),
    timeframe: String(r.timeframe),
    dataSource: String(r.data_source),
    metrics: parse(r.metrics_json, {}),
    tradeCount: Number(r.trade_count),
    createdAt: Number(r.created_at),
  }));
}

export function deleteBacktestRun(db, id) {
  const res = db.prepare('DELETE FROM backtest_runs WHERE id = ?').run(id);
  return res.changes > 0;
}

/* ------------------------------------------------------------------- paper */

export function savePaperSession(db, session) {
  db.prepare(`INSERT INTO paper_sessions
    (id, symbol, timeframe, starting_cash, cash, equity, status, settings_json, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET cash = excluded.cash, equity = excluded.equity, status = excluded.status,
      settings_json = excluded.settings_json, ended_at = excluded.ended_at`)
    .run(session.id, session.symbol, session.timeframe, session.startingCash ?? 0, session.cash ?? 0,
      session.equity ?? null, session.status ?? 'running', json(session.settings ?? {}),
      session.startedAt ?? nowMs(), session.endedAt ?? null);
  return session.id;
}

export function appendPaperTrades(db, sessionId, trades) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO paper_trades
    (id, session_id, seq, symbol, qty, entry_price, exit_price, gross_pnl, entry_fee, exit_fee, total_fees,
     net_pnl, net_pnl_pct, opened_at, closed_at, reason, rule_id, strategy_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  withTransaction(db, () => {
    trades.forEach((t, i) => {
      const res = stmt.run(`legacy_trd_${sessionId}_${i}`, sessionId, i, t.symbol ?? '', t.qty ?? 0,
        t.entryPrice ?? 0, t.exitPrice ?? 0, t.grossPnl ?? 0, t.entryFee ?? 0, t.exitFee ?? 0,
        t.totalFees ?? t.fees ?? 0, t.netPnl ?? t.pnl ?? 0, t.netPnlPct ?? t.pnlPct ?? 0,
        t.openedAt ?? null, t.closedAt ?? null, t.reason ?? null, t.ruleId ?? null, t.strategyId ?? null);
      inserted += res.changes;
    });
  });
  return inserted;
}

export function appendPaperEquity(db, sessionId, points) {
  const stmt = db.prepare('INSERT INTO paper_equity (session_id, seq, time, equity, cash) VALUES (?, ?, ?, ?, ?)');
  let inserted = 0;
  withTransaction(db, () => {
    points.slice(-5000).forEach((p, i) => {
      stmt.run(sessionId, i, p.time ?? 0, p.equity ?? 0, p.cash ?? null);
      inserted += 1;
    });
  });
  return inserted;
}

export function listPaperSessions(db, { limit = 50 } = {}) {
  return db.prepare('SELECT * FROM paper_sessions ORDER BY started_at DESC LIMIT ?').all(limit).map((r) => ({
    id: String(r.id), symbol: String(r.symbol), timeframe: String(r.timeframe),
    startingCash: Number(r.starting_cash), cash: Number(r.cash),
    equity: r.equity === null ? null : Number(r.equity),
    status: String(r.status), startedAt: Number(r.started_at), endedAt: r.ended_at === null ? null : Number(r.ended_at),
  }));
}

/* ------------------------------------------------------------------- audit */

const SECRET_KEY = /(secret|api[_-]?key|signature|authorization|password|passphrase|token)/i;

/** Recursively redact anything that looks like a credential. */
export function redactSecrets(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (typeof value !== 'object') return typeof value === 'string' ? redactString(value) : value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) out[k] = '[REDACTED]';
    else out[k] = redactSecrets(v, depth + 1);
  }
  return out;
}

function redactString(text) {
  return text
    .replace(/\b(sk-[A-Za-z0-9]{12,})\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z0-9]{32,})\b(?=.*(?:key|secret|token))/gi, '[REDACTED]');
}

export function appendAudit(db, event, { sessionId = null, ref = null, payload = {}, at = null } = {}) {
  const safe = redactSecrets(payload ?? {});
  const info = db.prepare('INSERT INTO audit_log (at, session_id, event, ref, payload_json) VALUES (?, ?, ?, ?, ?)')
    .run(at ?? nowMs(), sessionId, event, ref, json(safe));
  return Number(info.lastInsertRowid);
}

export function listAudit(db, { limit = 200, sessionId = null } = {}) {
  const sql = `SELECT * FROM audit_log ${sessionId ? 'WHERE session_id = ?' : ''} ORDER BY id DESC LIMIT ?`;
  const rows = sessionId ? db.prepare(sql).all(sessionId, limit) : db.prepare(sql).all(limit);
  return rows.map((r) => ({
    id: Number(r.id), at: Number(r.at), sessionId: r.session_id ?? null, event: String(r.event),
    ref: r.ref ?? null, payload: parse(r.payload_json, {}),
  }));
}

export function appendRiskEvent(db, event) {
  const info = db.prepare('INSERT INTO risk_events (at, session_id, rule, level, message, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(event.at ?? nowMs(), event.sessionId ?? null, event.rule, event.level, event.message ?? null, json(redactSecrets(event.payload ?? {})));
  return Number(info.lastInsertRowid);
}

export function listRiskEvents(db, { limit = 200 } = {}) {
  return db.prepare('SELECT * FROM risk_events ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
    id: Number(r.id), at: Number(r.at), sessionId: r.session_id ?? null, rule: String(r.rule),
    level: String(r.level), message: r.message ?? null, payload: parse(r.payload_json, {}),
  }));
}

/* -------------------------------------------------------------- accounts */

export function upsertExchangeAccount(db, account) {
  db.prepare(`INSERT INTO exchange_accounts
    (id, environment, api_key_masked, api_key_fingerprint, permissions_json, account_json, status, connected_at, last_sync_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET environment = excluded.environment, api_key_masked = excluded.api_key_masked,
      api_key_fingerprint = excluded.api_key_fingerprint, permissions_json = excluded.permissions_json,
      account_json = excluded.account_json, status = excluded.status, last_sync_at = excluded.last_sync_at`)
    .run(account.id, account.environment, account.apiKeyMasked, account.apiKeyFingerprint ?? null,
      json(account.permissions ?? {}), json(account.account ?? {}), account.status ?? 'connected',
      account.connectedAt ?? nowMs(), account.lastSyncAt ?? null);
  return account.id;
}

export function listExchangeAccounts(db) {
  return db.prepare('SELECT * FROM exchange_accounts ORDER BY connected_at DESC').all().map((r) => ({
    id: String(r.id), environment: String(r.environment), apiKeyMasked: String(r.api_key_masked),
    apiKeyFingerprint: r.api_key_fingerprint ?? null, permissions: parse(r.permissions_json, {}),
    account: parse(r.account_json, {}), status: String(r.status),
    connectedAt: r.connected_at === null ? null : Number(r.connected_at),
    lastSyncAt: r.last_sync_at === null ? null : Number(r.last_sync_at),
  }));
}

export function deleteExchangeAccount(db, id) {
  return db.prepare('DELETE FROM exchange_accounts WHERE id = ?').run(id).changes > 0;
}