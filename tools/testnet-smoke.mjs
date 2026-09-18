/**
 * testnet-smoke.mjs — one-command TESTNET round trip against the local backend.
 *
 * Secrets are read from the environment and are NEVER printed or persisted:
 *   COINRULE_ADMIN_TOKEN        the token printed by the backend (required)
 *   COINRULE_BINANCE_KEY        testnet API key   (required unless --dry)
 *   COINRULE_BINANCE_SECRET     testnet API secret(required unless --dry)
 *
 * What it does (all through the local backend, all in TESTNET mode only):
 *   health -> credentials (RAM) -> mode TESTNET -> session -> reconcile ->
 *   kill switch off -> LIMIT buy far below market -> orders -> cancel ->
 *   stream start/stop -> kill switch ON -> back to PAPER.
 * It NEVER enables LIVE and ALWAYS re-engages the kill switch at the end.
 *
 * Usage:
 *   node tools/testnet-smoke.mjs --confirm-testnet [--base http://127.0.0.1:8787]
 *        [--symbol BTCUSDT] [--price 30000] [--qty 0.001] [--market] [--dry] [--json]
 */

export function parseArgs(argv = []) {
  const args = { base: 'http://127.0.0.1:8787', symbol: 'BTCUSDT', qty: 0.001, price: null, market: false, dry: false, json: false, confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm-testnet') args.confirm = true;
    else if (a === '--market') args.market = true;
    else if (a === '--dry') args.dry = true;
    else if (a === '--json') args.json = true;
    else if (a === '--base') args.base = argv[++i] ?? args.base;
    else if (a === '--symbol') args.symbol = (argv[++i] ?? args.symbol).toUpperCase();
    else if (a === '--qty') args.qty = Number(argv[++i] ?? args.qty);
    else if (a === '--price') args.price = Number(argv[++i] ?? 0) || null;
  }
  return args;
}

