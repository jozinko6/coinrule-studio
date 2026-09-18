/**
 * testnet-smoke.test.js — the testnet round-trip harness with a scripted backend.
 * No network, no keys: the fake fetch records every call so the ORDER of safety
 * actions (reconcile before orders, kill switch ON at the end) is asserted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mask, parseArgs, runSmoke } from '../tools/testnet-smoke.mjs';

function fakeBackend(overrides = {}) {
  const calls = [];
  const routes = {
    'GET /api/health': () => ({ ok: true, mode: 'paper', db: { ok: true } }),
    'GET /api/status': () => ({ mode: { mode: 'paper' }, credentials: { configured: false } }),
    'POST /api/credentials': () => ({ ok: true, credentials: { configured: true, keyMasked: 'test...cret' } }),
    'POST /api/mode': (body) => ({ ok: true, mode: body.action === 'disable' ? 'paper' : body.action }),
    'POST /api/sessions': () => ({ ok: true, session: { id: 'ls_smoke' } }),
    'POST /api/sessions/reconcile': () => ({ ok: true, report: { state: 'ok', errors: [] } }),
    'POST /api/risk/killswitch': (body) => ({ ok: true, killSwitchEngaged: body.engaged }),
    'POST /api/orders': () => ({ ok: true, skipped: false, clientOrderId: 'cr-smoke-1', order: { status: 'NEW' } }),
    'GET /api/orders?sessionId=ls_smoke': () => ({ ok: true, orders: [{ client_order_id: 'cr-smoke-1', status: 'NEW' }] }),
    'POST /api/orders/cancel': () => ({ ok: true, order: { status: 'CANCELED' } }),
    'POST /api/stream/start': () => ({ ok: true, stream: { running: true } }),
    'POST /api/stream/stop': () => ({ ok: true, stream: { running: false } }),
    ...overrides,
  };
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    const key = `${method} ${u.pathname}${u.search}`;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ key, method, path: u.pathname + u.search, headers: init.headers ?? {}, body, url });
    const handler = routes[key] ?? routes[`${method} ${u.pathname}`];
    if (!handler) return { ok: false, status: 404, async json() { return { ok: false, error: 'not_found' }; } };
    const payload = handler(body);
    if (payload && payload.__status) return { ok: false, status: payload.__status, async json() { return payload.body; } };
    return { ok: true, status: 200, async json() { return payload; } };
  };
  return { impl, calls };
}

const run = (fake, extra = {}) => runSmoke({
  baseUrl: 'http://127.0.0.1:8787',
  token: 'admin-token',
  key: 'KEY-MATERIAL-XYZ',
  secret: 'SECRET-MATERIAL-XYZ',
  fetchImpl: fake.impl,
  ...extra,
});

test('parseArgs defaults and flags', () => {
  const d = parseArgs([]);
  assert.equal(d.base, 'http://127.0.0.1:8787');
  assert.equal(d.symbol, 'BTCUSDT');
  assert.equal(d.confirm, false);
  const f = parseArgs(['--confirm-testnet', '--market', '--symbol', 'ethusdt', '--qty', '0.5', '--base', 'http://x:1', '--price', '1234']);
  assert.equal(f.confirm, true);
  assert.equal(f.market, true);
  assert.equal(f.symbol, 'ETHUSDT');
  assert.equal(f.qty, 0.5);
  assert.equal(f.base, 'http://x:1');
  assert.equal(f.price, 1234);
});

test('mask never reveals the middle of a secret', () => {
  assert.equal(mask('ABCDEFGHIJKL'), 'ABCD...IJKL');
  assert.equal(mask('short'), '*****');
  assert.equal(mask(''), '');
});

test('a full testnet round trip runs in the safe order and re-arms the kill switch', async () => {
  const fake = fakeBackend();
  const report = await run(fake, { price: 1000 });
  assert.equal(report.ok, true);

  const sequence = fake.calls.map((c) => c.key);
  const idx = (key) => sequence.findIndex((k) => k.startsWith(key));
  assert.ok(idx('GET /api/sessions/reconcile') < idx('POST /api/orders'), 'reconciliation must precede any order');
  assert.ok(idx('POST /api/risk/killswitch') < idx('POST /api/orders'), 'kill switch must be released explicitly before the test order');
  assert.equal(sequence.filter((k) => k === 'POST /api/orders').length, 1, 'exactly one order');
  assert.ok(sequence.includes('POST /api/orders/cancel'), 'the resting limit order is cancelled');

  // the LAST kill switch call must be the safety re-arm
  const killCalls = fake.calls.filter((c) => c.key === 'POST /api/risk/killswitch');
  assert.equal(killCalls[0].body.engaged, false, 'test releases the switch');
  assert.equal(killCalls.at(-1).body.engaged, true, 'the harness always re-arms the switch');
  assert.ok(sequence.includes('POST /api/mode'), 'the mode is returned to paper');
  assert.equal(report.cleanup.filter((c) => c.startsWith('kill switch ON')).length, 1);
});

test('the raw key and secret are sent only to the credentials endpoint', async () => {
  const fake = fakeBackend();
  await run(fake, {});
  for (const call of fake.calls) {
    const blob = `${call.url} ${JSON.stringify(call.body)}`;
    if (call.key === 'POST /api/credentials') {
      assert.ok(blob.includes('KEY-MATERIAL-XYZ'), 'credentials endpoint receives the key');
    } else {
      assert.ok(!blob.includes('KEY-MATERIAL-XYZ'), `key leaked to ${call.key}`);
      assert.ok(!blob.includes('SECRET-MATERIAL-XYZ'), `secret leaked to ${call.key}`);
    }
  }
});

test('a failed reconciliation aborts BEFORE any order and still re-arms the switch', async () => {
  const fake = fakeBackend({
    'POST /api/sessions/reconcile': () => ({ ok: true, report: { state: 'mismatch', errors: ['openOrders: timeout'] } }),
  });
  await assert.rejects(run(fake, {}), /reconciliation|Reconciliation/i);
  assert.equal(fake.calls.filter((c) => c.key === 'POST /api/orders').length, 0, 'no order may be placed');
  const killCalls = fake.calls.filter((c) => c.key === 'POST /api/risk/killswitch');
  assert.equal(killCalls.at(-1).body.engaged, true, 'abort still re-arms the switch');
});

test('missing credentials stop the run before touching the exchange', async () => {
  const fake = fakeBackend();
  await assert.rejects(run(fake, { key: '', secret: '' }), /COINRULE_BINANCE_KEY/);
  assert.equal(fake.calls.filter((c) => c.key === 'POST /api/mode').length, 0);
  assert.equal(fake.calls.filter((c) => c.key === 'POST /api/orders').length, 0);
  assert.equal(fake.calls.at(-1).key, 'POST /api/risk/killswitch', 'the switch is re-armed even on config errors');
});

test('--dry only inspects the backend', async () => {
  const fake = fakeBackend();
  const report = await run(fake, { dry: true, key: '', secret: '' });
  assert.equal(report.ok, true);
  assert.ok(fake.calls.some((c) => c.key === 'GET /api/status'));
  assert.equal(fake.calls.filter((c) => c.key === 'POST /api/mode').length, 0);
  assert.equal(fake.calls.filter((c) => c.key === 'POST /api/orders').length, 0);
});