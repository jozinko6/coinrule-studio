/**
 * open-when-ready.mjs — wait for the backend health endpoint, then open the
 * browser. Used by SPUSTIT.bat so the UI never opens before the API is ready.
 *
 *   node tools/open-when-ready.mjs [--port 8787] [--timeout 20000] [--no-open]
 */

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const DEFAULT_PORT = 8787;

export function healthUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}/api/health`;
}

export function appUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}/`;
}

export async function waitForHealth({
  url = healthUrl(DEFAULT_PORT), timeoutMs = 20_000, intervalMs = 400,
  fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        return { ok: true, body };
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  return { ok: false, error: lastError ?? new Error('timeout') };
}

export function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const args = process.argv.slice(2);
  const readFlag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const port = Number(readFlag('--port', DEFAULT_PORT));
  const timeoutMs = Number(readFlag('--timeout', 20_000));
  const noOpen = args.includes('--no-open') || process.env.COINRULE_NO_BROWSER === '1';
  const result = await waitForHealth({ url: healthUrl(port), timeoutMs });
  if (!result.ok) {
    process.stderr.write(`\n  Backend sa nespustil na port ${port}: ${result.error?.message ?? result.error}\n  Skús iný port:  SPUSTIT.bat 8888\n\n`);
    process.exit(1);
  }
  process.stdout.write(`  Backend je pripravený (db ${result.body?.db?.ok ? 'ok' : 'chyba'}, mód ${result.body?.mode ?? '?'})\n`);
  if (!noOpen) openBrowser(appUrl(port));
  process.exit(0);
}