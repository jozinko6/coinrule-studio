/**
 * serve.mjs — zero-dependency static file server.
 *
 * Exists so the app can be started with nothing but Node itself:
 *   node tools/serve.mjs [--port 8787] [--host 127.0.0.1]
 *
 * Also exported as `createStaticServer()` so tests can boot it in-process.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Resolve a URL path to a file inside ROOT, or null when it escapes the root. */
export function resolvePath(urlPath, root = ROOT) {
  const decoded = decodeURIComponent((urlPath.split('?')[0] || '/'));
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

export function createStaticServer({ root = ROOT, onRequest = null } = {}) {
  return http.createServer((req, res) => {
    const started = Date.now();
    const full = resolvePath(req.url ?? '/', root);
    if (!full) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Zakázané');
      onRequest?.(req, 403, started);
      return;
    }
    fs.stat(full, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Nenájdené');
        onRequest?.(req, 404, started);
        return;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(full).pipe(res);
      onRequest?.(req, 200, started);
    });
  });
}

export function startServer({ port = 8787, host = '127.0.0.1', root = ROOT, quiet = false } = {}) {
  const server = createStaticServer({
    root,
    onRequest: quiet ? null : (req, status, started) => {
      const ms = Date.now() - started;
      process.stdout.write(`${status} ${req.method} ${req.url} (${ms} ms)\n`);
    },
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      if (!quiet) {
        process.stdout.write(`\n  CoinRule Studio\n  http://${host}:${actual}\n  (Ctrl+C pre ukončenie)\n\n`);
      }
      resolve({ server, port: actual, url: `http://${host}:${actual}` });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const port = Number(getArg('port', process.env.PORT ?? 8787));
  const host = getArg('host', '127.0.0.1');
  startServer({ port, host }).catch((err) => {
    process.stderr.write(`Server sa nepodarilo spustiť: ${err.message}\n`);
    process.exit(1);
  });
}
