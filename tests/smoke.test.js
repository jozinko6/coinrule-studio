/**
 * smoke.test.js — runtime smoke tests.
 *
 *  1. the real static server serves index.html and every referenced asset/module
 *  2. every UI module imports cleanly under Node (proving no DOM access at
 *     module top level, which is what keeps the core testable)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, ROOT, resolvePath, MIME } from '../tools/serve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

test('resolvePath maps URLs safely inside the root', () => {
  assert.equal(resolvePath('/'), path.join(ROOT_DIR, 'index.html'));
  assert.equal(resolvePath('/js/app.js'), path.join(ROOT_DIR, 'js', 'app.js'));
  assert.equal(resolvePath('/../secret.txt'), null);
  assert.equal(resolvePath('/js/../../etc/passwd'), null);
  assert.equal(resolvePath('/%2e%2e/secret'), null);
});

test('the MIME table covers every shipped asset type', () => {
  for (const ext of ['.html', '.js', '.css', '.json', '.svg', '.mjs']) {
    assert.ok(MIME[ext], `missing MIME for ${ext}`);
  }
  assert.match(MIME['.js'], /javascript/);
});

test('the server serves index.html and every referenced asset', async () => {
  const { server, url } = await startServer({ port: 0, quiet: true });
  const seen = new Set();
  const queue = ['/'];
  const results = [];
  try {
    while (queue.length) {
      const asset = queue.shift();
      if (seen.has(asset)) continue;
      seen.add(asset);
      const res = await fetch(`${url}${asset}`);
      results.push({ asset, status: res.status, type: res.headers.get('content-type') ?? '' });
      assert.equal(res.status, 200, `${asset} returned ${res.status}`);
      if (asset.endsWith('.js')) {
        assert.match(res.headers.get('content-type'), /javascript/, `${asset} served with the wrong type`);
        const text = await res.text();
        for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
          queue.push(new URL(m[1], `http://x${asset.slice(0, asset.lastIndexOf('/'))}/`).pathname);
        }
      } else if (asset === '/') {
        const html = await res.text();
        assert.match(html, /<title>/, 'index.html has no title');
        assert.match(html, /CoinRule Studio/);
        for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
          if (/^(https?:|data:|#|mailto:)/.test(m[1])) continue;
          queue.push(m[1].startsWith('/') ? m[1] : `/${m[1]}`);
        }
      }
    }
    const jsCount = results.filter((r) => r.asset.endsWith('.js')).length;
    assert.ok(jsCount >= 15, `only ${jsCount} JS modules served`);
    assert.ok(results.length >= 20, `only ${results.length} assets served`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('directory traversal is rejected at runtime', async () => {
  const { server, url } = await startServer({ port: 0, quiet: true });
  try {
    const res = await fetch(`${url}/..%2f..%2fpackage.json`);
    assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unknown paths return 404', async () => {
  const { server, url } = await startServer({ port: 0, quiet: true });
  try {
    const res = await fetch(`${url}/nope/nothing.js`);
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('every UI module imports without touching the DOM at module scope', async () => {
  const modules = [
    '../js/ui/dom.js',
    '../js/ui/charts.js',
    '../js/ui/state.js',
    '../js/ui/views/dashboard.js',
    '../js/ui/views/strategies.js',
    '../js/ui/views/editor.js',
    '../js/ui/views/backtest.js',
    '../js/ui/views/paper.js',
    '../js/ui/views/trades.js',
    '../js/ui/views/indicators.js',
    '../js/ui/views/settings.js',
    '../js/ui/views/scanner.js',
    '../js/ui/views/alerts.js',
  ];
  for (const m of modules) {
    const mod = await import(m);
    assert.ok(Object.keys(mod).length > 0, `${m} exports nothing`);
  }
});

test('every view module exposes render() and optional afterMount()', async () => {
  const views = ['dashboard', 'strategies', 'editor', 'scanner', 'alerts', 'backtest', 'paper', 'trades', 'indicators', 'settings'];
  for (const v of views) {
    const mod = await import(`../js/ui/views/${v}.js`);
    assert.equal(typeof mod.render, 'function', `${v}.render is missing`);
    if (mod.afterMount) assert.equal(typeof mod.afterMount, 'function', `${v}.afterMount is not a function`);
  }
});

test('hidden-by-default elements cannot be un-hidden by their own CSS', () => {
  // Regression guard: `.modal-root { display: grid }` used to defeat the `hidden` attribute,
  // leaving a full-screen invisible overlay that swallowed every click.
  const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT_DIR, 'css', 'app.css'), 'utf8');
  const hiddenEls = [...html.matchAll(/<[^>]*\shidden(?:\s|>)[^>]*>/g)].map((m) => m[0]);
  assert.ok(hiddenEls.length >= 1, 'no hidden-by-default element found in index.html');
  for (const el of hiddenEls) {
    const cls = (el.match(/class="([^"]+)"/) || [])[1];
    if (!cls) continue;
    for (const name of cls.split(/\s+/)) {
      const ruleStart = css.indexOf('.' + name + ' {');
      if (ruleStart < 0) continue;
      const ruleBody = css.slice(ruleStart, css.indexOf('}', ruleStart));
      if (!ruleBody.includes('display')) continue;
      const guardStart = css.indexOf('.' + name + '[hidden]');
      assert.ok(guardStart >= 0, '.' + name + ' sets display but has no [hidden] guard (it would cover the UI)');
      const guardBody = css.slice(guardStart, css.indexOf('}', guardStart));
      assert.ok(guardBody.includes('display: none') || guardBody.includes('display:none'), '.' + name + '[hidden] must set display: none');
    }
  }
});

test('the app entry point and every core module exist and parse', async () => {
  const files = ['js/app.js', 'js/core/indicators.js', 'js/core/rules.js', 'js/core/strategies.js',
    'js/core/risk.js', 'js/core/portfolio.js', 'js/core/paper.js', 'js/core/metrics.js',
    'js/core/backtest.js', 'js/core/engine.js', 'js/core/session.js', 'js/core/money.js',
    'js/core/scanner.js', 'js/core/alerts.js',
    'js/data/binance.js', 'js/data/synthetic.js', 'js/data/seed.js', 'js/data/market.js',
    'js/store/store.js', 'tools/serve.mjs', 'tools/verify.mjs', 'tools/lint.mjs'];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT_DIR, f)), `missing file ${f}`);
  }
});
