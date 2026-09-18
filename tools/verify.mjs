/**
 * verify.mjs — the single deterministic verification entry point.
 *
 *   node tools/verify.mjs
 *
 * Gates:
 *   1. lint          (syntax, forbidden patterns, import + asset resolution)
 *   2. unit tests    (node --test tests/)
 *   3. runtime smoke (boot the real static server, fetch every asset, check 200)
 *   4. repo hygiene  (no source file may be git-ignored - it would be missing from clones)
 *
 * Writes .longrun/verification_report.json and exits non-zero on any failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLint, ROOT } from './lint.mjs';
import { startServer } from './serve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(ROOT, '.longrun', 'verification_report.json');

const results = [];
const started = Date.now();

function record(gate, ok, detail) {
  results.push({ gate, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`[${tag}] ${gate}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

/* ---------------------------------------------------------------- gate 1 */

function gateLint() {
  const r = runLint(ROOT);
  const detail = r.errors.length
    ? `${r.errors.length} chýb: ${r.errors.slice(0, 5).map((e) => `${e.file}(${e.rule})`).join(', ')}`
    : `${r.checked} súborov, ${r.warnings.length} varovaní`;
  if (r.warnings.length) {
    for (const w of r.warnings) process.stdout.write(`       WARN ${w.file}:${w.line} ${w.message}\n`);
  }
  for (const e of r.errors) process.stdout.write(`       ${e.file} [${e.rule}] ${e.message}\n`);
  return record('lint', r.errors.length === 0, detail);
}

/* ---------------------------------------------------------------- gate 2 */

function gateTests() {
  const res = spawnSync(process.execPath, ['--test'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  // Works with both the TAP reporter ("# pass 12") and the default one ("ℹ pass 12").
  const pick = (name) => {
    const m = out.match(new RegExp(`(?:^#|^ℹ)\\s*${name}\\s+(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const passes = pick('pass');
  const failures = pick('fail');
  const summary = passes === null ? `exit ${res.status}` : `${passes} prešlo, ${failures ?? '?'} zlyhalo`;
  if (res.status !== 0) {
    const tail = out.split('\n').filter((l) => /not ok|Error|✖|fail/.test(l)).slice(0, 25).join('\n       ');
    process.stdout.write(`       ${tail}\n`);
  }
  return record('unit-tests', res.status === 0, summary || `exit ${res.status}`);
}

/* ---------------------------------------------------------------- gate 3 */

async function gateSmoke() {
  const { server, port, url } = await startServer({ port: 0, quiet: true });
  const checked = [];
  try {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const assets = ['/', '/css/app.css', '/js/app.js'];
    const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(indexHtml))) {
      const a = m[1];
      if (/^(https?:|data:|#|mailto:)/.test(a)) continue;
      assets.push(a.startsWith('/') ? a : `/${a}`);
    }
    // Follow ES module imports one level deep so every shipped module is served.
    const queue = [...assets];
    const seen = new Set();
    while (queue.length) {
      const asset = queue.shift();
      if (seen.has(asset)) continue;
      seen.add(asset);
      const res = await fetch(`${url}${asset}`);
      checked.push({ asset, status: res.status, type: res.headers.get('content-type') });
      if (res.status !== 200) throw new Error(`${asset} -> HTTP ${res.status}`);
      if (!asset.endsWith('.js')) continue;
      const text = await res.text();
      const impRe = /from\s+['"](\.[^'"]+)['"]/g;
      let im;
      while ((im = impRe.exec(text))) {
        const base = asset.slice(0, asset.lastIndexOf('/'));
        const next = new URL(im[1], `http://x${base}/`).pathname;
        queue.push(next);
      }
    }
    const jsCount = checked.filter((c) => c.asset.endsWith('.js')).length;
    return record('runtime-smoke', true, `${checked.length} assetov (${jsCount} JS) cez ${url} (port ${port})`);
  } catch (err) {
    return record('runtime-smoke', false, err.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ---------------------------------------------------------------- gate 4 */

/**
 * A source file that is silently git-ignored exists locally but not in a fresh
 * clone (this actually shipped once: the "data/" ignore rule swallowed
 * js/data/backend.js and the clone failed 0/3). Fail loudly instead.
 */
function gateRepoHygiene() {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
  if (probe.status !== 0 || !/true/.test(probe.stdout ?? '')) {
    return record('repo-hygiene', true, 'nie je git work tree - preskočené');
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/[.](js|mjs|json|html|css)$/.test(full)) files.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  for (const dir of ['js', 'server', 'tools', 'tests']) {
    const base = path.join(ROOT, dir);
    if (fs.existsSync(base)) walk(base);
  }
  const check = spawnSync('git', ['check-ignore', '--stdin'], { cwd: ROOT, input: files.join('\n'), encoding: 'utf8' });
  const ignored = (check.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const detail = ignored.length
    ? 'ignorované zdrojové súbory (chýbajú v klone!): ' + ignored.slice(0, 5).join(', ')
    : files.length + ' zdrojových súborov, 0 ignorovaných';
  return record('repo-hygiene', ignored.length === 0, detail);
}
/* ------------------------------------------------------------------- main */

process.stdout.write('CoinRule Studio — verifikácia\n\n');
const okLint = gateLint();
const okTests = gateTests();
const okSmoke = await gateSmoke();
const okHygiene = gateRepoHygiene();

const passed = [okLint, okTests, okSmoke, okHygiene].filter(Boolean).length;
const allOk = passed === 4;
const report = {
  schema: 1,
  generatedAt: new Date(started).toISOString(),
  durationMs: Date.now() - started,
  node: process.version,
  platform: process.platform,
  gates: results,
  passed,
  total: results.length,
  verdict: allOk ? 'PASS' : 'FAIL',
};

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

process.stdout.write(`\nVýsledok: ${report.verdict} (${passed}/${results.length}) za ${report.durationMs} ms\n`);
process.stdout.write(`Report: ${path.relative(ROOT, REPORT_PATH)}\n`);
process.exit(allOk ? 0 : 1);
