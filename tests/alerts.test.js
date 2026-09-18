/**
 * alerts.test.js — reference fixtures for the local alert engine.
 *
 * Alert evaluation is pure, so every fixture is hand-built and the expected
 * message/value is asserted, not just the boolean.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_KINDS, ALERT_KIND_IDS, applyTriggers, checkAlerts, createAlert,
  defaultParams, describeAlert, evaluateAlert, getAlertKind, validateAlert,
} from '../js/core/alerts.js';

const series = (values, { volume = 1000, wick = 0.001 } = {}) => values.map((close, i) => ({
  time: i * 3_600_000,
  open: i === 0 ? close : values[i - 1],
  high: close * (1 + wick),
  low: close * (1 - wick),
  close,
  volume: Array.isArray(volume) ? volume[i] : volume,
}));
const ramp = (from, to, n) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
const flat = (value, n) => new Array(n).fill(value);
const mk = (kind, params = {}, extra = {}) => createAlert({ kind, params, symbol: 'TESTUSDT', ...extra });

/* ---------------------------------------------------------------- registry */

test('the alert registry is complete and unique', () => {
  assert.ok(ALERT_KINDS.length >= 12, `only ${ALERT_KINDS.length} kinds`);
  assert.equal(new Set(ALERT_KIND_IDS).size, ALERT_KINDS.length, 'duplicate kind id');
  for (const kind of ALERT_KINDS) {
    assert.ok(kind.label && kind.description, `${kind.id} is missing docs`);
    assert.ok(Number.isInteger(kind.warmup) && kind.warmup > 0, `${kind.id} has a bad warmup`);
    assert.equal(typeof kind.describe, 'function');
    assert.equal(typeof kind.evaluate, 'function');
    for (const [key, spec] of Object.entries(kind.params)) {
      assert.ok(spec.label, `${kind.id}.${key} has no label`);
      assert.ok(Number.isFinite(spec.default), `${kind.id}.${key} has no numeric default`);
    }
    assert.equal(getAlertKind(kind.id), kind);
  }
  assert.equal(getAlertKind('nope'), null);
});

test('defaultParams returns a fresh object per call', () => {
  const a = defaultParams('rsi_above');
  assert.equal(a.value, 70);
  a.value = 1;
  assert.equal(defaultParams('rsi_above').value, 70);
  assert.deepEqual(defaultParams('nope'), {});
});

/* ------------------------------------------------------------------- model */

test('createAlert applies defaults and normalises the symbol', () => {
  const alert = createAlert({ symbol: 'ethusdt', kind: 'rsi_below', params: { value: 25 } });
  assert.match(alert.id, /^al_/);
  assert.equal(alert.symbol, 'ETHUSDT');
  assert.equal(alert.kind, 'rsi_below');
  assert.equal(alert.params.value, 25);
  assert.equal(alert.params.period, 14, 'default params must be merged in');
  assert.equal(alert.enabled, true);
  assert.equal(alert.triggerCount, 0);
});

test('validateAlert accepts a complete alert and rejects broken ones', () => {
  assert.deepEqual(validateAlert(mk('price_above', { value: 100 })), []);
  assert.deepEqual(validateAlert(null), ['Upozornenie chýba.']);
  assert.match(validateAlert({ ...mk('price_above'), kind: 'nope' })[0], /Neznámy typ/);
  assert.match(validateAlert({ ...mk('price_above'), symbol: '' })[0], /obchodný pár/);
  assert.match(validateAlert(mk('price_above', { value: 'x' }))[0], /musí byť číslo/);
  assert.match(validateAlert(mk('volume_spike', { mult: 0.5 }))[0], /aspoň 1\.1/);
});

test('describeAlert renders a human sentence', () => {
  assert.match(describeAlert(mk('price_above', { value: 123 })), /cena > 123/);
  assert.match(describeAlert(mk('rsi_below', { value: 30, period: 14 })), /RSI\(14\) < 30/);
  assert.equal(describeAlert({ kind: 'nope' }), 'Neznáme upozornenie');
});

/* -------------------------------------------------------------- evaluation */

test('evaluateAlert skips disabled, unknown and short-data cases', () => {
  const candles = series([100, 101]);
  assert.deepEqual(evaluateAlert({ kind: 'nope' }, candles), { triggered: false, skipped: true, reason: 'neznámy typ' });
  const off = evaluateAlert(mk('price_above', { value: 0 }, { enabled: false }), candles);
  assert.equal(off.skipped, true);
  assert.equal(off.reason, 'vypnuté');
  const short = evaluateAlert(mk('rsi_above', { value: 70, period: 14 }), candles);
  assert.equal(short.skipped, true);
  assert.equal(short.reason, 'málo dát');
});

test('price_above and price_below compare with the last close', () => {
  const candles = series([100, 104]);
  assert.equal(evaluateAlert(mk('price_above', { value: 103 }), candles).triggered, true);
  assert.equal(evaluateAlert(mk('price_above', { value: 105 }), candles).triggered, false);
  assert.equal(evaluateAlert(mk('price_below', { value: 105 }), candles).triggered, true);
  assert.equal(evaluateAlert(mk('price_below', { value: 100 }), candles).triggered, false);
});

test('change_pct kinds measure the exact lookback window', () => {
  const up = series([100, 101, 103, 106]);
  const upAlert = mk('change_pct_up', { pct: 5, bars: 3 });
  const upResult = evaluateAlert(upAlert, up);
  assert.equal(upResult.triggered, true);
  assert.equal(upResult.value, 6);

  const down = series([100, 99, 97, 94]);
  const downResult = evaluateAlert(mk('change_pct_down', { pct: 5, bars: 3 }), down);
  assert.equal(downResult.triggered, true);
  assert.equal(downResult.value, -6);

  // a smaller move must not fire
  assert.equal(evaluateAlert(mk('change_pct_up', { pct: 10, bars: 3 }), up).triggered, false);
});

