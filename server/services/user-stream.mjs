/**
 * user-stream.mjs — user data stream as a polling fallback (Phase 13).
 *
 * Binance user-data streams are WebSocket-based, but this project must stay
 * zero-dependency, so local reconciliation is driven by a background poller:
 *   - every tick runs the reconciler (orders/fills/unknown resolution);
 *   - failures back off exponentially (base -> max);
 *   - if contact is lost longer than staleAfterMs while a risk guard is
 *     present, the poller ENGAGES the kill switch (stale exchange state must
 *     never look like "safe to trade"). It never disengages it automatically.
 */

export const DEFAULT_INTERVAL_MS = 5_000;
export const DEFAULT_STALE_AFTER_MS = 45_000;
export const DEFAULT_BACKOFF = Object.freeze({ baseMs: 1_000, maxMs: 60_000 });

export class UserStreamPoller {
  constructor({
    session, reconciler, guard = null,
    intervalMs = DEFAULT_INTERVAL_MS, staleAfterMs = DEFAULT_STALE_AFTER_MS,
    backoff = {}, clock = () => Date.now(),
    sleep = null,
    onEvent = null,
  } = {}) {
    if (!session) throw new Error('UserStreamPoller: chýba session.');
    if (!reconciler) throw new Error('UserStreamPoller: chýba reconciler.');
    this.session = session;
    this.reconciler = reconciler;
    this.guard = guard;
    this.intervalMs = intervalMs;
    this.staleAfterMs = staleAfterMs;
    this.backoffBaseMs = backoff.baseMs ?? DEFAULT_BACKOFF.baseMs;
    this.backoffMaxMs = backoff.maxMs ?? DEFAULT_BACKOFF.maxMs;
    this.clock = clock;
    this.sleep = sleep ?? ((ms) => this._defaultSleep(ms));
    this.onEvent = onEvent;
    this.sleepTimer = null;

    this.running = false;
    this.startedAt = clock();
    this.ticks = 0;
    this.failures = 0;
    this.lastSuccessAt = 0;
    this.lastError = null;
    this.currentBackoffMs = this.intervalMs;
    this.staleNotified = false;
  }

  /** Default sleep that stop() can cancel and that never keeps the process alive. */
  _defaultSleep(ms) {
    return new Promise((resolve) => {
      this.sleepTimer = setTimeout(() => { this.sleepTimer = null; resolve(); }, ms);
      if (typeof this.sleepTimer.unref === 'function') this.sleepTimer.unref();
    });
  }

  emit(event) {
    try { this.onEvent?.(event); } catch { /* listeners must never break the loop */ }
  }

  isStale() {
    const reference = this.lastSuccessAt || this.startedAt;
    return this.clock() - reference > this.staleAfterMs;
  }

  /** One deterministic pass; safe to call directly from tests. */
  async tick() {
    try {
      const report = await this.reconciler.reconcileSession(this.session);
      this.ticks += 1;
      this.lastSuccessAt = this.clock();
      this.lastError = null;
      this.currentBackoffMs = this.intervalMs;
      this.staleNotified = false;
      this.emit({ type: 'reconcile', at: this.lastSuccessAt, state: report.state, resolved: report.resolved, fillsImported: report.fillsImported });
      return { ok: true, report };
    } catch (err) {
      this.failures += 1;
      this.lastError = err?.message ?? String(err);
      this.currentBackoffMs = Math.min(this.backoffMaxMs, Math.max(this.backoffBaseMs, this.currentBackoffMs * 2));
      this.emit({ type: 'error', at: this.clock(), error: this.lastError, backoffMs: this.currentBackoffMs });

      if (this.isStale() && this.guard && !this.staleNotified) {
        this.staleNotified = true;
        const engagedNow = !this.guard.killSwitchEngaged;
        if (engagedNow) this.guard.setKillSwitch(true);
        this.emit({ type: 'stale', at: this.clock(), engagedKillSwitch: engagedNow });
      }
      return { ok: false, error: this.lastError };
    }
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.emit({ type: 'started', at: this.clock(), sessionId: this.session.id });
    this.loop();
    return this;
  }

  async loop() {
    while (this.running) {
      await this.tick();
      if (!this.running) break;
      await this.sleep(this.currentBackoffMs);
    }
    this.emit({ type: 'stopped', at: this.clock(), sessionId: this.session.id });
  }

  stop() {
    this.running = false;
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    return this;
  }

  status() {
    return {
      running: this.running,
      sessionId: this.session.id,
      ticks: this.ticks,
      failures: this.failures,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      backoffMs: this.currentBackoffMs,
      stale: this.isStale(),
      staleNotified: this.staleNotified,
    };
  }
}