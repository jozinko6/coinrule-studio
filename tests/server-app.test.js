/**
 * server-app.test.js — the local backend: health, static serving, CORS,
 * loopback-only binding, database failure reporting and clean shutdown.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_HOST, ALLOW_LAN_ENV, createApp, startApp } from '../server/app.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coinrule-app-'));
}

async function boot(extra = {}) {
  const dir = tempDir();
  const { app, url } = await startApp({ port: 0, quiet: true, dbPath: path.join(dir, 'test.db'), ...extra });
  return {
    app, url, dir,
    async stop() {
      await app.close({ force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('GET /api/health reports app, mode and database status', async () => {
  const b = await boot();
  try {
    const res = await fetch(`${b.url}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.app, 'coinrule-studio');
    assert.equal(body.mode, 'paper', 'the starter mode must be PAPER');
    assert.equal(body.liveEnabled, false, 'live trading can never be on after start');
    assert.equal(body.db.ok, true);
    assert.equal(body.db.schemaVersion, 1);
    assert.ok(body.db.migrations >= 1);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await b.stop();
  }
});

test('the backend serves the frontend itself with security headers', async () => {
  const b = await boot();
  try {
    const res = await fetch(`${b.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const html = await res.text();
    assert.match(html, /CoinRule/i);
  } finally {
    await b.stop();
  }
});

test('traversal and private files are refused', async () => {
  const b = await boot();
  try {
    const attacks = [
      '/%2e%2e/package.json',            // normalized to /package.json -> private file
      '/..%2f..%2fpackage.json',
      '/%2e%2e%5cpackage.json',
      '/package.json',                    // repo metadata
      '/server/app.mjs',                  // backend source
      '/server/exchange/signing.mjs',
      '/data/coinrule-studio.db',         // user database
      '/.git/config',                     // repository internals
    ];
    for (const attack of attacks) {
      const res = await fetch(`${b.url}${attack}`);
      assert.notEqual(res.status, 200, `${attack} must not be served`);
    }
    const asset = await fetch(`${b.url}/js/core/paper.js`);
    assert.equal(asset.status, 200, 'frontend assets must stay reachable');
  } finally {
    await b.stop();
  }
});

test('unknown API routes return a JSON 404', async () => {
  const b = await boot();
  try {
    const res = await fetch(`${b.url}/api/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not_found');
  } finally {
    await b.stop();
  }
});

test('CORS allows loopback origins and rejects everything else', async () => {
  const b = await boot();
  try {
    const local = await fetch(`${b.url}/api/ping`, { headers: { Origin: 'http://127.0.0.1:5555' } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5555');

    const evil = await fetch(`${b.url}/api/ping`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    assert.equal((await evil.json()).error, 'cors');

    const preflight = await fetch(`${b.url}/api/health`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8787' } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);
  } finally {
    await b.stop();
  }
});

test('non-loopback binding is refused unless explicitly opted in', async () => {
  await assert.rejects(startApp({ port: 0, quiet: true, host: '0.0.0.0' }), /loopback/);
  process.env[ALLOW_LAN_ENV] = '1';
  try {
    const b = await boot({ host: '0.0.0.0' });
    // still reachable on loopback for the test
    const res = await fetch(`http://127.0.0.1:${b.app.server.address().port}/api/ping`);
    assert.equal(res.status, 200);
    await b.stop();
  } finally {
    delete process.env[ALLOW_LAN_ENV];
  }
});

test('a broken database degrades health but keeps the app serving', async () => {
  const dir = tempDir();
  const bad = path.join(dir, 'not-a-db');
  fs.mkdirSync(bad);
  const app = createApp({ dbPath: bad, quiet: true });
  await new Promise((resolve) => app.server.listen(0, DEFAULT_HOST, resolve));
  const url = `http://${DEFAULT_HOST}:${app.server.address().port}`;
  try {
    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 503);
    const body = await health.json();
    assert.equal(body.ok, false);
    assert.equal(body.db.ok, false);
    assert.ok(body.db.error);

    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200, 'the UI must still load to show the problem');
  } finally {
    await app.close({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shutdown is clean and idempotent', async () => {
  const b = await boot();
  assert.equal(b.app.server.listening, true);
  await b.app.close({ force: true });
  assert.equal(b.app.server.listening, false);
  await b.app.close({ force: true }); // second call must not throw
  fs.rmSync(b.dir, { recursive: true, force: true });
});