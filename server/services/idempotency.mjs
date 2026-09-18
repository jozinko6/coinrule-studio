/**
 * idempotency.mjs — exactly-once order submission (Phase 11).
 *
 * The exchange may see a request without the client seeing the response
 * (timeouts, dropped connections). Every order therefore gets a deterministic
 * clientOrderId which is persisted BEFORE submission and never reused. A
 * second submit of the same intent is skipped; an uncertain outcome is marked
 * UNKNOWN and must be resolved by reconciliation (Phase 12) — never by
 * resubmission.
 */

import crypto from 'node:crypto';
import {
  OPEN_ORDER_STATUSES, getLiveOrderByClientId, insertLiveOrder, updateLiveOrder,
} from '../db/live-repository.mjs';

const EXCHANGE_STATUS = {
  NEW: 'NEW',
  FILLED: 'FILLED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
};

/**
 * Deterministic, Binance-safe (<= 36 chars, [a-zA-Z0-9-]) client order id.
 * It is a pure function of the INTENT, never of the clock: a retry of the same
 * intent must produce the same id or idempotency would collapse.
 * `intentId` must be unique per intent instance (e.g. strategy id + cycle + action).
 */
export function clientOrderIdFor({ strategyId = 'manual', intentId = null, salt = '' } = {}) {
  if (!intentId) throw new Error('clientOrderIdFor: chýba intentId (stabilný identifikátor zámeru).');
  const clean = (value, max) => String(value ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, max);
  const strat = clean(strategyId, 8) || 'manual';
  const hash = crypto.createHash('sha1').update(`${strategyId}|${intentId}|${salt}`).digest('hex').slice(0, 12);
  return `cr-${strat}-${hash}`.slice(0, 36);
}

export class OrderIdempotency {
  constructor({ db }) {
    if (!db) throw new Error('OrderIdempotency: chýba db.');
    this.db = db;
  }

  lookup(clientOrderId) {
    return getLiveOrderByClientId(this.db, clientOrderId);
  }

  /**
   * Submit an order at most once.
   * @param {object} intent order intent (+ optional clientOrderId)
   * @param {(clientOrderId: string) => Promise<object>} submitFn the exchange call
   * @returns {Promise<{skipped: boolean, clientOrderId: string, order: object, result?: object, reason?: string}>}
   */
  async submit({ sessionId, symbol, side, type, qty, price = null, intentId = null, clientOrderId = null, test = false }, submitFn) {
    if (!clientOrderId && !intentId) {
      throw new Error('OrderIdempotency.submit: chýba intentId alebo clientOrderId — bez nich nie je možné zaručiť exactly-once.');
    }
    const id = clientOrderId ?? clientOrderIdFor({ strategyId: sessionId, intentId });
    const existing = this.lookup(id);
    if (existing) {
      const open = OPEN_ORDER_STATUSES.includes(existing.status);
      return { skipped: true, clientOrderId: id, order: existing, reason: open ? 'already_submitted' : 'id_used' };
    }

    insertLiveOrder(this.db, {
      sessionId, clientOrderId: id, symbol, side, type, qty, price, intentId, status: 'PENDING',
    });

    try {
      const result = await submitFn(id);
      const status = EXCHANGE_STATUS[result?.status] ?? 'NEW';
      const order = updateLiveOrder(this.db, {
        clientOrderId: id, status, exchangeOrderId: result?.orderId ? String(result.orderId) : null, raw: result,
      });
      return { skipped: false, clientOrderId: id, result, order };
    } catch (err) {
      // requestAccepted = the exchange may have got it; duplicate = it definitely did.
      const uncertain = Boolean(err?.requestAccepted || err?.duplicate);
      updateLiveOrder(this.db, {
        clientOrderId: id,
        status: uncertain ? 'UNKNOWN' : 'REJECTED',
        raw: { error: err?.message ?? String(err), code: err?.code ?? null },
      });
      err.clientOrderId = id;
      err.requiresReconciliation = uncertain;
      throw err;
    } finally {
      void test;
    }
  }

  /** Reconciliation (Phase 12) resolves an UNKNOWN order with exchange truth. */
  resolve(clientOrderId, status, raw = null) {
    return updateLiveOrder(this.db, { clientOrderId, status: EXCHANGE_STATUS[status] ?? status, raw });
  }
}