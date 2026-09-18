/**
 * stream.js — browser kline WebSocket with reconnect and staleness handling (Phase 2).
 *
 * The exchange connection can fail in three different ways and all three are
 * handled explicitly:
 *   - transport closes  -> exponential-backoff reconnect;
 *   - socket silently stuck (no messages) -> stale watchdog forces a reconnect;
 *   - the user leaves the view -> disconnect() stops everything, no timers leak.
 *
 * Everything is injectable (socket factory, clock, timers) so the whole state
 * machine is deterministic in tests, including "the socket never opened".
 */

export const KLINE_WS_BASE = 'wss://stream.binance.com:9443/ws';
export const DEFAULT_RECONNECT = Object.freeze({ baseMs: 1_000, maxMs: 30_000 });
export const DEFAULT_STALE_MS = 90_000;

export function klineStreamUrl(symbol, interval = '1m') {
  if (!symbol) throw new Error('klineStreamUrl: chýba symbol.');
  return `${KLINE_WS_BASE}/${String(symbol).toLowerCase()}@kline_${interval}`;
}

/** Binance kline payload -> compact candle, or null when the event is not a usable kline. */
export function normalizeKlineEvent(event) {
  const k = event?.k;
  if (!k || typeof k !== 'object') return null;
  const time = Number(k.t);
  const open = Number(k.o);
  const high = Number(k.h);
  const low = Number(k.l);
  const close = Number(k.c);
  const volume = Number(k.v);
  if (![time, open, high, low, close, volume].every(Number.isFinite)) return null;
  return {
    time,
    open,
    high,
    low,
    close,
    volume,
    closed: Boolean(k.x),
    interval: k.i ?? null,
    symbol: k.s ?? null,
  };
}

export class KlineStream {
  constructor({
    symbol, interval = '1m', url = null,
    socketFactory = null,
    onKline = null, onStatus = null,
    clock = () => Date.now(),
    reconnect = {},
    staleAfterMs = DEFAULT_STALE_MS,
    setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutImpl = (id) => clearTimeout(id),
  } = {}) {
    this.symbol = symbol;
    this.url = url ?? klineStreamUrl(symbol, interval);
    this.socketFactory = socketFactory ?? ((target) => {
      const WS = globalThis.WebSocket;
      if (!WS) throw new Error('WebSocket nie je v tomto prostredí k dispozícii — použi socketFactory.');
      return new WS(target);
    });
    this.onKline = onKline;
    this.onStatus = onStatus;
    this.clock = clock;
    this.reconnectBaseMs = reconnect.baseMs ?? DEFAULT_RECONNECT.baseMs;
    this.reconnectMaxMs = reconnect.maxMs ?? DEFAULT_RECONNECT.maxMs;
    this.staleAfterMs = staleAfterMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;

    this.state = 'idle';
    this.attempts = 0;
    this.received = 0;
    this.dropped = 0;
    this.lastMessageAt = 0;
    this.socket = null;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.manualClose = false;
    this.staleNotified = false;
  }

  emitStatus(state, extra = {}) {
    this.state = state;
    const payload = { state, symbol: this.symbol, attempts: this.attempts, at: this.clock(), ...extra };
    try { this.onStatus?.(payload); } catch { /* listeners must never break the stream */ }
    return payload;
  }

  status() {
    return {
      state: this.state,
      symbol: this.symbol,
      attempts: this.attempts,
      received: this.received,
      dropped: this.dropped,
      lastMessageAt: this.lastMessageAt,
      stale: this.isStale(),
    };
  }

  isStale() {
    if (this.state !== 'open' || !this.lastMessageAt) return false;
    return this.clock() - this.lastMessageAt > this.staleAfterMs;
  }

  connect() {
    if (this.socket || this.state === 'open' || this.state === 'connecting') return this;
    this.manualClose = false;
    this.emitStatus('connecting');
    let socket;
    try {
      socket = this.socketFactory(this.url);
    } catch (err) {
      this.emitStatus('error', { error: err?.message ?? String(err) });
      this.scheduleReconnect();
      return this;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.lastMessageAt = this.clock();
      this.staleNotified = false;
      this.emitStatus('open');
      this.scheduleWatchdog();
    };
    socket.onmessage = (message) => this.handleMessage(message);
    socket.onerror = (err) => this.emitStatus('error', { error: err?.message ?? 'socket error' });
    socket.onclose = () => this.handleClose();
    return this;
  }

  handleMessage(message) {
    let event = null;
    try { event = JSON.parse(typeof message?.data === 'string' ? message.data : message?.data); }
    catch { this.dropped += 1; return; }
    const kline = normalizeKlineEvent(event);
    if (!kline) { this.dropped += 1; return; }
    this.received += 1;
    this.lastMessageAt = this.clock();
    this.staleNotified = false;
    try { this.onKline?.(kline); } catch { /* consumer errors are not transport errors */ }
  }

  handleClose() {
    this.socket = null;
    this.clearWatchdog();
    if (this.manualClose) { this.clearWatchdog(); return this.emitStatus('closed'); }
    this.emitStatus('reconnecting', { nextDelayMs: this.nextDelayMs() });
    this.scheduleReconnect();
    return undefined;
  }

  nextDelayMs() {
    return Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.attempts);
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.manualClose) return;
    const delay = this.nextDelayMs();
    this.attempts += 1;
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) this.connect();
    }, delay);
  }

  scheduleWatchdog() {
    this.clearWatchdog();
    const tick = Math.max(1_000, Math.floor(this.staleAfterMs / 3));
    this.watchdogTimer = this.setTimeoutImpl(() => {
      this.watchdogTimer = null;
      if (this.manualClose || this.state !== 'open') return;
      if (this.isStale()) {
        if (!this.staleNotified) {
          this.staleNotified = true;
          this.emitStatus('stale', { sinceMs: this.clock() - this.lastMessageAt });
        }
        // Force a reconnect: closing the socket reuses the normal close path.
        const socket = this.socket;
        this.socket = null;
        try { socket?.close?.(); } catch { /* ignore */ }
        if (!this.reconnectTimer) { this.emitStatus('reconnecting', { nextDelayMs: this.nextDelayMs() }); this.scheduleReconnect(); }
        return;
      }
      this.scheduleWatchdog();
    }, tick);
  }

  clearWatchdog() {
    if (this.watchdogTimer) {
      this.clearTimeoutImpl(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  disconnect() {
    this.manualClose = true;
    if (this.reconnectTimer) { this.clearTimeoutImpl(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearWatchdog();
    const socket = this.socket;
    this.socket = null;
    try { socket?.close?.(); } catch { /* ignore */ }
    this.emitStatus('closed');
    return this;
  }
}