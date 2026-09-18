/**
 * api.test.js — the Phase 15 HTTP surface: admin token, modes, credentials,
 * risk, sessions, orders — exercised end-to-end against the mock exchange.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from '../server/app.mjs';
import { createTradingContext } from '../server/services/trading-context.mjs';
import { createMockExchange } from '../server/exchange/mock.mjs';
import { BinancePrivate } from '../server/exchange/binance-private.mjs';

const TOKEN = 'test-admin-token';

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinrule-api-'));
  const mock = createMockExchange();
  const trading = (db) => createTradingContext({
    db,
    clientFactory: () => new BinancePrivate({ apiKey: 'test-key', apiSecret: 'test-secret', baseUrl: 'https://mock.local', fetchImpl: mock.fetchImpl }),
  });
  const { app, url } = await startApp({ port: 0, quiet: true, dbPath: path.join(dir, 'test.db'), trading, adminToken: TOKEN });
  const headers = { 'Content-Type': 'application/json', 'X-CoinRule-Token': TOKEN };
  return {
    app, url, mock,
    headers,
    async call(method, path_, body = null) {
      const res = await fetch(`${url}${path_}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async stop() {
      await app.close({ force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the whole API surface requires the admin token except health/ping', async () => {
  const b = await boot();
  try {
    const health = await fetch(`${b.url}/api/health`);
    assert.equal(health.status, 200, 'health is public for the launcher');
    const ping = await fetch(`${b.url}/api/ping`);
    assert.equal(ping.status, 200);

    for (const [method, route] of [['GET', '/api/status'], ['GET', '/api/mode'], ['GET', '/api/risk'], ['GET', '/api/orders?sessionId=x'], ['POST', '/api/mode']]) {
      const res = await fetch(`${b.url}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 401, `${method} ${route} must be unauthorized`);
    }

    const status = await b.call('GET', '/api/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.mode.mode, 'paper', 'the default mode after start');
    assert.equal(status.body.credentials.configured, false);
  } finally {
    await b.stop();
  }
});

test('credentials are applied in RAM and never echoed back', async () => {
  const b = await boot();
  try {
    const applied = await b.call('POST', '/api/credentials', { key: 'K'.repeat(32), secret: 'S'.repeat(48) });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.credentials.configured, true);
    assert.equal(applied.body.credentials.keyMasked, 'KKKK...KKKK');
    const serialized = JSON.stringify(applied.body);
    assert.ok(!serialized.includes('S'.repeat(48)), 'the secret must never be returned');
    assert.ok(!serialized.includes('K'.repeat(32)), 'the full key must never be returned');

    const cleared = await b.call('DELETE', '/api/credentials');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.credentials.configured, false);
  } finally {
    await b.stop();
  }
});

test('mode transitions are enforced through the API', async () => {
  const b = await boot();
  try {
    const noCreds = await b.call('POST', '/api/mode', { action: 'testnet' });
    assert.equal(noCreds.status, 400);
    assert.equal(noCreds.body.reason, 'missing_credentials');

    await b.call('POST', '/api/credentials', { key: 'k'.repeat(20), secret: 's'.repeat(20) });

    const liveTooSoon = await b.call('POST', '/api/mode', { action: 'live', confirm: 'LIVE', acknowledgeRisk: true });
    assert.equal(liveTooSoon.status, 400);
    assert.equal(liveTooSoon.body.reason, 'testnet_first');

    const testnet = await b.call('POST', '/api/mode', { action: 'testnet' });
    assert.equal(testnet.status, 200);
    assert.equal(testnet.body.mode, 'testnet');

    const badConfirm = await b.call('POST', '/api/mode', { action: 'live', confirm: 'yes' });
    assert.equal(badConfirm.status, 400);
    assert.equal(badConfirm.body.reason, 'confirmation_required');

    const live = await b.call('POST', '/api/mode', { action: 'live', confirm: 'LIVE', acknowledgeRisk: true });
    assert.equal(live.status, 200);
    assert.equal(live.body.mode, 'live');

    const disabled = await b.call('POST', '/api/mode', { action: 'disable' });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.mode, 'paper');
  } finally {
    await b.stop();
  }
});

test('the full order flow works through HTTP with every gate in place', async () => {
  const b = await boot();
  try {
    await b.call('POST', '/api/credentials', { key: 'k'.repeat(20), secret: 's'.repeat(20) });
    await b.call('POST', '/api/mode', { action: 'testnet' });

    const created = await b.call('POST', '/api/sessions', { environment: 'testnet', symbol: 'BTCUSDT' });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.id;
    assert.equal(created.body.session.reconciliation_state, 'pending');

    // Orders before reconciliation and with the kill switch engaged are refused.
    const early = await b.call('POST', '/api/orders', { sessionId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, referencePrice: 60_000, intentId: 'api:early' });
    assert.equal(early.status, 409);
    assert.equal(early.body.check, 'reconciliation');

    const reconciled = await b.call('POST', '/api/sessions/reconcile', { sessionId });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.report.state, 'ok');

    const killSwitch = await b.call('POST', '/api/orders', { sessionId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, referencePrice: 60_000, intentId: 'api:ks' });
    assert.equal(killSwitch.status, 409);
    assert.equal(killSwitch.body.check, 'kill_switch');

    const released = await b.call('POST', '/api/risk/killswitch', { engaged: false });
    assert.equal(released.status, 200);
    assert.equal(released.body.killSwitchEngaged, false);

    const placed = await b.call('POST', '/api/orders', { sessionId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, referencePrice: 60_000, intentId: 'api:1' });
    assert.equal(placed.status, 200);
    assert.equal(placed.body.skipped, false);
    assert.equal(placed.body.order.status, 'FILLED');
    assert.equal(b.mock.state.counters.placed, 1);

    const duplicate = await b.call('POST', '/api/orders', { sessionId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, referencePrice: 60_000, intentId: 'api:1' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.skipped, true);
    assert.equal(b.mock.state.counters.placed, 1, 'the same intent never reaches the exchange twice');

    const orders = await b.call('GET', `/api/orders?sessionId=${sessionId}`);
    assert.equal(orders.status, 200);
    assert.equal(orders.body.orders.length, 1);

    const limit = await b.call('POST', '/api/orders', { sessionId, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', quantity: 0.001, price: 70_000, intentId: 'api:2' });
    assert.equal(limit.status, 200);
    assert.equal(limit.body.order.status, 'NEW');

    const canceled = await b.call('POST', '/api/orders/cancel', { sessionId, symbol: 'BTCUSDT', clientOrderId: limit.body.clientOrderId });
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.order.status, 'CANCELED');

    // Phase 13: the polling user-data stream can be started/stopped over HTTP
    const streamStart = await b.call('POST', '/api/stream/start', { sessionId, intervalMs: 3_600_000, staleAfterMs: 3_600_000 });
    assert.equal(streamStart.status, 200);
    assert.equal(streamStart.body.stream.running, true);
    const streamGet = await b.call('GET', '/api/stream');
    assert.equal(streamGet.body.stream.running, true);
    assert.equal(streamGet.body.stream.sessionId, sessionId);
    const streamStop = await b.call('POST', '/api/stream/stop');
    assert.equal(streamStop.status, 200);
    assert.equal(streamStop.body.stream.running, false);

    // filter refusal: below minQty, still no extra exchange order
    const filtered = await b.call('POST', '/api/orders', { sessionId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.0000001, referencePrice: 60_000, intentId: 'api:3' });
    assert.equal(filtered.status, 409);
    assert.equal(filtered.body.check, 'filters');
    assert.equal(b.mock.state.counters.placed, 2);
  } finally {
    await b.stop();
  }
});

test('CORS blocks non-loopback origins even with a valid token', async () => {
  const b = await boot();
  try {
    const res = await fetch(`${b.url}/api/mode`, {
      method: 'POST',
      headers: { ...b.headers, Origin: 'http://evil.example' },
      body: JSON.stringify({ action: 'paper' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'cors');
  } finally {
    await b.stop();
  }
});