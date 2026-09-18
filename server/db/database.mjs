/**
 * database.mjs — local SQLite database (built-in `node:sqlite`, zero deps).
 *
 * The database file lives in `<project>/data/coinrule-studio.db` and the whole
 * `data/` directory is git-ignored: it contains the user's local state only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function projectRoot() {
  return path.resolve(HERE, '..', '..');
}

export function defaultDataDir() {
  return path.join(projectRoot(), 'data');
}

export function defaultDbPath() {
  return path.join(defaultDataDir(), 'coinrule-studio.db');
}

/** Open (and by default migrate) the database. */
export function openDatabase({ file = defaultDbPath(), migrate = true, migrations = MIGRATIONS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  if (migrate) runMigrations(db, { migrations });
  return db;
}

/** Apply every pending migration in order. Idempotent by design. */
export function runMigrations(db, { migrations = MIGRATIONS, onError = null } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => Number(r.id)));
  const pending = migrations.filter((m) => !applied.has(m.id)).sort((a, b) => a.id - b.id);
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, migration.name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      onError?.(err, migration);
      throw new Error(`Migrácia ${migration.id} (${migration.name}) zlyhala: ${err.message}`);
    }
  }
  return { applied: pending.length, total: migrations.length };
}

export function appliedMigrations(db) {
  return db.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all()
    .map((r) => ({ id: Number(r.id), name: String(r.name), appliedAt: Number(r.applied_at) }));
}

export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Callback-based transaction wrapper for async callers. */
export async function withTransactionAsync(db, fn) {
  db.exec('BEGIN');
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => String(r.name));
}