test('rsi kinds use the configured period', () => {
  const rising = series(ramp(100, 180, 80));
  const falling = series(ramp(200, 120, 80));
  const up = evaluateAlert(mk('rsi_above', { value: 70, period: 14 }), rising);
  assert.equal(up.triggered, true);
  assert.equal(up.value, 100);
  assert.equal(evaluateAlert(mk('rsi_above', { value: 70, period: 14 }), falling).triggered, false);
  const down = evaluateAlert(mk('rsi_below', { value: 30, period: 14 }), falling);
  assert.equal(down.triggered, true);
  assert.equal(down.value, 0);
  assert.equal(evaluateAlert(mk('rsi_below', { value: 30, period: 14 }), rising).triggered, false);
});

test('volume_spike compares against the previous bars only', () => {
  const volumes = [...flat(1000, 29), 5000];
  const hit = evaluateAlert(mk('volume_spike', { mult: 2, period: 20 }), series(flat(100, 30), { volume: volumes }));
  assert.equal(hit.triggered, true);
  assert.equal(hit.value, 5);
  assert.match(hit.message, /5\.00x/);
  assert.equal(evaluateAlert(mk('volume_spike', { mult: 2, period: 20 }), series(flat(100, 30))).triggered, false);
});

test('breakout and breakdown compare with the prior range', () => {
  const base = flat(100, 30);
  assert.equal(evaluateAlert(mk('breakout_high', { period: 20 }), series([...base, 106])).triggered, true);
  assert.equal(evaluateAlert(mk('breakout_high', { period: 20 }), series([...base, 99])).triggered, false);
  assert.equal(evaluateAlert(mk('breakdown_low', { period: 20 }), series([...base, 94])).triggered, true);
  assert.equal(evaluateAlert(mk('breakdown_low', { period: 20 }), series([...base, 101])).triggered, false);
});

test('ema_cross kinds detect a fresh crossover', () => {
  const up = series([...ramp(120, 100, 40), 108, 116.64]);
  const upAlert = mk('ema_cross_up', { fast: 5, slow: 10 });
  assert.equal(evaluateAlert(upAlert, up).triggered, true);
  assert.match(evaluateAlert(upAlert, up).message, /nahor/);

  const down = series([...ramp(80, 100, 40), 92, 84.64]);
  const downAlert = mk('ema_cross_down', { fast: 5, slow: 10 });
  assert.equal(evaluateAlert(downAlert, down).triggered, true);
  assert.match(evaluateAlert(downAlert, down).message, /nadol/);

  // no crossover while the trend is steady
  assert.equal(evaluateAlert(upAlert, series(ramp(100, 130, 80))).triggered, false);
});

test('atr_pct_above measures volatility in percent of price', () => {
  const volatile = series(Array.from({ length: 80 }, (_, i) => 100 + (i % 2 ? 5 : -5)));
  const hit = evaluateAlert(mk('atr_pct_above', { pct: 3, period: 14 }), volatile);
  assert.equal(hit.triggered, true);
  assert.ok(hit.value > 3);
  const calm = series(flat(100, 80));
  assert.equal(evaluateAlert(mk('atr_pct_above', { pct: 3, period: 14 }), calm).triggered, false);
});

/* -------------------------------------------------------------- scheduling */

test('checkAlerts accepts arrays, Maps and plain objects', () => {
  const alert = mk('price_above', { value: 90 }, { id: 'a1' });
  const candles = series([100]);
  const asArray = checkAlerts([alert], [{ symbol: 'TESTUSDT', candles }], { now: 5 });
  assert.equal(asArray.checked, 1);
  assert.equal(asArray.triggers.length, 1);
  assert.equal(asArray.triggers[0].alertId, 'a1');
  assert.equal(asArray.triggers[0].at, 5);

  const asMap = checkAlerts([alert], new Map([['TESTUSDT', candles]]));
  assert.equal(asMap.triggers.length, 1);
  const asObject = checkAlerts([alert], { TESTUSDT: candles });
  assert.equal(asObject.triggers.length, 1);
});

test('checkAlerts reports skipped alerts instead of failing', () => {
  const missing = mk('price_above', { value: 90 }, { id: 'a1', symbol: 'NOPE' });
  const disabled = mk('price_above', { value: 90 }, { id: 'a2', enabled: false });
  const result = checkAlerts([missing, disabled], [{ symbol: 'TESTUSDT', candles: series([100]) }]);
  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.triggers, []);
});

test('checkAlerts honours the cooldown window', () => {
  const alert = mk('price_above', { value: 90 }, { id: 'a1', lastTriggeredAt: 1000 });
  const datasets = [{ symbol: 'TESTUSDT', candles: series([100]) }];
  assert.equal(checkAlerts([alert], datasets, { now: 2000, cooldownMs: 5000 }).triggers.length, 0);
  assert.equal(checkAlerts([alert], datasets, { now: 2000, cooldownMs: 500 }).triggers.length, 1);
});

test('applyTriggers updates counters immutably', () => {
  const alert = mk('price_above', { value: 90 }, { id: 'a1' });
  const updated = applyTriggers([alert], [{ alertId: 'a1' }, { alertId: 'a1' }], 777);
  assert.equal(updated[0].triggerCount, 2);
  assert.equal(updated[0].lastTriggeredAt, 777);
  assert.equal(alert.triggerCount, 0, 'the original alert must not be mutated');
  assert.equal(updated[0] === alert, false);
  const untouched = applyTriggers([alert], [{ alertId: 'other' }], 1);
  assert.equal(untouched[0], alert, 'untriggered alerts keep their identity');
});