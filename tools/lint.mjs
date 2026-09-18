/**
 * lint.mjs — dependency-free static checks for this project.
 *
 * Checks performed:
 *   1. every .js/.mjs file parses (`node --check`)
 *   2. no third-party/CDN references in shipped assets
 *   3. no credential handling (`apiKey`, `secretKey`, `signature`, ...)
 *   4. no dynamic code execution (`eval`, `new Function`)
 *   5. every relative import resolves to an existing file
 *   6. every asset referenced from index.html exists
 *   7. no leftover `console.log` debugging in js/ (warn only)
 *
 * Exit code 0 = clean. Any error -> exit code 1 with a readable report.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const FORBIDDEN_PATTERNS = [
  { id: 'cdn', re: /(cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare|ajax\.googleapis|fonts\.googleapis)/i, message: 'Externý CDN zdroj — projekt musí byť bez tretích strán.' },
  { id: 'credential', re: /\b(apiKey|api_key|secretKey|secret_key|privateKey|hmacSha256|X-MBX-APIKEY)\b/, message: 'Spracovanie prihlasovacích údajov — zakázané (žiadne API kľúče).' },
  { id: 'eval', re: /\beval\s*\(|new\s+Function\s*\(/, message: 'Dynamické vykonávanie kódu — zakázané.' },
  { id: 'secret', re: /(BEGIN (RSA|EC|OPENSSH) PRIVATE KEY|sk-[A-Za-z0-9]{20,})/, message: 'Vyzerá ako tajný kľúč.' },
];

/**
 * Credential handling policy (updated in Phase 7):
 *   - the browser frontend (js/**) must NEVER see an API key or secret;
 *   - only the local backend (server/**) may implement signed exchange calls,
 *     and even there credentials are kept in RAM and never persisted or logged;
 *   - the tests below exercise that backend path with fake credentials.
 */
const CREDENTIAL_ALLOWED = [
  /^server\//,
  /^tests\/(binance-private|exchange|idempotency|live-risk)\.test\.js$/,
];

/** True when a file is allowed to touch credential identifiers. */
export function mayHandleCredentials(relPath) {
  const rel = String(relPath).replace(/\\/g, '/');
  return CREDENTIAL_ALLOWED.some((re) => re.test(rel));
}

/** Files that are allowed to mention the forbidden words (this linter, docs). */
const EXEMPT = new Set([
  'tools/lint.mjs',            // defines the forbidden patterns
  'js/data/binance.js',        // implements the "no credentials" guard
  'tests/binance.test.js',     // asserts that credentials are rejected
  'js/ui/settings.js',         // documents the no-API-key policy in the UI
  'README.md',
  'AGENTS.md',
]);

export function listFiles(dir, exts = ['.js', '.mjs', '.html', '.css', '.json']) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.longrun') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.includes(path.extname(entry.name))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export function syntaxCheck(file) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) return { file, ok: false, message: (res.stderr || res.stdout || '').trim().split('\n').slice(0, 4).join(' ') };
  return { file, ok: true };
}

export function scanPatterns(files, root = ROOT) {
  const problems = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (EXEMPT.has(rel)) continue;
    if (!/\.(js|mjs|html|css)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.id === 'credential' && mayHandleCredentials(rel)) continue;
      if (p.re.test(text)) problems.push({ file: rel, rule: p.id, message: p.message });
    }
  }
  return problems;
}

export function checkImports(files, root = ROOT) {
  const problems = [];
  for (const file of files) {
    if (!/\.(js|mjs)$/.test(file)) continue;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1] ?? m[2];
      if (!spec || spec.startsWith('node:') || !spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) problems.push({ file: rel, rule: 'import', message: `Neznámy import "${spec}".` });
    }
  }
  return problems;
}

export function checkHtmlAssets(htmlFile, root = ROOT) {
  const problems = [];
  const text = fs.readFileSync(htmlFile, 'utf8');
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    const url = m[1];
    if (/^(https?:|data:|#|mailto:)/.test(url)) continue;
    const clean = url.split('?')[0];
    // Root-absolute URLs are served from the project root; relative ones from
    // the directory of the HTML file.
    const target = clean.startsWith('/')
      ? path.resolve(root, clean.replace(/^\/+/, ''))
      : path.resolve(path.dirname(htmlFile), clean);
    if (!fs.existsSync(target)) problems.push({ file: path.relative(root, htmlFile), rule: 'asset', message: `Chýbajúci súbor "${url}".` });
  }
  return problems;
}

export function checkConsoleLogs(files, root = ROOT) {
  const warnings = [];
  for (const file of files) {
    if (!/\.(js|mjs)$/.test(file)) continue;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (rel.startsWith('tools/') || rel.startsWith('tests/')) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/console\.log\(/.test(line)) warnings.push({ file: rel, line: i + 1, message: 'console.log v produkčnom kóde.' });
    });
  }
  return warnings;
}

export function runLint(root = ROOT) {
  const files = listFiles(root);
  const jsFiles = files.filter((f) => /\.(js|mjs)$/.test(f));
  const errors = [];
  const warnings = [];

  for (const f of jsFiles) {
    const r = syntaxCheck(f);
    if (!r.ok) errors.push({ file: path.relative(root, f), rule: 'syntax', message: r.message });
  }
  errors.push(...scanPatterns(files, root));
  errors.push(...checkImports(jsFiles, root));
  const indexHtml = path.join(root, 'index.html');
  if (fs.existsSync(indexHtml)) errors.push(...checkHtmlAssets(indexHtml, root));
  warnings.push(...checkConsoleLogs(files, root));

  return { errors, warnings, checked: files.length, js: jsFiles.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const report = runLint();
  process.stdout.write(`Lint: skontrolovaných ${report.checked} súborov (${report.js} JS)\n`);
  for (const w of report.warnings) process.stdout.write(`  WARN  ${w.file}:${w.line ?? '-'} ${w.message}\n`);
  for (const e of report.errors) process.stdout.write(`  ERROR ${e.file} [${e.rule}] ${e.message}\n`);
  if (report.errors.length) {
    process.stdout.write(`\nLint zlyhal: ${report.errors.length} chýb.\n`);
    process.exit(1);
  }
  process.stdout.write('Lint OK\n');
}
