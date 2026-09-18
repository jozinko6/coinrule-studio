/**
 * app.mjs — the local CoinRule Studio backend (Phases 6 + 15).
 *
 * Design rules:
 *   - binds 127.0.0.1 by default; 0.0.0.0 requires an explicit env opt-in;
 *   - serves the frontend from the project root (one process = one-click start);
 *   - /api/* is JSON only, CORS limited to loopback origins;
 *   - every /api route except health/ping requires the session admin token,
 *     which is printed to the local console and stored in RAM only;
 *   - GET /api/health reports database + mode so the launcher can wait for it;
 *   - default mode is PAPER; live trading can never be enabled implicitly.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIME, resolvePath } from '../tools/serve.mjs';
import { defaultDbPath, openDatabase, appliedMigrations } from './db/database.mjs';
import { SCHEMA_VERSION } from './db/migrations.mjs';
import { createTradingContext } from './services/trading-context.mjs';
import { deleteBacktestRun, getBacktestRun, listBacktestRuns, saveBacktestRun } from './db/repositories.mjs';
import { BinanceApiError, BinanceTimeoutError } from './exchange/binance-private.mjs';
import { RiskViolation } from './services/live-risk.mjs';
import { ModeTransitionError } from './services/mode.mjs';
import { ExecutionRefused } from './services/execution-broker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const APP_VERSION = '1.0.0';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const ALLOW_LAN_ENV = 'COINRULE_ALLOW_LAN';
export const ADMIN_TOKEN_ENV = 'COINRULE_ADMIN_TOKEN';
export const ADMIN_HEADER = 'X-CoinRule-Token';
export const MAX_BODY_BYTES = 256 * 1024;

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

function readJson(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Telo požiadavky je príliš veľké.'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Neplatný JSON.'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function errorResponse(err) {
  if (err instanceof RiskViolation) return { status: 409, body: { ok: false, error: 'risk', check: err.check, message: err.message, details: err.details } };
  if (err instanceof ExecutionRefused) return { status: 409, body: { ok: false, error: 'refused', check: err.check, message: err.message, details: err.details } };
  if (err instanceof ModeTransitionError) return { status: 400, body: { ok: false, error: 'mode', reason: err.reason, message: err.message } };
  if (err instanceof BinanceTimeoutError) return { status: 504, body: { ok: false, error: 'timeout', code: err.code, message: err.message, requestAccepted: err.requestAccepted } };
  if (err instanceof BinanceApiError) return { status: 502, body: { ok: false, error: 'exchange', status: err.status, code: err.code, message: err.message, retryAfter: err.retryAfter } };
  const status = err?.statusCode ?? 500;
  return { status, body: { ok: false, error: status >= 500 ? 'internal' : 'bad_request', message: err.message } };
}

export function createApp({ root = ROOT, dbPath = null, clock = () => Date.now(), quiet = true, adminToken = null, trading = null } = {}) {
  const startedAt = clock();
  const token = adminToken ?? process.env[ADMIN_TOKEN_ENV] ?? crypto.randomBytes(24).toString('hex');
  let db = null;
  let dbError = null;
  try {
    db = openDatabase({ file: dbPath ?? defaultDbPath() });
  } catch (err) {
    dbError = err?.message ?? String(err);
  }

  let context = null;
  if (db) {
    try {
      context = typeof trading === 'function' ? trading(db) : (trading ?? createTradingContext({ db, clock }));
    } catch (err) {
      dbError = `trading context: ${err?.message ?? err}`;
    }
  }

  const state = {
    startedAt,
    requests: 0,
    lastRequestAt: null,
  };

  const currentMode = () => context?.mode?.mode ?? 'paper';

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
      mode: currentMode(),
      liveEnabled: Boolean(context?.mode?.isLive),
      authRequired: true,
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

  function assertToken(req, res) {
    const provided = req.headers[ADMIN_HEADER.toLowerCase()] ?? req.headers[ADMIN_HEADER];
    if (!provided || provided !== token) {
      sendJson(res, 401, { ok: false, error: 'unauthorized', message: `Chýba alebo nesprávny ${ADMIN_HEADER} header.` });
      return false;
    }
    return true;
  }

  async function handleApi(req, res, urlPath, url) {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      return sendJson(res, 403, { ok: false, error: 'cors', message: 'Povolené sú len lokálne (loopback) pôvody.' });
    }
    const headers = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': `Content-Type, ${ADMIN_HEADER}`, 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const respond = (status, body) => sendJson(res, status, body, headers);

    if (urlPath === '/api/health' && req.method === 'GET') {
      const body = health();
      return respond(body.ok ? 200 : 503, body);
    }
    if (urlPath === '/api/ping' && req.method === 'GET') return respond(200, { ok: true, pong: true });

    if (!assertToken(req, res)) return;
    if (!context) return respond(503, { ok: false, error: 'db_unavailable', message: dbError ?? 'Databáza nie je pripravená.' });

    if (urlPath === '/api/status' && req.method === 'GET') return respond(200, { ok: true, ...context.snapshot() });
    if (urlPath === '/api/mode' && req.method === 'GET') return respond(200, { ok: true, ...context.mode.snapshot() });
    if (urlPath === '/api/risk' && req.method === 'GET') return respond(200, { ok: true, ...context.guard.snapshot() });
    if (urlPath === '/api/sessions' && req.method === 'GET') return respond(200, { ok: true, sessions: context.listSessions(20) });

    if (urlPath === '/api/mode' && req.method === 'POST') {
      const body = await readJson(req);
      const action = String(body.action ?? '');
      if (action === 'paper') context.mode.goPaper();
      else if (action === 'offline') context.mode.goOffline();
      else if (action === 'testnet') context.mode.goTestnet();
      else if (action === 'live') context.mode.enableLive({ confirm: body.confirm, acknowledgeRisk: body.acknowledgeRisk });
      else if (action === 'disable') context.mode.disableLive();
      else throw Object.assign(new Error(`Neznáma akcia: ${action}`), { statusCode: 400 });
      return respond(200, { ok: true, ...context.mode.snapshot() });
    }

    if (urlPath === '/api/risk/killswitch' && req.method === 'POST') {
      const body = await readJson(req);
      context.guard.setKillSwitch(Boolean(body.engaged));
      return respond(200, { ok: true, ...context.guard.snapshot() });
    }

    if (urlPath === '/api/credentials' && req.method === 'POST') {
      const body = await readJson(req);
      context.applyCredentials({ key: body.key, secret: body.secret });
      return respond(200, { ok: true, credentials: context.snapshot().credentials });
    }
    if (urlPath === '/api/credentials' && req.method === 'DELETE') {
      context.clearCredentials();
      return respond(200, { ok: true, credentials: context.snapshot().credentials });
    }

    if (urlPath === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req);
      const session = context.startSession({ environment: body.environment ?? context.mode.mode, symbol: body.symbol ?? null });
      return respond(201, { ok: true, session });
    }
    if (urlPath === '/api/sessions/reconcile' && req.method === 'POST') {
      const body = await readJson(req);
      const report = await context.reconcile(String(body.sessionId ?? ''));
      return respond(report.state === 'failed' ? 502 : 200, { ok: report.state !== 'failed', report });
    }

    if (urlPath === '/api/price' && req.method === 'GET') {
      const symbol = url.searchParams.get('symbol');
      if (!symbol) throw Object.assign(new Error('Chýba symbol.'), { statusCode: 400 });
      const quote = await context.publicPrice(symbol);
      return respond(200, { ok: true, symbol: quote.symbol, price: quote.price });
    }
    if (urlPath === '/api/backtests' && req.method === 'GET') {
      const rawLimit = Number(url.searchParams.get('limit') ?? 50);
      const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));
      return respond(200, { ok: true, runs: listBacktestRuns(db, { limit }) });
    }
    if (urlPath === '/api/backtests' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.result || typeof body.result !== 'object') {
        throw Object.assign(new Error('Chýba result (výsledok backtestu).'), { statusCode: 400 });
      }
      saveBacktestRun(db, {
        strategy: body.strategy ?? (body.strategyName ? { name: body.strategyName } : null),
        result: body.result,
        dataSource: body.dataSource ?? 'ui',
        note: body.note ?? null,
      });
      const [latest] = listBacktestRuns(db, { limit: 1 });
      return respond(201, { ok: true, run: latest });
    }
    if (urlPath.startsWith('/api/backtests/') && req.method === 'GET') {
      const id = decodeURIComponent(urlPath.slice('/api/backtests/'.length));
      const run = getBacktestRun(db, id);
      if (!run) return respond(404, { ok: false, error: 'not_found', message: 'Backtest neexistuje.' });
      return respond(200, { ok: true, run });
    }
    if (urlPath.startsWith('/api/backtests/') && req.method === 'DELETE') {
      const id = decodeURIComponent(urlPath.slice('/api/backtests/'.length));
      const removed = deleteBacktestRun(db, id);
      return respond(removed ? 200 : 404, { ok: removed });
    }

    if (urlPath === '/api/stream' && req.method === 'GET') return respond(200, { ok: true, stream: context.streamStatus() });
    if (urlPath === '/api/stream/start' && req.method === 'POST') {
      const body = await readJson(req);
      const status = context.startStream(String(body.sessionId ?? ''), {
        ...(body.intervalMs ? { intervalMs: Number(body.intervalMs) } : {}),
        ...(body.staleAfterMs ? { staleAfterMs: Number(body.staleAfterMs) } : {}),
      });
      return respond(200, { ok: true, stream: status });
    }
    if (urlPath === '/api/stream/stop' && req.method === 'POST') {
      context.stopStream();
      return respond(200, { ok: true, stream: context.streamStatus() });
    }

    if (urlPath === '/api/orders' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) throw Object.assign(new Error('Chýba sessionId.'), { statusCode: 400 });
      return respond(200, { ok: true, orders: context.listOrders(sessionId) });
    }
    if (urlPath === '/api/orders' && req.method === 'POST') {
      const body = await readJson(req);
      const session = context.getSession(String(body.sessionId ?? ''));
      // A market order carries no price; the risk guard and the filters still
      // need one, so the backend supplies the public ticker itself.
      let referencePrice = body.referencePrice ?? null;
      if (!referencePrice && !body.price && body.symbol) {
        try { referencePrice = (await context.publicPrice(body.symbol)).price; }
        catch { throw Object.assign(new Error('Cenu pre trhový príkaz sa nepodarilo zistiť.'), { statusCode: 502 }); }
      }
      const result = await context.broker.placeOrder({
        session,
        symbol: body.symbol, side: body.side, type: body.type,
        quantity: body.quantity, price: body.price ?? null, referencePrice,
        intentId: body.intentId, reduceOnly: Boolean(body.reduceOnly),
      });
      return respond(200, { ok: true, ...result });
    }
    if (urlPath === '/api/orders/cancel' && req.method === 'POST') {
      const body = await readJson(req);
      const session = context.getSession(String(body.sessionId ?? ''));
      const result = await context.broker.cancelOrder({
        session, symbol: body.symbol, orderId: body.orderId ?? null, clientOrderId: body.clientOrderId ?? null,
      });
      return respond(200, { ok: true, order: result });
    }

    return respond(404, { ok: false, error: 'not_found', message: `Neznáma API cesta: ${urlPath}` });
  }

  const server = http.createServer((req, res) => {
    state.requests += 1;
    state.lastRequestAt = clock();
    const url = new URL(req.url ?? '/', `http://${DEFAULT_HOST}`);
    const urlPath = url.pathname;
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      handleApi(req, res, urlPath, url).catch((err) => {
        const { status, body } = errorResponse(err);
        if (!res.headersSent) sendJson(res, status, body);
        else res.end();
      });
      return;
    }
    return serveStatic(req, res, req.url ?? '/');
  });

  const app = {
    server,
    state,
    adminToken: token,
    get db() { return db; },
    get dbError() { return dbError; },
    get trading() { return context; },
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
      try { context?.stopStream?.(); } catch { /* stream already stopped */ }
      if (db) {
        try { db.close(); } catch { /* already closed */ }
        db = null;
      }
      return true;
    },
  };
  return app;
}

export function startApp({ port = DEFAULT_PORT, host = DEFAULT_HOST, root = ROOT, dbPath = null, quiet = false, adminToken = null, trading = null } = {}) {
  if (!isLoopbackHost(host) && process.env[ALLOW_LAN_ENV] !== '1') {
    return Promise.reject(new Error(`Odmietnuté: host ${host} nie je loopback. Pre LAN nastav ${ALLOW_LAN_ENV}=1 (nedporúčané).`));
  }
  const app = createApp({ root, dbPath, quiet, adminToken, trading });
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => {
      const actual = app.server.address().port;
      const url = `http://${host}:${actual}`;
      if (!quiet) {
        const status = app.health();
        process.stdout.write(`\n  CoinRule Studio backend\n  ${url}\n  mód: ${status.mode}  db: ${status.db.ok ? 'ok' : 'CHYBA'}  live: ${status.liveEnabled ? 'ON' : 'off'}\n`);
        process.stdout.write(`  admin token (ulož si ho do Settings): ${app.adminToken}\n  (Ctrl+C pre ukončenie)\n\n`);
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