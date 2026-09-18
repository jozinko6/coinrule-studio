/**
 * trading-context.mjs — one object owning the live-trading stack (Phase 15).
 *
 * Credentials are provided at runtime (environment or the Settings API) and are
 * kept in RAM only: nothing is written to the DB, disk, logs or URLs. The
 * exchange client is rebuilt when the mode changes because testnet and live use
 * different hosts.
 */

import { BinancePrivate } from '../exchange/binance-private.mjs';
import { SymbolRulesCache } from '../exchange/filters.mjs';
import { LiveRiskGuard } from './live-risk.mjs';
import { TradingModeManager } from './mode.mjs';
import { OrderIdempotency } from './idempotency.mjs';
import { Reconciler } from './reconciliation.mjs';
import { ExecutionBroker } from './execution-broker.mjs';
import { createLiveSession, getLiveSession, listLiveOrders, listLiveSessions } from '../db/live-repository.mjs';
import { UserStreamPoller } from './user-stream.mjs';

export const CREDENTIAL_ENV = Object.freeze({
  key: 'COINRULE_BINANCE_KEY',
  secret: 'COINRULE_BINANCE_SECRET',
  baseUrl: 'COINRULE_BINANCE_BASE',
});

export const HOSTS = Object.freeze({
  testnet: 'https://testnet.binance.vision',
  live: 'https://api.binance.com',
});

export function createTradingContext({
  db, env = process.env, clock = () => Date.now(), fetchImpl = globalThis.fetch,
  clientFactory = null, limits = {},
} = {}) {
  if (!db) throw new Error('createTradingContext: chýba db.');

  let credentials = env[CREDENTIAL_ENV.key] && env[CREDENTIAL_ENV.secret]
    ? { key: env[CREDENTIAL_ENV.key], secret: env[CREDENTIAL_ENV.secret] }
    : null;
  const baseOverride = env[CREDENTIAL_ENV.baseUrl] || null;
  const clients = new Map();

  const guard = new LiveRiskGuard({ limits, clock });
  const idempotency = new OrderIdempotency({ db });

  const buildClient = (host) => {
    if (!credentials) return null;
    if (clientFactory) return clientFactory(host);
    return new BinancePrivate({
      apiKey: credentials.key, apiSecret: credentials.secret, baseUrl: host, fetchImpl, clock,
    });
  };

  const clientFor = (modeName) => {
    const host = baseOverride ?? HOSTS[modeName] ?? HOSTS.testnet;
    if (!clients.has(host)) clients.set(host, buildClient(host));
    return clients.get(host);
  };

  let broker = null;
  let reconciler = null;
  let stream = null;

  const mode = new TradingModeManager({
    clock,
    hasCredentials: () => Boolean(credentials),
    onTransition: () => { rebuild(); },
  });

  function rebuild() {
    const client = clientFor(mode.mode);
    if (!client) { broker = null; reconciler = null; return; }
    const rulesCache = new SymbolRulesCache({ fetchExchangeInfo: () => client.exchangeInfo(), clock });
    broker = new ExecutionBroker({ mode, guard, rulesCache, idempotency, client, clock });
    reconciler = new Reconciler({ db, client, clock });
  }

  const context = {
    get mode() { return mode; },
    get guard() { return guard; },
    get db() { return db; },
    get hasCredentials() { return Boolean(credentials); },
    get broker() { return broker; },
    get reconciler() { return reconciler; },
    get client() { return clientFor(mode.mode); },

    /** In-memory only; never persisted. */
    applyCredentials({ key, secret } = {}) {
      if (!key || !secret) throw Object.assign(new Error('Chýba key alebo secret.'), { statusCode: 400 });
      credentials = { key: String(key), secret: String(secret) };
      clients.clear();
      rebuild();
      return true;
    },
    clearCredentials() {
      credentials = null;
      clients.clear();
      broker = null;
      reconciler = null;
    },

    startSession({ environment = mode.mode, symbol = null } = {}) {
      if (environment !== 'testnet' && environment !== 'live') {
        throw Object.assign(new Error('Live session môže byť len testnet/live.'), { statusCode: 400 });
      }
      return createLiveSession(db, { environment, symbol });
    },
    getSession(id) { return getLiveSession(db, id); },
    async reconcile(sessionId) {
      const session = getLiveSession(db, sessionId);
      if (!session) throw Object.assign(new Error('Session neexistuje.'), { statusCode: 404 });
      if (!reconciler) throw Object.assign(new Error('Reconciliation vyžaduje API kľúče.'), { statusCode: 409 });
      return reconciler.reconcileSession(session);
    },
    /** Public ticker. Uses the signed client when available, plain fetch otherwise. */
    async publicPrice(symbol) {
      const client = clientFor(mode.mode);
      if (client) return { symbol, price: await client.tickerPrice(symbol) };
      const host = baseOverride ?? HOSTS[mode.mode] ?? HOSTS.testnet;
      const res = await fetchImpl(host + '/api/v3/ticker/price?symbol=' + encodeURIComponent(symbol));
      if (!res.ok) throw Object.assign(new Error('Ticker HTTP ' + res.status), { statusCode: 502 });
      const body = await res.json();
      const price = Number(body?.price);
      if (!Number.isFinite(price)) throw Object.assign(new Error('Neplatná odpoveď tickeru.'), { statusCode: 502 });
      return { symbol, price };
    },

    listOrders(sessionId) { return listLiveOrders(db, sessionId); },
    listSessions(limit = 10) { return listLiveSessions(db, { limit }); },

    /** Polling user-data stream for one session (stale -> kill switch). */
    startStream(sessionId, options = {}) {
      this.stopStream();
      const session = getLiveSession(db, sessionId);
      if (!session) throw Object.assign(new Error('Session neexistuje.'), { statusCode: 404 });
      if (!reconciler) throw Object.assign(new Error('User data stream vyžaduje API kľúče.'), { statusCode: 409 });
      stream = new UserStreamPoller({ session, reconciler, guard, clock, ...options });
      stream.start();
      return stream.status();
    },
    stopStream() {
      if (stream) { stream.stop(); stream = null; }
      return true;
    },
    streamStatus() { return stream ? stream.status() : { running: false, sessionId: null }; },

    snapshot() {
      return {
        mode: mode.snapshot(),
        risk: guard.snapshot(),
        credentials: {
          configured: Boolean(credentials),
          keyMasked: credentials ? `${String(credentials.key).slice(0, 4)}...${String(credentials.key).slice(-4)}` : null,
        },
        sessions: listLiveSessions(db, { limit: 5 }),
        brokerReady: Boolean(broker),
      };
    },
  };

  rebuild();
  return context;
}