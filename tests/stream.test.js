/**
 * stream.test.js — the kline WebSocket state machine with fake socket/timers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RECONNECT, KlineStream, klineStreamUrl, normalizeKlineEvent } from '../js/core/stream.js';

function makeTimers(start = 1_000) {
  let now = start;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { id += 1; timers.set(id, { fn, at: now + ms, ms }); return id; },
    clearTimeout: (tid) => { timers.delete(tid); },
    advance: (ms) => {
      now += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [tid, timer] of [...timers]) {
          if (timer.at <= now) { timers.delete(tid); timer.fn(); fired = true; break; }
        }
      }
    },
    pending: () => [...timers.values()].map((t) => t.ms),
  };
}

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.closed = false; FakeSocket.instances.push(this); }
  close() { if (!this.closed) { this.closed = true; this.onclose?.({ code: 1000, wasClean: true }); } }
  open() { this.readyState = 1; this.onopen?.({}); }
  message(payload) { this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) }); }
  serverClose() { this.closed = true; this.onclose?.({ code: 1006 }); }
  error() { this.onerror?.({ message: 'boom' }); }
  static reset() { FakeSocket.instances = []; }
}

function make(overrides = {}) {
  FakeSocket.reset();
  const timers = makeTimers();
  const klines = [];
  const statuses = [];
  const stream = new KlineStream({
    symbol: 'BTCUSDT',
    socketFactory: (url) => new FakeSocket(url),
    onKline: (k) => klines.push(k),
    onStatus: (s) => statuses.push(s),
    clock: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    staleAfterMs: 3_000,
    ...overrides,
  });
  return { stream, timers, klines, statuses, socket: () => FakeSocket.instances.at(-1) };
}

const klineEvent = (close, closed = false) => ({
  e: 'kline',
  k: { t: 1_700_000_000_000, o: '100.0', h: '110.0', l: '90.0', c: String(close), v: '12.5', x: closed, i: '1m', s: 'BTCUSDT' },
});

test('klineStreamUrl builds the documented endpoint', () => {
  assert.equal(klineStreamUrl('BTCUSDT'), 'wss://stream.binance.com:9443/ws/btcusdt@kline_1m');
  assert.equal(klineStreamUrl('ethusdt', '5m'), 'wss://stream.binance.com:9443/ws/ethusdt@kline_5m');
  assert.throws(() => klineStreamUrl(''), /symbol/);
});

test('normalizeKlineEvent accepts real klines and rejects everything else', () => {
  const ok = normalizeKlineEvent(klineEvent('105.5', true));
  assert.equal(ok.close, 105.5);
  assert.equal(ok.time, 1_700_000_000_000);
  assert.equal(ok.closed, true);
  assert.equal(ok.symbol, 'BTCUSDT');
  assert.equal(normalizeKlineEvent({ e: 'kline' }), null);
  assert.equal(normalizeKlineEvent({ k: { t: 'x', o: 1, h: 1, l: 1, c: 1, v: 1 } }), null);
  assert.equal(normalizeKlineEvent(null), null);
});

test('connect/open/message drives the callbacks and counters', () => {
  const { stream, klines, statuses, socket } = make();
  stream.connect();
  assert.equal(stream.status().state, 'connecting');
  socket().open();
  assert.equal(stream.status().state, 'open');

  socket().message(klineEvent('101'));
  assert.equal(klines.length, 1);
  assert.equal(klines[0].close, 101);
  assert.equal(stream.status().received, 1);

  socket().message({ e: 'aggTrade', p: '1' });
  socket().message('not json at all');
  assert.equal(stream.status().dropped, 2);
  assert.equal(stream.status().lastMessageAt, 1_000);
  assert.deepEqual(statuses.map((s) => s.state), ['connecting', 'open']);
});

test('an unexpected close reconnects with exponential backoff and open resets it', () => {
  const { stream, timers, socket } = make();
  stream.connect();
  socket().open();
  socket().serverClose();
  assert.equal(stream.status().state, 'reconnecting');
  assert.deepEqual(timers.pending(), [DEFAULT_RECONNECT.baseMs]);

  timers.advance(DEFAULT_RECONNECT.baseMs);
  assert.equal(FakeSocket.instances.length, 2, 'a fresh socket after the delay');
  assert.equal(stream.status().attempts, 1);

  FakeSocket.instances[1].serverClose(); // never opened -> backoff doubles
  assert.deepEqual(timers.pending(), [2 * DEFAULT_RECONNECT.baseMs]);

  timers.advance(2 * DEFAULT_RECONNECT.baseMs);
  FakeSocket.instances[2].open();
  assert.equal(stream.status().attempts, 0, 'a successful open resets the backoff');
});

test('a silent socket is declared stale once, then forced to reconnect', () => {
  const { stream, timers, statuses, socket } = make();
  stream.connect();
  socket().open();
  const first = socket();

  timers.advance(2_000);
  assert.equal(stream.status().stale, false, 'still inside the staleness window');

  timers.advance(4_000);
  assert.equal(statuses.filter((s) => s.state === 'stale').length, 1, 'stale is reported exactly once');
  assert.equal(first.closed, true, 'the silent socket is closed');
  assert.equal(stream.status().state, 'reconnecting');

  timers.advance(1_000); // first reconnect attempt
  const second = socket();
  second.open();
  second.message(klineEvent('102'));
  timers.advance(1_000);
  assert.equal(statuses.filter((s) => s.state === 'stale').length, 1, 'messages keep the stream fresh');
});

test('a live socket never goes stale and connect() is idempotent', () => {
  const { stream, timers, statuses, socket } = make();
  stream.connect();
  stream.connect();
  assert.equal(FakeSocket.instances.length, 1, 'a second connect must not open another socket');
  socket().open();
  for (let i = 0; i < 5; i += 1) {
    timers.advance(2_000);
    socket().message(klineEvent('103'));
  }
  assert.equal(statuses.filter((s) => s.state === 'stale').length, 0);
});

test('disconnect stops reconnects and clears every timer', () => {
  const { stream, timers, socket } = make();
  stream.connect();
  socket().open();
  socket().serverClose();
  assert.equal(timers.pending().length, 1);

  stream.disconnect();
  assert.equal(stream.status().state, 'closed');
  assert.equal(timers.pending().length, 0, 'no timers may survive a disconnect');
  timers.advance(120_000);
  assert.equal(FakeSocket.instances.length, 1, 'no reconnect after a manual disconnect');
});

test('a socket factory failure is reported and retried', () => {
  const timers = makeTimers();
  const statuses = [];
  let calls = 0;
  const stream = new KlineStream({
    symbol: 'BTCUSDT',
    socketFactory: () => { calls += 1; throw new Error('WebSocket nie je k dispozícii'); },
    onStatus: (s) => statuses.push(s),
    clock: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });
  stream.connect();
  assert.equal(calls, 1);
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(timers.pending().length, 1, 'the retry is scheduled without a socket');
  timers.advance(1_000);
  assert.equal(calls, 2, 'the retry actually calls the factory again');
  stream.disconnect();
});