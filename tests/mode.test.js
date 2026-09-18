/**
 * mode.test.js — the OFFLINE/PAPER/TESTNET/LIVE state machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ModeTransitionError, TradingModeManager } from '../server/services/mode.mjs';

function make({ credentials = false, now = 1_000 } = {}) {
  let t = now;
  const events = [];
  const manager = new TradingModeManager({ clock: () => t, hasCredentials: () => credentials, onTransition: (e) => events.push(e) });
  return { manager, events, advance: (ms) => { t += ms; } };
}

test('the machine starts in paper mode and can only trade there', () => {
  const { manager } = make();
  assert.equal(manager.mode, 'paper');
  assert.equal(manager.canTrade, true);
  assert.equal(manager.needsCredentials, false);
  assert.equal(manager.snapshot().history[0].reason, 'start');
  manager.goOffline();
  assert.equal(manager.canTrade, false);
  manager.goPaper();
  assert.equal(manager.canTrade, true);
});

test('testnet requires stored credentials', async () => {
  const { manager } = make({ credentials: false });
  await assert.rejects(Promise.resolve().then(() => manager.goTestnet()), (err) => err instanceof ModeTransitionError && err.reason === 'missing_credentials');

  const { manager: ready } = make({ credentials: true });
  ready.goTestnet();
  assert.equal(ready.mode, 'testnet');
  assert.equal(ready.needsCredentials, true);
});

test('live is unreachable from paper/offline, even with credentials', async () => {
  const { manager } = make({ credentials: true });
  await assert.rejects(Promise.resolve().then(() => manager.enableLive({ confirm: 'LIVE', acknowledgeRisk: true })), (err) => err.reason === 'testnet_first');
  manager.goOffline();
  await assert.rejects(Promise.resolve().then(() => manager.enableLive({ confirm: 'LIVE', acknowledgeRisk: true })), (err) => err.reason === 'testnet_first');
});

test('live needs a typed confirmation AND a risk acknowledgement', async () => {
  const { manager } = make({ credentials: true });
  manager.goTestnet();
  await assert.rejects(Promise.resolve().then(() => manager.enableLive({ confirm: 'live', acknowledgeRisk: true })), (err) => err.reason === 'confirmation_required');
  await assert.rejects(Promise.resolve().then(() => manager.enableLive({ confirm: 'LIVE', acknowledgeRisk: false })), (err) => err.reason === 'confirmation_required');
  manager.enableLive({ confirm: 'LIVE', acknowledgeRisk: true });
  assert.equal(manager.mode, 'live');
  assert.equal(manager.isLive, true);
});

test('disableLive always returns to paper and is logged', () => {
  const { manager, events, advance } = make({ credentials: true });
  manager.goTestnet();
  advance(500);
  manager.enableLive({ confirm: 'LIVE', acknowledgeRisk: true });
  const event = manager.disableLive();
  assert.equal(manager.mode, 'paper');
  assert.equal(manager.isLive, false);
  assert.equal(event.from, 'live');
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.mode), ['testnet', 'live', 'paper']);
  assert.throws(() => manager.disableLive(), /Nie si v live/);
  assert.equal(manager.goOffline().mode, 'offline', 'offline from paper is allowed');
});

test('offline cannot be entered from testnet/live directly', async () => {
  const { manager } = make({ credentials: true });
  manager.goTestnet();
  await assert.rejects(Promise.resolve().then(() => manager.goOffline()), (err) => err.reason === 'disable_live_first');
  assert.equal(manager.mode, 'testnet');
});

test('testnet cannot be entered from live without returning to paper', async () => {
  const { manager } = make({ credentials: true });
  manager.goTestnet();
  manager.enableLive({ confirm: 'LIVE', acknowledgeRisk: true });
  await assert.rejects(Promise.resolve().then(() => manager.goTestnet()), (err) => err.reason === 'disable_live_first');
  manager.disableLive();
  manager.goTestnet();
  assert.equal(manager.mode, 'testnet');
});

test('an unknown initial mode is rejected and live/testnet cannot be constructed directly', () => {
  assert.throws(() => new TradingModeManager({ initial: 'lambo' }), /Neznámy mód/);
  assert.throws(() => new TradingModeManager({ initial: 'live' }), /priamo/);
  assert.throws(() => new TradingModeManager({ initial: 'testnet' }), /priamo/);
  assert.equal(new TradingModeManager({ initial: 'offline' }).mode, 'offline');
});

test('snapshot reports mode, timing and full history', () => {
  const { manager, advance } = make({ credentials: true });
  advance(250);
  manager.goTestnet();
  advance(250);
  const snap = manager.snapshot();
  assert.equal(snap.mode, 'testnet');
  assert.equal(snap.since, 1_250);
  assert.equal(snap.history.length, 2);
  assert.equal(snap.needsCredentials, true);
});