/**
 * execution-broker.mjs — the ONLY way an order can reach a real exchange (Phase 14).
 *
 * Pipeline (every step is mandatory, in this order):
 *   1. mode must be TESTNET or LIVE (PAPER goes through the in-page engine);
 *   2. the session must have a clean reconciliation (no unexplained orders);
 *   3. the LiveRiskGuard gate runs BEFORE the network (kill switch included);
 *   4. exchange filters normalise (or reject) price/quantity/notional;
 *   5. OrderIdempotency guarantees at-most-once submission with a deterministic id.
 *
 * Cancellations are risk-reducing and therefore skip step 3, but still require
 * a live/testnet mode and a known order.
 */

import { RiskViolation } from './live-risk.mjs';
import { normalizeOrder } from '../exchange/filters.mjs';

export class ExecutionRefused extends Error {
  constructor(check, message, details = {}) {
    super(message);
    this.name = 'ExecutionRefused';
    this.check = check;
    this.details = details;
  }
}

export class ExecutionBroker {
  constructor({ mode, guard, rulesCache, idempotency, client, clock = () => Date.now() }) {
    for (const [name, value] of Object.entries({ mode, guard, rulesCache, idempotency, client })) {
      if (!value) throw new Error(`ExecutionBroker: chýba ${name}.`);
    }
    this.mode = mode;
    this.guard = guard;
    this.rulesCache = rulesCache;
    this.idempotency = idempotency;
    this.client = client;
    this.clock = clock;
  }

  assertLiveEnvironment() {
    if (this.mode.mode !== 'testnet' && this.mode.mode !== 'live') {
      throw new ExecutionRefused('mode', `Objednávky cez broker sú možné len v TESTNET/LIVE (teraz ${this.mode.mode}).`);
    }
  }

  assertSessionReconciled(session) {
    if (!session) throw new ExecutionRefused('session', 'Chýba live session.');
    if (session.reconciliation_state !== 'ok') {
      throw new ExecutionRefused('reconciliation', `Reconciliation session je "${session.reconciliation_state}" — obchodovanie je zablokované.`);
    }
  }

  async placeOrder({ session, symbol, side, type = 'MARKET', quantity, price = null, referencePrice = null, intentId, reduceOnly = false, test = false }) {
    this.assertLiveEnvironment();
    this.assertSessionReconciled(session);

    this.guard.checkOrder({ symbol, side, type, quantity, price, referencePrice, reduceOnly }); // throws RiskViolation

    const rules = await this.rulesCache.rules(symbol);
    if (!rules) throw new ExecutionRefused('rules', `Nepoznám pravidlá pre ${symbol}.`, { symbol });
    const normalized = normalizeOrder({ symbol, side, type, quantity, price, referencePrice }, rules);
    if (!normalized.ok) throw new ExecutionRefused('filters', normalized.errors.join(' '), { errors: normalized.errors });

    // Reserve the REAL notional (after step/tick normalisation), not the raw request.
    const unitPrice = Number(normalized.order.price ?? price ?? referencePrice ?? 0);
    const notional = Number((normalized.order.quantity * unitPrice).toFixed(8));

    const submitted = await this.idempotency.submit(
      {
        sessionId: session.id, symbol, side, type,
        qty: normalized.order.quantity, price: normalized.order.price ?? null,
        intentId, clientOrderId: normalized.order.clientOrderId ?? null, test,
      },
      (clientOrderId) => this.client.placeOrder({
        symbol, side, type,
        quantity: normalized.order.quantity,
        price: normalized.order.price ?? null,
        timeInForce: type === 'LIMIT' ? 'GTC' : null,
        clientOrderId, test,
      }),
    );

    if (!submitted.skipped) {
      this.guard.onOrderPlaced({ clientOrderId: submitted.clientOrderId, symbol, quote: notional });
    }
    return { ...submitted, normalized: normalized.order, notional };
  }

  async cancelOrder({ session, symbol, orderId = null, clientOrderId = null }) {
    this.assertLiveEnvironment();
    this.assertSessionReconciled(session);
    if (!orderId && !clientOrderId) throw new ExecutionRefused('order_id', 'Chýba orderId alebo clientOrderId.');
    const result = await this.client.cancelOrder({ symbol, orderId, origClientOrderId: clientOrderId });
    if (clientOrderId) this.guard.onOrderSettled({ clientOrderId });
    return result;
  }
}

export { RiskViolation };