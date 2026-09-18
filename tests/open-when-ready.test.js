/**
 * open-when-ready.test.js — the health-gated browser opener used by SPUSTIT.bat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { appUrl, healthUrl, waitForHealth } from '../tools/open-when-ready.mjs';

test('URLs always target loopback', () => {
  assert.equal(healthUrl(8888), 'http://127.0.0.1:8888/api/health');
  assert.equal(appUrl(8888), 'http://127.0.0.1:8888/');
  assert.equal(healthUrl(), healthUrl(8787));
});

test('waitForHealth retries until the backend answers ok', async () => {
  const seen = [];
  let calls = 0;
  const result = await waitForHealth({
    url: healthUrl(9000),
    intervalMs: 1,
    sleep: async () => {},
    fetchImpl: async (url) => {
      calls += 1;
      seen.push(url);
      if (calls === 1) throw new Error('ECONNREFUSED');
      if (calls === 2) return { ok: false, status: 503, async json() { return { ok: false }; } };
      return { ok: true, status: 200, async json() { return { ok: true, mode: 'paper', db: { ok: true } }; } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.mode, 'paper');
  assert.equal(calls, 3);
  assert.ok(seen.every((u) => u.startsWith('http://127.0.0.1:')));
});

test('waitForHealth gives up after the timeout with the last error', async () => {
  const result = await waitForHealth({
    url: healthUrl(9001),
    timeoutMs: 60,
    intervalMs: 1,
    sleep: async () => {},
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /ECONNREFUSED/);
});