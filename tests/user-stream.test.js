/**
 * user-stream.test.js — polling fallback: backoff, stale detection and the
 * rule that stale exchange state engages (never disengages) the kill switch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { UserStreamPoller } from '../server/services/user-stream.mjs';
import { LiveRiskGuard } from '../server/services/live-risk.mjs';

function make(overrides = {}) {
  let now = 0;
  const events = [];
  const ok = { state: 'ok', resolved: [], fillsImported: 2 };
  const state = { fail: false, calls: 0 };
  const reconciler = {
    async reconcileSession() {
      state.calls += 1;
      if (state.fail) throw new Error('network down');
      return ok;
    },
  };
  const guard = overrides.guard === undefined
    ? (() => { const g = new LiveRiskGuard({ clock: () => now }); g.startSession({ equityQuote: 10_000, killSwitch: false }); return g; })()
    : overrides.guard;
  const poller = new UserStreamPoller({
    session: { id: 'ls_test' },
    reconciler,
    guard,
    intervalMs: 100,
    staleAfterMs: 1_000,
    clock: () => now,
    sleep: async () => {},
    onEvent: (e) => events.push(e),
    ...overrides.poller,
  });
  return { poller, guard, state, events, advance: (ms) => { now += ms; } };
}

test('a successful tick reconciles and resets the backoff', async () => {
  const { poller, state, events } = make();
  const result = await poller.tick();
  assert.equal(result.ok, true);
  assert.equal(state.calls, 1);
  assert.equal(poller.status().ticks, 1);
  assert.equal(poller.status().backoffMs, 100);
  assert.equal(events.filter((e) => e.type === 'reconcile').length, 1);
  assert.equal(events.find((e) => e.type === 'reconcile').fillsImported, 2);
  assert.equal(poller.isStale(), false);
});

test('failures back off exponentially up to the cap and recover on success', async () => {
  const { poller, state } = make({ poller: { backoff: { baseMs: 100, maxMs: 500 } } });
  state.fail = true;
  await poller.tick();
  assert.equal(poller.status().backoffMs, 200);
  await poller.tick();
  assert.equal(poller.status().backoffMs, 400);
  await poller.tick();
  assert.equal(poller.status().backoffMs, 500, 'capped');
  assert.equal(poller.status().failures, 3);
  assert.match(poller.status().lastError, /network down/);

  state.fail = false;
  await poller.tick();
  assert.equal(poller.status().backoffMs, 100, 'success resets the interval');
  assert.equal(poller.status().lastError, null);
});

test('stale contact engages the kill switch exactly once and never disengages it', async () => {
  const { poller, guard, state, events, advance } = make();
  state.fail = true;
  await poller.tick();                        // t=0, not stale yet
  assert.equal(guard.killSwitchEngaged, false);
  advance(1_500);
  await poller.tick();                        // stale now
  assert.equal(guard.killSwitchEngaged, true, 'a stale exchange view must stop trading');
  assert.equal(events.filter((e) => e.type === 'stale').length, 1);

  await poller.tick();                        // still stale: no duplicate event
  assert.equal(events.filter((e) => e.type === 'stale').length, 1);

  state.fail = false;
  await poller.tick();                        // recovery
  assert.equal(poller.status().stale, false);
  assert.equal(guard.killSwitchEngaged, true, 'recovery never re-enables trading automatically');
});

test('a poller without a guard still detects staleness', async () => {
  const { poller, state, advance } = make({ guard: null });
  state.fail = true;
  await poller.tick();
  advance(2_000);
  await poller.tick();
  assert.equal(poller.status().stale, true);
});

test('start runs the loop and stop ends it after the current tick', async () => {
  // The loop must yield to the macrotask queue between ticks; an immediately
  // resolved sleep would starve setImmediate/timers and spin forever.
  const { poller, state } = make({ poller: { sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) } });
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(poller.status().running, true);
  assert.ok(state.calls >= 1);

  poller.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const callsAtStop = state.calls;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(poller.status().running, false);
  assert.equal(state.calls, callsAtStop, 'no further ticks after stop');
});

test('the poller validates its dependencies', () => {
  assert.throws(() => new UserStreamPoller({ reconciler: {} }), /session/);
  assert.throws(() => new UserStreamPoller({ session: { id: 'x' } }), /reconciler/);
});
test('stop cancels a long pending sleep instead of holding the process', async () => {
  // sleep: null -> the poller's cancellable default timer (not the test stub)
  const { poller } = make({ poller: { intervalMs: 3_600_000, sleep: null, sleepIsNull: true } });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(poller.status().running, true);
  poller.stop();
  assert.equal(poller.status().running, false);
  assert.equal(poller.sleepTimer, null, 'the pending timer must be cleared');
});