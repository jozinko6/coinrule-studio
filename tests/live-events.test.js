/**
 * live-events.test.js — append-only order audit trail (Phase 18): every state
 * change is recorded, rows can never be updated or deleted, and credential
 * shaped data inside raw payloads is redacted before it is stored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import {
  appendOrderEvent, countOrderEvents, createLiveSession, insertLiveOrder, listOrderEvents, updateLiveOrder,
} from '../server/db/live-repository.mjs';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinrule-events-'));
  const db = openDatabase({ file: path.join(dir, 'test.db') });
  const session = createLiveSession(db, { environment: 'testnet', symbol: 'BTCUSDT' });
  return { db, session, cleanup() { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('every order write appends an immutable event', () => {
  const { db, session, cleanup } = tempDb();
  try {
    insertLiveOrder(db, { sessionId: session.id, clientOrderId: 'cr-e1', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', qty: 0.001, price: 50000, status: 'PENDING' });
    assert.equal(countOrderEvents(db), 1);
    assert.equal(listOrderEvents(db, 'cr-e1')[0].status, 'PENDING');

    updateLiveOrder(db, { clientOrderId: 'cr-e1', status: 'NEW', exchangeOrderId: '4242' });
    updateLiveOrder(db, { clientOrderId: 'cr-e1', status: 'FILLED' });
    const events = listOrderEvents(db, 'cr-e1');
    assert.deepEqual(events.map((e) => e.status), ['PENDING', 'NEW', 'FILLED']);
    assert.equal(events[1].exchange_order_id, '4242');
    assert.equal(countOrderEvents(db), 3);

    // a no-op update must not pollute the trail
    updateLiveOrder(db, { clientOrderId: 'cr-e1', status: 'FILLED' });
    assert.equal(countOrderEvents(db), 3);
  } finally {
    cleanup();
  }
});

test('the database itself refuses to rewrite history', () => {
  const { db, session, cleanup } = tempDb();
  try {
    insertLiveOrder(db, { sessionId: session.id, clientOrderId: 'cr-e2', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 0.001, status: 'PENDING' });
    assert.throws(() => db.prepare("UPDATE live_order_events SET status = 'FILLED' WHERE client_order_id = 'cr-e2'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM live_order_events WHERE client_order_id = 'cr-e2'").run(), /append-only/);
    assert.equal(countOrderEvents(db), 1, 'the trail is unchanged after the rejected writes');
  } finally {
    cleanup();
  }
});

test('unknown order ids cannot be silently created by an update', () => {
  const { db, cleanup } = tempDb();
  try {
    assert.throws(() => updateLiveOrder(db, { clientOrderId: 'cr-ghost', status: 'FILLED' }), /neznámy/);
    assert.equal(countOrderEvents(db), 0);
  } finally {
    cleanup();
  }
});

test('raw payloads are redacted before they enter the trail', () => {
  const { db, session, cleanup } = tempDb();
  try {
    const event = appendOrderEvent(db, {
      clientOrderId: 'cr-e3', sessionId: session.id, status: 'NEW',
      raw: { ok: true, apiKey: 'super-secret-value', nested: { signature: 'sig-value', note: 'keep-me' } },
    });
    assert.ok(event.raw_json.includes('keep-me'), 'non-secret data survives');
    assert.ok(!event.raw_json.includes('super-secret-value'));
    assert.ok(!event.raw_json.includes('sig-value'));
  } finally {
    cleanup();
  }
});