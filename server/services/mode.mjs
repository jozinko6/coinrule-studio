/**
 * mode.mjs — trading mode state machine (Phase 8).
 *
 *   offline  — no network at all, synthetic data only
 *   paper    — virtual money, public market data (default after start)
 *   testnet  — real signed orders against Binance TESTNET (needs credentials)
 *   live     — real money; only reachable FROM testnet with an explicit confirm
 *
 * Safety invariants:
 *   - no path leads to `live` implicitly;
 *   - entering live/testnet never disengages the LiveRiskGuard kill switch;
 *   - `disableLive()` is always allowed from any mode and returns to paper.
 */

export const MODES = Object.freeze(['offline', 'paper', 'testnet', 'live']);

export class ModeTransitionError extends Error {
  constructor(message, { from, to, reason = 'invalid_transition' } = {}) {
    super(message);
    this.name = 'ModeTransitionError';
    this.from = from;
    this.to = to;
    this.reason = reason;
  }
}

export class TradingModeManager {
  constructor({ clock = () => Date.now(), hasCredentials = () => false, onTransition = null, initial = 'paper' } = {}) {
    if (!MODES.includes(initial)) throw new Error(`Neznámy mód: ${initial}`);
    if (initial === 'live' || initial === 'testnet') {
      throw new Error('TradingModeManager: live/testnet nemožno inicializovať priamo — iba cez prechody s kontrolami.');
    }
    this.clock = clock;
    this.hasCredentials = hasCredentials;
    this.onTransition = onTransition;
    this.mode = initial;
    this.since = clock();
    this.history = [{ mode: initial, at: this.since, reason: 'start' }];
  }

  _transition(to, reason) {
    const from = this.mode;
    this.mode = to;
    this.since = this.clock();
    const event = { mode: to, from, at: this.since, reason };
    this.history.push(event);
    this.onTransition?.(event);
    return event;
  }

  get isLive() { return this.mode === 'live'; }
  get canTrade() { return this.mode === 'paper' || this.mode === 'testnet' || this.mode === 'live'; }
  get needsCredentials() { return this.mode === 'testnet' || this.mode === 'live'; }

  goOffline() {
    if (this.mode === 'live' || this.mode === 'testnet') {
      throw new ModeTransitionError('Najprv vypni live/testnet (disableLive).', { from: this.mode, to: 'offline', reason: 'disable_live_first' });
    }
    return this._transition('offline', 'operator');
  }

  goPaper() {
    return this._transition('paper', 'operator');
  }

  /** Paper/offline -> testnet requires stored credentials. */
  goTestnet() {
    if (this.mode === 'live') {
      throw new ModeTransitionError('Z live sa najprv vráť do paper (disableLive).', { from: this.mode, to: 'testnet', reason: 'disable_live_first' });
    }
    if (!this.hasCredentials()) {
      throw new ModeTransitionError('Testnet vyžaduje uložené API kľúče.', { from: this.mode, to: 'testnet', reason: 'missing_credentials' });
    }
    return this._transition('testnet', 'operator');
  }

  /**
   * Enter live trading. Requires testnet first plus an explicit typed confirm.
   * @param {{confirm: string, acknowledgeRisk: boolean}} options
   */
  enableLive({ confirm, acknowledgeRisk = false } = {}) {
    if (this.mode !== 'testnet') {
      throw new ModeTransitionError('Live je možné zapnúť iba z TESTNET mód (najprv otestuj).', { from: this.mode, to: 'live', reason: 'testnet_first' });
    }
    if (!this.hasCredentials()) {
      throw new ModeTransitionError('Live vyžaduje uložené API kľúče.', { from: this.mode, to: 'live', reason: 'missing_credentials' });
    }
    if (confirm !== 'LIVE' || acknowledgeRisk !== true) {
      throw new ModeTransitionError('Live vyžaduje potvrdenie confirm:"LIVE" a acknowledgeRisk:true.', { from: this.mode, to: 'live', reason: 'confirmation_required' });
    }
    return this._transition('live', 'operator_confirmed');
  }

  /** Always allowed; the kill switch state is intentionally not touched. */
  disableLive() {
    if (this.mode !== 'live' && this.mode !== 'testnet') {
      throw new ModeTransitionError('Nie si v live/testnet móde.', { from: this.mode, to: 'paper', reason: 'not_live' });
    }
    return this._transition('paper', 'operator');
  }

  snapshot() {
    return { mode: this.mode, since: this.since, canTrade: this.canTrade, needsCredentials: this.needsCredentials, history: [...this.history] };
  }
}