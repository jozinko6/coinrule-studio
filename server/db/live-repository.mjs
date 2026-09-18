/**
 * live-repository.mjs — persistence for live/testnet sessions, orders and fills.
 * Kept separate from repositories.mjs so the live-trading surface is easy to audit.
 */

import crypto from 'node:crypto';
import { redactSecrets } from './repositories.mjs';

export function newLiveId(prefix = 'lo') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

export function createLiveSession(db, { id = newLiveId('ls'), environment = 'testnet', accountId = null, symbol = null, killSwitch = 1 } = {}) {
  db.prepare(`INSERT INTO live_sessions (id, environment, account_id, symbol, status, reconciliation_state, kill_switch, started_at)
              VALUES (?, ?, ?, ?, 'running', 'pending', ?, ?)`)
    .run(id, environment, accountId, symbol, killSwitch ? 1 : 0, Date.now());
  return getLiveSession(db, id);
}

export function getLiveSession(db, id) {
  return db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(id) ?? null;
}

export function listLiveSessions(db, { limit = 50 } = {}) {
  return db.prepare('SELECT * FROM live_sessions ORDER BY started_at DESC LIMIT ?').all(limit);
}

export function setSessionReconciliation(db, id, state) {
  db.prepare('UPDATE live_sessions SET reconciliation_state = ? WHERE id = ?').run(state, id);
}

export function stopLiveSession(db, id, { status = 'stopped' } = {}) {
  db.prepare('UPDATE live_sessions SET status = ?, ended_at = ? WHERE id = ?').run(status, Date.now(), id);
  return getLiveSession(db, id);
}

export function setSessionKillSwitch(db, id, engaged) {
  db.prepare('UPDATE live_sessions SET kill_switch = ? WHERE id = ?').run(engaged ? 1 : 0, id);
}

/**
 * Insert an order unless the clientOrderId already exists.
 * @returns {{order: object, inserted: boolean}}
 */
/** Append one immutable event for an order state change (Phase 18). */
export function appendOrderEvent(db, { clientOrderId = null, sessionId = null, status, exchangeOrderId = null, raw = null, at = Date.now() }) {
  if (!status) throw new Error('appendOrderEvent: chýba status.');
  const info = db.prepare(`INSERT INTO live_order_events (client_order_id, session_id, status, exchange_order_id, raw_json, at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(clientOrderId, sessionId, status, exchangeOrderId, raw ? JSON.stringify(redactSecrets(raw)) : null, at);
  return db.prepare('SELECT * FROM live_order_events WHERE id = ?').get(info.lastInsertRowid);
}

export function listOrderEvents(db, clientOrderId) {
  return db.prepare('SELECT * FROM live_order_events WHERE client_order_id = ? ORDER BY at, id').all(clientOrderId);
}

export function countOrderEvents(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM live_order_events').get().n);
}

export function insertLiveOrder(db, order) {
  const id = order.id ?? newLiveId('lo');
  const info = db.prepare(`INSERT OR IGNORE INTO live_orders
      (id, session_id, client_order_id, exchange_order_id, intent_id, symbol, side, type, qty, price, status, submitted_at, updated_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, order.sessionId, order.clientOrderId ?? null, order.exchangeOrderId ?? null, order.intentId ?? null,
      order.symbol, order.side, order.type, order.qty, order.price ?? null, order.status,
      order.submittedAt ?? Date.now(), Date.now(), order.raw ? JSON.stringify(redactSecrets(order.raw)) : null);
  if (info.changes === 1) {
    appendOrderEvent(db, {
      clientOrderId: order.clientOrderId ?? null, sessionId: order.sessionId, status: order.status ?? 'PENDING',
      exchangeOrderId: order.exchangeOrderId ?? null, raw: order.raw ?? null,
    });
  }
  return { order: getLiveOrderByClientId(db, order.clientOrderId) ?? getLiveOrderById(db, id), inserted: info.changes === 1 };
}

export function getLiveOrderById(db, id) {
  return db.prepare('SELECT * FROM live_orders WHERE id = ?').get(id) ?? null;
}

export function getLiveOrderByClientId(db, clientOrderId) {
  return db.prepare('SELECT * FROM live_orders WHERE client_order_id = ? ORDER BY updated_at DESC LIMIT 1').get(clientOrderId) ?? null;
}

export function updateLiveOrder(db, { clientOrderId, status, exchangeOrderId = null, raw = null }) {
  const before = getLiveOrderByClientId(db, clientOrderId);
  if (!before) throw new Error(`updateLiveOrder: neznámy clientOrderId ${clientOrderId}`);
  db.prepare(`UPDATE live_orders SET status = ?, exchange_order_id = COALESCE(?, exchange_order_id), raw_json = COALESCE(?, raw_json), updated_at = ? WHERE client_order_id = ?`)
    .run(status, exchangeOrderId, raw ? JSON.stringify(redactSecrets(raw)) : null, Date.now(), clientOrderId);
  if (before.status !== status || exchangeOrderId) {
    appendOrderEvent(db, { clientOrderId, sessionId: before.session_id, status, exchangeOrderId: exchangeOrderId ?? before.exchange_order_id, raw });
  }
  return getLiveOrderByClientId(db, clientOrderId);
}

export const OPEN_ORDER_STATUSES = ['PENDING', 'NEW', 'PARTIALLY_FILLED', 'UNKNOWN'];

export function listOpenLiveOrders(db, sessionId = null) {
  const rows = sessionId
    ? db.prepare('SELECT * FROM live_orders WHERE session_id = ? AND status IN (?,?,?,?) ORDER BY updated_at').all(sessionId, ...OPEN_ORDER_STATUSES)
    : db.prepare('SELECT * FROM live_orders WHERE status IN (?,?,?,?) ORDER BY updated_at').all(...OPEN_ORDER_STATUSES);
  return rows;
}

export function listLiveOrders(db, sessionId) {
  return db.prepare('SELECT * FROM live_orders WHERE session_id = ? ORDER BY submitted_at DESC').all(sessionId);
}

export function insertLiveFill(db, fill) {
  const id = fill.id ?? newLiveId('lf');
  db.prepare(`INSERT OR IGNORE INTO live_fills (id, session_id, order_id, exchange_trade_id, symbol, qty, price, fee, fee_asset, filled_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, fill.sessionId, fill.orderId ?? null, fill.exchangeTradeId ?? null, fill.symbol, fill.qty, fill.price, fill.fee ?? 0, fill.feeAsset ?? null, fill.filledAt ?? Date.now());
  return db.prepare('SELECT * FROM live_fills WHERE id = ?').get(id) ?? null;
}

export function listLiveFills(db, sessionId) {
  return db.prepare('SELECT * FROM live_fills WHERE session_id = ? ORDER BY filled_at').all(sessionId);
}

export function sumLiveFees(db, sessionId) {
  const row = db.prepare('SELECT COALESCE(SUM(fee), 0) AS fee FROM live_fills WHERE session_id = ?').get(sessionId);
  return Number(row?.fee ?? 0);
}