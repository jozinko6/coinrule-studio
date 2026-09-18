/**
 * app.mjs — the local CoinRule Studio backend (Phase 6).
 *
 * Design rules:
 *   - binds 127.0.0.1 by default; 0.0.0.0 requires an explicit env opt-in;
 *   - serves the frontend from the project root (one process = one-click start);
 *   - /api/* is JSON only, CORS limited to loopback origins;
 *   - GET /api/health reports database + mode so the launcher can wait for it;
 *   - default mode is PAPER; live trading can never be enabled implicitly.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIME, resolvePath } from '../tools/serve.mjs';
import { defaultDbPath, openDatabase, appliedMigrations } from './db/database.mjs';
import { SCHEMA_VERSION } from './db/migrations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const APP_VERSION = '1.0.0';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const ALLOW_LAN_ENV = 'COINRULE_ALLOW_LAN';

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function originAllowed(origin) {
  if (!origin) return true; // same-origin / non-browser clients send no Origin
  return LOOPBACK_ORIGIN.test(origin);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(text);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

export function createApp({ root = ROOT, dbPath = null, clock = () => Date.now(), quiet = true } = {}) {
  const startedAt = clock();
  let db = null;
  let dbError = null;
  try {
    db = openDatabase({ file: dbPath ?? defaultDbPath() });
  } catch (err) {
    dbError = err?.message ?? String(err);
  }

  const state = {
    mode: 'paper',
    liveEnabled: false,
    startedAt,
    requests: 0,
    lastRequestAt: null,
  };

  function health() {
    let dbInfo = { ok: false, error: dbError ?? 'not opened' };
    if (db) {
      try {
        const migrations = appliedMigrations(db).length;
        dbInfo = { ok: true, file: dbPath ?? defaultDbPath(), schemaVersion: SCHEMA_VERSION, migrations };
      } catch (err) {
        dbInfo = { ok: false, error: err?.message ?? String(err) };
      }
    }
    const ok = dbInfo.ok;
    return {
      ok,
      app: 'coinrule-studio',
      version: APP_VERSION,
      host: DEFAULT_HOST,
      uptimeMs: clock() - startedAt,
      mode: state.mode,
      liveEnabled: state.liveEnabled,
      db: dbInfo,
      requests: state.requests,
    };
  }

  function serveStatic(req, res, urlPath) {
    const full = resolvePath(urlPath, root);
    // Private (server/, data/, .git/) or escaping paths stay invisible.
    if (!full) return sendText(res, 404, '404 Nenájdené');
    fs.stat(full, (err, stat) => {
      if (err || !stat.isFile()) return sendText(res, 404, '404 Nenájdené');
      const ext = path.extname(full).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      };
      if (ext === '.html') {
        headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'";
      }
      res.writeHead(200, headers);
      fs.createReadStream(full).pipe(res);
    });
  }

  function handleApi(req, res, urlPath) {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      return sendJson(res, 403, { ok: false, error: 'cors', message: 'Povolené sú len lokálne (loopback) pôvody.' });
    }
    const headers = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (urlPath === '/api/health' && req.method === 'GET') {
      const body = health();
      return sendJson(res, body.ok ? 200 : 503, body, headers);
    }
    if (urlPath === '/api/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, pong: true }, headers);
    }
    return sendJson(res, 404, { ok: false, error: 'not_found', message: `Neznáma API cesta: ${urlPath}` }, headers);
  }

  const server = http.createServer((req, res) => {
    state.requests += 1;
    state.lastRequestAt = clock();
    const urlPath = (req.url ?? '/').split('?')[0];
    if (urlPath === '/api' || urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);
    return serveStatic(req, res, req.url ?? '/');
  });

  const app = {
    server,
    state,
    get db() { return db; },
    get dbError() { return dbError; },
    health,
    url() {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      return port ? `http://${DEFAULT_HOST}:${port}` : null;
    },
    async close({ force = false } = {}) {
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        if (force && typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      if (db) {
        try { db.close(); } catch { /* already closed */ }
        db = null;
      }
      return true;
    },
  };
  return app;
}

export function startApp({ port = DEFAULT_PORT, host = DEFAULT_HOST, root = ROOT, dbPath = null, quiet = false } = {}) {
  if (!isLoopbackHost(host) && process.env[ALLOW_LAN_ENV] !== '1') {
    return Promise.reject(new Error(`Odmietnuté: host ${host} nie je loopback. Pre LAN nastav ${ALLOW_LAN_ENV}=1 (nedporúčané).`));
  }
  const app = createApp({ root, dbPath, quiet });
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => {
      const actual = app.server.address().port;
      const url = `http://${host}:${actual}`;
      if (!quiet) {
        const status = app.health();
        process.stdout.write(`\n  CoinRule Studio backend\n  ${url}\n  mód: ${status.mode}  db: ${status.db.ok ? 'ok' : 'CHYBA'}  live: ${status.liveEnabled ? 'ON' : 'off'}\n  (Ctrl+C pre ukončenie)\n\n`);
      }
      resolve({ app, server: app.server, port: actual, url });
    });
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const args = process.argv.slice(2);
  const readFlag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const port = Number(readFlag('--port', process.env.COINRULE_PORT ?? DEFAULT_PORT));
  const host = readFlag('--host', DEFAULT_HOST);
  const dbPath = readFlag('--db', null);
  startApp({ port, host, dbPath })
    .then(({ app }) => {
      const shutdown = async (signal) => {
        process.stdout.write(`\n  ${signal}: zatváram…\n`);
        await app.close({ force: true });
        process.exit(0);
      };
      process.on('SIGINT', () => { void shutdown('SIGINT'); });
      process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    })
    .catch((err) => { process.stderr.write(`Štart zlyhal: ${err.message}\n`); process.exit(1); });
}