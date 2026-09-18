/**
 * reconciliation.mjs — startup/periodic reconciliation (Phase 12).
 *
 * The exchange is the source of truth. Reconciliation must run before trading
 * is allowed again:
 *   - resolve UNKNOWN/PENDING local orders (timeout-after-accept) from exchange
 *     openOrders/allOrders; an order the exchange never saw becomes REJECTED;
 *   - an exchange order with no local row is an EXTERNAL order (manual or from
 *     another client) -> imported AND reported as a mismatch;
 *   - exchange fills are imported idempotently;
 *   - the session is marked ok only when nothing is left unexplained.
 */

import {
  getLiveOrderByClientId, insertLiveFill, insertLiveOrder, listLiveFills, listLiveOrders,
  setSessionReconciliation, updateLiveOrder,
} from '../db/live-repository.mjs';

export const RECONCILIATION_STATES = Object.freeze(['pending', 'ok', 'mismatch', 'failed']);

const OPEN_EXCHANGE_STATUSES = ['NEW', 'PARTIALLY_FILLED'];
const NEEDS_RESOLUTION = ['UNKNOWN', 'PENDING'];

export class Reconciler {
  constructor({ db, client, clock = () => Date.now() }) {
    if (!db) throw new Error('Reconciler: chýba db.');
    if (!client) throw new Error('Reconciler: chýba klient.');
    this.db = db;
    this.client = client;
    this.clock = clock;
  }

  async reconcileSession(session) {
    const report = { sessionId: session.id, state: 'ok', resolved: [], imported: [], exchanges: [], mismatches: [], fillsImported: 0, errors: [] };

    let openOrders = [];
    let allOrders = [];
    let trades = [];
    try {
      openOrders = await this.client.openOrders(session.symbol ?? undefined);
    } catch (err) { report.errors.push(`openOrders: ${err.message}`); }

    if (session.symbol) {
      try { allOrders = await this.client.allOrders(session.symbol, { limit: 200 }); } catch (err) { report.errors.push(`allOrders: ${err.message}`); }
      try { trades = await this.client.myTrades(session.symbol, { limit: 200 }); } catch (err) { report.errors.push(`myTrades: ${err.message}`); }
    }

    const exchangeOrders = new Map();
    for (const order of [...allOrders, ...openOrders]) {
      if (order?.clientOrderId) exchangeOrders.set(order.clientOrderId, order);
    }

    // "missing at the exchange" can only be judged when the full order list was fetched
    const canVerifyAll = Boolean(session.symbol) && !report.errors.some((e) => e.startsWith('allOrders'));

    // 1. resolve local orders against exchange truth
    for (const local of listLiveOrders(this.db, session.id)) {
      const remote = exchangeOrders.get(local.client_order_id);
      if (!remote) {
        if (NEEDS_RESOLUTION.includes(local.status)) {
          updateLiveOrder(this.db, { clientOrderId: local.client_order_id, status: 'REJECTED', raw: { reconciliation: 'never_accepted_at_exchange', at: this.clock() } });
          report.resolved.push({ clientOrderId: local.client_order_id, from: local.status, to: 'REJECTED', reason: 'never_accepted_at_exchange' });
        } else if (canVerifyAll && OPEN_EXCHANGE_STATUSES.includes(local.status)) {
          report.mismatches.push({ kind: 'missing_at_exchange', clientOrderId: local.client_order_id, local: local.status });
        }
        continue;
      }
      if (local.status !== remote.status) {
        updateLiveOrder(this.db, { clientOrderId: local.client_order_id, status: remote.status, exchangeOrderId: remote.orderId ? String(remote.orderId) : null, raw: { reconciliation: 'status_synced', remote: { status: remote.status } } });
        report.resolved.push({ clientOrderId: local.client_order_id, from: local.status, to: remote.status });
      }
    }

    // 2. external orders (on the exchange, unknown locally)
    for (const [clientOrderId, remote] of exchangeOrders) {
      if (getLiveOrderByClientId(this.db, clientOrderId)) continue;
      insertLiveOrder(this.db, {
        sessionId: session.id, clientOrderId, exchangeOrderId: remote.orderId ? String(remote.orderId) : null,
        intentId: 'external', symbol: remote.symbol, side: remote.side, type: remote.type,
        qty: Number(remote.origQty ?? 0), price: remote.price ? Number(remote.price) : null,
        status: remote.status, raw: { reconciliation: 'external_order', remote },
      });
      report.imported.push(clientOrderId);
      report.mismatches.push({ kind: 'external_order', clientOrderId, status: remote.status });
    }

    // 3. import fills idempotently (Binance trades carry orderId, not clientOrderId)
    const localByExchangeId = new Map(
      listLiveOrders(this.db, session.id)
        .filter((o) => o.exchange_order_id)
        .map((o) => [String(o.exchange_order_id), o]),
    );
    const seen = new Set(listLiveFills(this.db, session.id).map((f) => f.exchange_trade_id).filter(Boolean));
    for (const trade of trades) {
      const tradeId = String(trade.id ?? '');
      if (!tradeId || seen.has(tradeId)) continue;
      const local = trade.orderId ? localByExchangeId.get(String(trade.orderId)) : null;
      insertLiveFill(this.db, {
        sessionId: session.id, orderId: local?.id ?? null, exchangeTradeId: tradeId,
        symbol: trade.symbol, qty: Number(trade.qty), price: Number(trade.price),
        fee: Number(trade.commission ?? 0), feeAsset: trade.commissionAsset ?? null,
        filledAt: Number(trade.time ?? this.clock()),
      });
      seen.add(tradeId);
      report.fillsImported += 1;
    }

    // 4. verdict
    const stillUnresolved = listLiveOrders(this.db, session.id).filter((o) => NEEDS_RESOLUTION.includes(o.status));
    if (stillUnresolved.length) report.mismatches.push({ kind: 'unresolved_orders', count: stillUnresolved.length });
    if (report.errors.length && !exchangeOrders.size && !openOrders.length) {
      report.state = 'failed';
    } else {
      report.state = report.mismatches.length ? 'mismatch' : 'ok';
    }
    setSessionReconciliation(this.db, session.id, report.state);
    return report;
  }
}

/** Trading may resume only after a clean reconciliation. */
export function canTradeAfterReconciliation(session) {
  return session?.reconciliation_state === 'ok';
}