export function mask(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

/** Small JSON client with the admin token attached. */
export function makeCaller({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  return async function call(method, path, body = null) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-CoinRule-Token': token } : {}),
      },
      body: body === null ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${payload?.error ?? ''} ${payload?.message ?? ''}`.trim());
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  };
}

/**
 * Runs the smoke against the backend. Injectable fetch keeps it testable with
 * zero network access; the real CLI passes globalThis.fetch.
 */
export async function runSmoke({ baseUrl, token, key = '', secret = '', symbol = 'BTCUSDT', qty = 0.001, price = null, market = false, dry = false, fetchImpl = globalThis.fetch, log = () => {} }) {
  const call = makeCaller({ baseUrl, token, fetchImpl });
  const report = { steps: [], ok: false, order: null, cleanup: [] };
  const step = (name, detail = {}) => { report.steps.push({ name, ok: true, ...detail }); log(`  [ok] ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`); };

  const fail = (name, err) => { report.steps.push({ name, ok: false, error: err?.message ?? String(err) }); throw err; };

  let sessionId = null;
  const finalize = async (outcome) => {
    // Safety net: whatever happened, never leave trading armed.
    try { await call('POST', '/api/risk/killswitch', { engaged: true }); report.cleanup.push('kill switch ON'); }
    catch (err) { report.cleanup.push(`kill switch failed: ${err.message}`); }
    try { if (sessionId) { await call('POST', '/api/mode', { action: 'disable' }); report.cleanup.push('mode -> paper'); } }
    catch (err) { report.cleanup.push(`mode disable failed: ${err.message}`); }
    report.ok = outcome === 'ok';
    return report;
  };

  try {
    const health = await call('GET', '/api/health');
    step('health', { mode: health.mode, db: health.db?.ok ?? false });
    if (!health.db?.ok) throw new Error('Databáza backendu nie je pripravená.');

    if (dry) {
      const status = await call('GET', '/api/status');
      step('dry: status', { mode: status.mode.mode, credentials: status.credentials.configured });
      return finalize('ok');
    }

    if (!key || !secret) throw new Error('Chýbajú COINRULE_BINANCE_KEY / COINRULE_BINANCE_SECRET.');
    const creds = await call('POST', '/api/credentials', { key, secret });
    step('credentials applied (RAM only)', { configured: creds.credentials.configured, key: creds.credentials.keyMasked });

    const mode = await call('POST', '/api/mode', { action: 'testnet' });
    step('mode TESTNET', { mode: mode.mode });

    const created = await call('POST', '/api/sessions', { environment: 'testnet', symbol });
    sessionId = created.session.id;
    step('session created', { sessionId });

    const reconciled = await call('POST', '/api/sessions/reconcile', { sessionId });
    step('reconciliation', { state: reconciled.report.state });
    if (reconciled.report.state !== 'ok') throw new Error(`Reconciliation nie je ok: ${reconciled.report.state} — ${JSON.stringify(reconciled.report.errors ?? [])}`);
    if (reconciled.report.errors?.length) throw new Error(`Chyby reconciliation: ${reconciled.report.errors.join('; ')}`);

    await call('POST', '/api/risk/killswitch', { engaged: false });
    step('kill switch off (test only)');

    const intent = `smoke:${Date.now().toString(36)}`;
    const order = await call('POST', '/api/orders', market
      ? { sessionId, symbol, side: 'BUY', type: 'MARKET', quantity: qty, intentId: intent }
      : { sessionId, symbol, side: 'BUY', type: 'LIMIT', quantity: qty, price: price ?? 1000, intentId: intent });
    report.order = order;
    step(market ? 'market order placed' : 'limit order placed (far below market)', {
      clientOrderId: order.clientOrderId, status: order.order?.status, skipped: order.skipped,
    });

    const listed = await call('GET', `/api/orders?sessionId=${encodeURIComponent(sessionId)}`);
    step('orders listed', { count: listed.orders.length });
    const stored = listed.orders.find((o) => o.client_order_id === order.clientOrderId);
    if (!stored) throw new Error('Vytvorený príkaz sa nenašiel v databáze.');

    if (!market) {
      const canceled = await call('POST', '/api/orders/cancel', { sessionId, symbol, clientOrderId: order.clientOrderId });
      step('order canceled', { status: canceled.order?.status });
      if (canceled.order?.status !== 'CANCELED') throw new Error(`Zrušenie nevrátilo CANCELED (${canceled.order?.status}).`);
    }

    const stream = await call('POST', '/api/stream/start', { sessionId, intervalMs: 600000, staleAfterMs: 600000 });
    step('stream started', { running: stream.stream.running });
    await call('POST', '/api/stream/stop');
    step('stream stopped');

    return finalize('ok');
  } catch (err) {
    report.steps.push({ name: 'ABORT', ok: false, error: err?.message ?? String(err) });
    await finalize('failed');
    const wrapped = new Error(err?.message ?? String(err));
    wrapped.report = report;
    throw wrapped;
  }
}

const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/testnet-smoke.mjs');
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.COINRULE_ADMIN_TOKEN ?? '';
  const key = process.env.COINRULE_BINANCE_KEY ?? '';
  const secret = process.env.COINRULE_BINANCE_SECRET ?? '';
  const log = args.json ? () => {} : (line) => process.stdout.write(`${line}\n`);

  process.stdout.write('\nCoinRule Studio — TESTNET smoke\n');
  process.stdout.write(`  backend: ${args.base}\n  token: ${mask(token) || 'CHÝBA'}\n  key: ${mask(key) || (args.dry ? '(dry)' : 'CHÝBA')}\n\n`);

  if (!token) {
    process.stderr.write('Chýba COINRULE_ADMIN_TOKEN (token vypísaný backendom pri štarte).\n');
    process.exitCode = 2;
  } else if (!args.confirm && !args.dry) {
    process.stderr.write('Toto pošle reálne príkazy na Binance TESTNET. Spusti s --confirm-testnet (alebo --dry).\n');
    process.exitCode = 2;
  } else {
    // NOTE: no process.exit() here — exiting abruptly right after fetch trips a
    // libuv assertion on Windows (UV_HANDLE_CLOSING). exitCode lets the loop drain.
    runSmoke({ ...args, baseUrl: args.base, token, key, secret })
      .then((report) => {
        process.stdout.write(`\n  cleanup: ${report.cleanup.join(', ') || '—'}\n`);
        if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`\nVýsledok: ${report.ok ? 'PASS' : 'FAIL'}\n\n`);
        process.exitCode = report.ok ? 0 : 1;
      })
      .catch((err) => {
        if (args.json && err.report) process.stdout.write(`${JSON.stringify(err.report, null, 2)}\n`);
        process.stderr.write(`\nVýsledok: FAIL — ${err.message}\n\n`);
        process.exitCode = 1;
      });
  }
}