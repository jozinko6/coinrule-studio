/**
 * backend-client.test.js — the local backend client used by the UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendError, DEFAULT_BACKEND_URL, createBackendClient, normalizeBaseUrl } from '../js/data/backend.js';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const path = new URL(url).pathname + new URL(url).search;
    const handler = routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path];
    if (!handler) return { ok: false, status: 404, async json() { return { ok: false, error: 'not_found' }; } };
    return handler;
  };
  return { impl, calls };
}

const ok = (body) => ({ ok: true, status: 200, async json() { return body; } });
const fail = (status, body) => ({ ok: false, status, async json() { return body; } });

test('normalizeBaseUrl accepts friendly inputs and rejects nonsense', () => {
  assert.equal(normalizeBaseUrl(''), DEFAULT_BACKEND_URL);
  assert.equal(normalizeBaseUrl('127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeBaseUrl('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(normalizeBaseUrl('https://box.local:9000/api/'), 'https://box.local:9000/api');
  assert.throws(() => normalizeBaseUrl('ftp://x'), /http/);
});

test('the token is sent only on protected routes and never on health', async () => {
  const { impl, calls } = fakeFetch({
    'GET /api/health': ok({ ok: true, mode: 'paper' }),
    'GET /api/status': ok({ ok: true, mode: { mode: 'paper' } }),
  });
  const client = createBackendClient({ baseUrl: 'http://127.0.0.1:9999', token: 'secret-token', fetchImpl: impl });

  await client.health();
  await client.status();
  assert.equal(calls[0].headers['X-CoinRule-Token'], undefined, 'health is public');
  assert.equal(calls[1].headers['X-CoinRule-Token'], 'secret-token');
  assert.equal(client.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(client.hasToken, true);
});

test('backend errors carry status, code and the failing check', async () => {
  const { impl } = fakeFetch({
    'POST /api/orders': fail(409, { ok: false, error: 'risk', check: 'kill_switch', message: 'Kill switch je aktívny.' }),
    'GET /api/status': fail(401, { ok: false, error: 'unauthorized', message: 'Chýba token.' }),
  });
  const client = createBackendClient({ baseUrl: 'http://x', token: 't', fetchImpl: impl });

  await assert.rejects(client.placeOrder({ symbol: 'BTCUSDT' }), (err) => {
    assert.ok(err instanceof BackendError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'risk');
    assert.equal(err.check, 'kill_switch');
    return true;
  });
  await assert.rejects(client.status(), (err) => err.status === 401 && err.code === 'unauthorized');
});

test('a dead backend is reported as offline, not as a crash', async () => {
  const client = createBackendClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(client.status(), (err) => err.status === 0 && err.code === 'offline' && /nedostupný/.test(err.message));
});

test('a hanging backend times out with a typed error', async () => {
  const client = createBackendClient({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  });
  await assert.rejects(client.status(), (err) => err.status === 0 && err.code === 'timeout');
});

test('state-changing methods post the right payloads', async () => {
  const { impl, calls } = fakeFetch({
    'POST /api/mode': ok({ ok: true, mode: 'testnet' }),
    'POST /api/risk/killswitch': ok({ ok: true, killSwitchEngaged: false }),
    'POST /api/credentials': ok({ ok: true, credentials: { configured: true } }),
    'DELETE /api/credentials': ok({ ok: true, credentials: { configured: false } }),
    'POST /api/sessions': ok({ ok: true, session: { id: 'ls_1' } }),
    'POST /api/sessions/reconcile': ok({ ok: true, report: { state: 'ok' } }),
    'POST /api/stream/start': ok({ ok: true, stream: { running: true } }),
    'POST /api/stream/stop': ok({ ok: true, stream: { running: false } }),
  });
  const client = createBackendClient({ baseUrl: 'http://x', token: 't', fetchImpl: impl });

  await client.setMode('live', { confirm: 'LIVE', acknowledgeRisk: true });
  await client.setKillSwitch(false);
  await client.saveCredentials('K', 'S');
  await client.clearCredentials();
  await client.createSession('testnet', 'BTCUSDT');
  await client.reconcile('ls_1');
  await client.streamStart('ls_1', { intervalMs: 5_000 });
  await client.streamStop();

  assert.deepEqual(calls[0].body, { action: 'live', confirm: 'LIVE', acknowledgeRisk: true });
  assert.deepEqual(calls[1].body, { engaged: false });
  assert.deepEqual(calls[2].body, { key: 'K', secret: 'S' });
  assert.equal(calls[3].method, 'DELETE');
  assert.deepEqual(calls[4].body, { environment: 'testnet', symbol: 'BTCUSDT' });
  assert.deepEqual(calls[6].body, { sessionId: 'ls_1', intervalMs: 5_000 });
});

test('configure() swaps the target and drops the token cleanly', async () => {
  const { impl, calls } = fakeFetch({});
  const client = createBackendClient({ baseUrl: 'http://a', token: 't1', fetchImpl: impl });
  client.configure({ baseUrl: 'http://b:1111/', token: '' });
  assert.equal(client.baseUrl, 'http://b:1111');
  assert.equal(client.hasToken, false);
  const failing = createBackendClient({ baseUrl: client.baseUrl, token: '', fetchImpl: async (url) => { calls.push({ url }); return fail(500, { ok: false }); } });
  await assert.rejects(failing.status(), (err) => err.status === 500);
});
test('defaultBackendUrl prefers the serving origin and falls back to 8787', async () => {
  const { defaultBackendUrl } = await import('../js/data/backend.js');
  assert.equal(defaultBackendUrl({ origin: 'http://127.0.0.1:8899' }), 'http://127.0.0.1:8899');
  assert.equal(defaultBackendUrl({ origin: 'https://box.local' }), 'https://box.local');
  assert.equal(defaultBackendUrl({ origin: 'file://' }), DEFAULT_BACKEND_URL);
  assert.equal(defaultBackendUrl(null), DEFAULT_BACKEND_URL);
});