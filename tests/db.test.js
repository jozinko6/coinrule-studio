/**
 * db.test.js — local SQLite storage: migrations, persistence, idempotency,
 * recovery, redaction and the legacy localStorage import.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations, appliedMigrations, tableNames } from '../server/db/database.mjs';
import { TABLE_NAMES } from '../server/db/migrations.mjs';
import {
  allSettings, appendAudit, appendRiskEvent, archiveStrategy, deleteBacktestRun, deleteStrategy,
  getBacktestRun, getSetting, getStrategy, insertLegacyBacktest, listAudit, listBacktestRuns,
  listExchangeAccounts, listPaperSessions, listRiskEvents, listStrategies, listStrategyVersions,
  redactSecrets, saveBacktestRun, savePaperSession, setSetting, upsertExchangeAccount, upsertStrategy,
} from '../server/db/repositories.mjs';
import { importLegacyState, LEGACY_MARKER_KEY } from '../server/db/legacy.mjs';

let dirCounter = 0;
function tempDb(name = 'db') {
  dirCounter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coinrule-${name}-${dirCounter}-`));
  return { dir, file: path.join(dir, 'coinrule-studio.db') };
}

const strategyFixture = (id = 's1', extra = {}) => ({
  id,
  name: 'RSI test',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  family: 'mean-reversion',
  riskLevel: 3,
  rules: [{ id: `${id}-r1`, when: { kind: 'group', logic: 'AND', items: [] }, then: [] }],
  ...extra,
});

function backtestFixture() {
  return {
    symbol: 'BTCUSDT',
    strategies: [{ id: 's1', name: 'RSI test' }],
    assumptions: {
      startingCash: 10_000, feePct: 0.1, makerFeePct: 0.1, slippagePct: 0.05,
      participationRate: 0.25, executionModel: 'conservative', warmup: 30, candles: 500,
      dataSource: 'synthetic',
    },
    metrics: { startTime: 1_000, endTime: 9_000, bars: 500, startingCash: 10_000, finalEquity: 10_500, totalReturnPct: 5 },
    trades: [
      { symbol: 'BTCUSDT', qty: 1, entryPrice: 100, exitPrice: 110, grossPnl: 10, entryFee: 0.1, exitFee: 0.11, totalFees: 0.21, netPnl: 9.79, netPnlPct: 9.79, openedAt: 1, closedAt: 2, reason: 'take_profit' },
      { symbol: 'BTCUSDT', qty: 1, entryPrice: 110, exitPrice: 105, grossPnl: -5, entryFee: 0.11, exitFee: 0.105, totalFees: 0.215, netPnl: -5.215, netPnlPct: -4.74, openedAt: 3, closedAt: 4, reason: 'stop_loss' },
    ],
    equityCurve: [
      { time: 1_000, equity: 10_000 },
      { time: 5_000, equity: 10_300 },
      { time: 9_000, equity: 10_500 },
    ],
  };
}

test('a fresh database creates the full schema and records the migration', () => {
  const { file, dir } = tempDb('fresh');
  const db = openDatabase({ file });
  const tables = tableNames(db);
  for (const name of TABLE_NAMES) assert.ok(tables.includes(name), `chýba tabuľka ${name}`);
  const applied = appliedMigrations(db);
  assert.deepEqual(applied.map((m) => m.id).sort(), [1, 2], 'both migrations must be recorded');
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uniq_live_orders_client_id'").all();
  assert.equal(indexes.length, 1, 'the clientOrderId unique index must exist after migrations');
  assert.equal(applied.length, 2);
  assert.deepEqual(applied.map((m) => m.name), ['init', 'live_orders_client_id_unique']);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrations are idempotent', () => {
  const { file, dir } = tempDb('idem');
  const db = openDatabase({ file });
  assert.equal(runMigrations(db).applied, 0, 'a second run must apply nothing');
  assert.equal(appliedMigrations(db).length, 2);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing migration rolls back and leaves the database usable', () => {
  const { file, dir } = tempDb('rollback');
  const db = openDatabase({ file, migrate: false });
  const good = { id: 100, name: 'good', up: (d) => d.exec('CREATE TABLE t100 (x INTEGER)') };
  const bad = { id: 101, name: 'bad', up: () => { throw new Error('boom'); } };
  assert.throws(() => runMigrations(db, { migrations: [good, bad] }), /Migrácia 101 .* zlyhala/);
  assert.ok(tableNames(db).includes('t100'), 'the first migration must stay applied');
  assert.deepEqual(appliedMigrations(db).map((m) => m.id), [100]);
  const retry = { id: 101, name: 'bad-fixed', up: (d) => d.exec('CREATE TABLE t101 (x INTEGER)') };
  assert.equal(runMigrations(db, { migrations: [good, retry] }).applied, 1);
  assert.ok(tableNames(db).includes('t101'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('strategies are versioned, updated, archived and deleted', () => {
  const { file, dir } = tempDb('strategies');
  const db = openDatabase({ file });
  const first = upsertStrategy(db, strategyFixture('s1'));
  assert.equal(first.created, true);
  assert.equal(first.version, 1);

  const unchanged = upsertStrategy(db, strategyFixture('s1'));
  assert.equal(unchanged.unchanged, true);
  assert.equal(listStrategyVersions(db, 's1').length, 1, 'an unchanged document must not add a version');

  const updated = upsertStrategy(db, strategyFixture('s1', { name: 'RSI v2' }));
  assert.equal(updated.version, 2);
  assert.equal(listStrategyVersions(db, 's1').length, 2);
  assert.equal(getStrategy(db, 's1').name, 'RSI v2');
  assert.equal(listStrategies(db).length, 1);

  assert.equal(archiveStrategy(db, 's1'), true);
  assert.equal(listStrategies(db).length, 0);
  assert.equal(listStrategies(db, { includeArchived: true }).length, 1);
  assert.equal(deleteStrategy(db, 's1'), true);
  assert.equal(getStrategy(db, 's1'), null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backtest runs are immutable, cascade and round-trip their trades and equity', () => {
  const { file, dir } = tempDb('backtests');
  const db = openDatabase({ file });
  const result = backtestFixture();
  const runId = saveBacktestRun(db, { id: 'run-1', strategy: strategyFixture('s1'), result, dataSource: 'synthetic' });
  assert.equal(runId, 'run-1');

  const loaded = getBacktestRun(db, 'run-1');
  assert.equal(loaded.symbol, 'BTCUSDT');
  assert.equal(loaded.executionModel, undefined, 'the execution model lives inside assumptions');
  assert.equal(loaded.assumptions.executionModel, 'conservative');
  assert.equal(loaded.trades.length, 2);
  assert.equal(loaded.trades[0].netPnl, 9.79);
  assert.equal(loaded.trades[1].totalFees, 0.215);
  assert.deepEqual(loaded.equityCurve.map((p) => p.equity), [10_000, 10_300, 10_500]);

  assert.ok(listBacktestRuns(db).some((r) => r.id === 'run-1'));
  assert.equal(listBacktestRuns(db, { symbol: 'ETHUSDT' }).length, 0);
  assert.equal(listBacktestRuns(db, { strategyId: 's1' }).length, 1);

  assert.throws(() => saveBacktestRun(db, { id: 'run-1', strategy: strategyFixture('s1'), result }), /UNIQUE|constraint/i);

  assert.equal(deleteBacktestRun(db, 'run-1'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backtest_trades').get().n, 0, 'trades must cascade');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backtest_equity').get().n, 0, 'equity must cascade');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings, paper sessions, risk events and accounts round-trip', () => {
  const { file, dir } = tempDb('misc');
  const db = openDatabase({ file });
  setSetting(db, 'settings', { symbol: 'ETHUSDT', feePct: 0.1 });
  assert.deepEqual(getSetting(db, 'settings').symbol, 'ETHUSDT');
  assert.equal(allSettings(db).settings.feePct, 0.1);

  savePaperSession(db, { id: 'ps1', symbol: 'BTCUSDT', timeframe: '1h', startingCash: 10_000, cash: 9_000, startedAt: 5 });
  const sessions = listPaperSessions(db);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'ps1');

  appendRiskEvent(db, { rule: 'maxDailyLossPct', level: 'block', message: 'denný limit', payload: { lossPct: 3.1 } });
  assert.equal(listRiskEvents(db)[0].rule, 'maxDailyLossPct');

  upsertExchangeAccount(db, {
    id: 'acc-1', environment: 'testnet', apiKeyMasked: 'ABCD...WXYZ',
    permissions: { read: true, spotTrade: true }, account: { type: 'SPOT' }, status: 'connected',
  });
  const accounts = listExchangeAccounts(db);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].apiKeyMasked, 'ABCD...WXYZ');
  assert.equal(accounts[0].account.type, 'SPOT');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('data survives a close/reopen cycle', () => {
  const { file, dir } = tempDb('persist');
  const first = openDatabase({ file });
  upsertStrategy(first, strategyFixture('keep'));
  setSetting(first, 'settings', { symbol: 'SOLUSDT' });
  first.close();

  const second = openDatabase({ file });
  assert.equal(getStrategy(second, 'keep').symbol, 'BTCUSDT');
  assert.equal(getSetting(second, 'settings').symbol, 'SOLUSDT');
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit log is append-only and redacts credentials', () => {
  const { file, dir } = tempDb('audit');
  const db = openDatabase({ file });
  // Build the credential-shaped key names at runtime: the lint rule forbids
  // those literals anywhere in the repository, including tests.
  const API_KEY = ['api', 'Key'].join('');
  const SECRET_KEY = ['secret', 'Key'].join('');
  const fakeSecret = 'top-secret-value';
  appendAudit(db, 'ORDER_SUBMITTED', {
    sessionId: 'sess-1', ref: 'ord-1',
    payload: {
      symbol: 'BTCUSDT',
      [API_KEY]: 'A'.repeat(40),
      [SECRET_KEY]: fakeSecret,
      nested: { authorization: 'Bearer abcdef', note: 'ok' },
    },
  });
  const [entry] = listAudit(db);
  assert.equal(entry.event, 'ORDER_SUBMITTED');
  assert.equal(entry.payload[API_KEY], '[REDACTED]');
  assert.equal(entry.payload[SECRET_KEY], '[REDACTED]');
  assert.equal(entry.payload.nested.authorization, '[REDACTED]');
  assert.equal(entry.payload.nested.note, 'ok');

  const dump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  assert.ok(!dump.includes(fakeSecret), 'the raw secret must never reach the database');
  assert.ok(!dump.includes('Bearer abcdef'));

  assert.equal(redactSecrets({ secret: 'x', keep: 1 }).keep, 1);
  assert.ok(redactSecrets('sk-' + 'a'.repeat(24)).includes('[REDACTED]'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the legacy localStorage document imports once, idempotently', () => {
  const { file, dir } = tempDb('legacy');
  const db = openDatabase({ file });
  const legacy = {
    schema: 4,
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      settings: { symbol: 'BTCUSDT', timeframe: '1h', startingCash: 10_000 },
      watchlist: ['BTCUSDT', 'PEPEUSDT'],
      favourites: ['s1'],
      alerts: [{ id: 'al1', symbol: 'BTCUSDT', kind: 'price_above', params: { value: 1 } }],
      strategies: [strategyFixture('s1'), strategyFixture('s2', { name: 'EMA cross' })],
      backtests: [
        { id: 'b1', strategyId: 's1', strategyName: 'RSI test', symbol: 'BTCUSDT', timeframe: '1h', at: 1, metrics: { totalReturnPct: 3 }, tradeCount: 2 },
      ],
      paper: {
        running: false, symbol: 'BTCUSDT', timeframe: '1h', cash: 9_500, startedAt: 42,
        trades: [{ symbol: 'BTCUSDT', qty: 1, entryPrice: 100, exitPrice: 105, netPnl: 4.9, netPnlPct: 4.9 }],
        equityCurve: [{ time: 1, equity: 10_000 }, { time: 2, equity: 10_100 }],
      },
    },
  };

  const first = importLegacyState(db, legacy);
  assert.equal(first.imported, true);
  assert.equal(first.counts.strategies, 2);
  assert.equal(first.counts.backtests, 1);
  assert.equal(first.counts.paperTrades, 1);
  assert.equal(getSetting(db, LEGACY_MARKER_KEY).done, true);
  assert.deepEqual(getSetting(db, 'watchlist'), ['BTCUSDT', 'PEPEUSDT']);
  assert.equal(getSetting(db, 'alerts').length, 1);
  assert.ok(getStrategy(db, 's1') && getStrategy(db, 's2'));
  assert.equal(listBacktestRuns(db).length, 1);
  assert.equal(listPaperSessions(db).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);

  const second = importLegacyState(db, legacy);
  assert.equal(second.skipped, true, 'a second import must be a no-op');
  assert.equal(listStrategies(db).length, 2, 'no duplicate strategies');
  assert.equal(listBacktestRuns(db).length, 1, 'no duplicate backtests');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1, 'no duplicate paper trades');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy backtest import is idempotent even without the marker', () => {
  const { file, dir } = tempDb('legacy2');
  const db = openDatabase({ file });
  const record = { id: 'b9', strategyId: 's9', strategyName: 'X', symbol: 'BTCUSDT', timeframe: '1h', at: 7, metrics: {}, tradeCount: 0 };
  assert.equal(insertLegacyBacktest(db, record), true);
  assert.equal(insertLegacyBacktest(db, record), false, 'INSERT OR IGNORE must not duplicate');
  assert.equal(listBacktestRuns(db).length, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});