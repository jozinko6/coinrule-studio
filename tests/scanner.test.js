/**
 * scanner.test.js — reference fixtures for the multi-symbol market scanner.
 *
 * Every fixture is hand-built so the expected signal is unambiguous and the
 * assertions pin exact strengths, not just truthiness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCAN_FAMILIES, SCAN_PRESETS, SCANNER_DEFAULT_PRESETS, getPreset, percentileOf,
  quantileOf, scanMarket, scanSymbol, summariseScan,
} from '../js/core/scanner.js';

/** Build candles from a close series; `wick` adds a symmetric range. */
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

/* ---------------------------------------------------------------- registry */

test('the scanner registry is complete and unique', () => {
  assert.ok(SCAN_PRESETS.length >= 12, `only ${SCAN_PRESETS.length} presets`);
  const ids = SCAN_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate preset id');
  for (const preset of SCAN_PRESETS) {
    assert.ok(preset.name && preset.description, `${preset.id} is missing docs`);
    assert.ok(Object.keys(SCAN_FAMILIES).includes(preset.family), `${preset.id} has an unknown family`);
    assert.ok(Number.isInteger(preset.warmup) && preset.warmup > 0, `${preset.id} has a bad warmup`);
    assert.equal(typeof preset.evaluate, 'function');
    assert.equal(getPreset(preset.id), preset);
  }
  assert.equal(getPreset('nope'), null);
  for (const id of SCANNER_DEFAULT_PRESETS) assert.ok(getPreset(id), `default preset ${id} is unknown`);
});

test('percentile and quantile helpers interpolate correctly', () => {
  assert.equal(percentileOf([1, 2, 3, 4], 2.5), 50);
  assert.equal(percentileOf([1, 2, 3, 4], 0.5), 0);
  assert.equal(percentileOf([], 1), null);
  assert.equal(percentileOf([1], Number.NaN), null);
  assert.equal(quantileOf([1, 2, 3, 4], 0), 1);
  assert.equal(quantileOf([1, 2, 3, 4], 100), 4);
  assert.equal(quantileOf([1, 2, 3, 4], 50), 2.5);
  assert.equal(quantileOf([], 50), null);
});

/* ----------------------------------------------------------------- presets */

test('rsi presets fire on live markets and stay silent on a dead one', () => {
  const down = series(ramp(200, 120, 80));
  const up = series(ramp(100, 180, 80));

  const oversold = getPreset('rsi_oversold').evaluate(down, {});
  assert.ok(oversold && oversold.strength > 0.9, 'expected a deep oversold reading');
  assert.equal(getPreset('rsi_oversold').evaluate(up, {}), null);

  const overbought = getPreset('rsi_overbought').evaluate(up, {});
  assert.ok(overbought && overbought.strength > 0.9, 'expected a deep overbought reading');
  assert.equal(getPreset('rsi_overbought').evaluate(down, {}), null);

  // a market with zero range must not produce reversal signals
  const dead = series(flat(100, 80), { wick: 0 });
  assert.equal(getPreset('rsi_oversold').evaluate(dead, {}), null);
  assert.equal(getPreset('rsi_overbought').evaluate(dead, {}), null);
});

test('trend presets require a full EMA stack', () => {
  const up = series(ramp(100, 220, 260));
  const down = series(ramp(220, 100, 260));
  const upHit = getPreset('trend_up').evaluate(up, {});
  assert.ok(upHit && upHit.strength > 0, 'trend_up did not fire');
  assert.equal(getPreset('trend_up').evaluate(down, {}), null);
  const downHit = getPreset('trend_down').evaluate(down, {});
  assert.ok(downHit && downHit.strength > 0, 'trend_down did not fire');
  assert.equal(getPreset('trend_down').evaluate(up, {}), null);
});

test('breakout and breakdown use the prior range only', () => {
  const base = flat(100, 30);
  assert.ok(getPreset('breakout_20').evaluate(series([...base, 106]), {}));
  assert.equal(getPreset('breakout_20').evaluate(series([...base, 94]), {}), null);
  assert.ok(getPreset('breakdown_20').evaluate(series([...base, 94]), {}));
  assert.equal(getPreset('breakdown_20').evaluate(series([...base, 100.05]), {}), null);

  // the current bar must not count into its own range
  const fake = series([...base, 100.05]);
  fake[fake.length - 1].high = 200;
  assert.equal(getPreset('breakout_20').evaluate(fake, {}), null);
});

test('volume_spike compares with the average of the previous bars', () => {
  const volumes = [...flat(1000, 30), 5000];
  const hit = getPreset('volume_spike').evaluate(series(flat(100, 31), { volume: volumes }), {});
  assert.ok(hit, 'expected a volume spike');
  assert.match(hit.detail, /5\.00x/);
  assert.equal(getPreset('volume_spike').evaluate(series(flat(100, 31)), {}), null);
});

test('macd presets detect a fresh cross in both directions', () => {
  const bull = [...flat(100, 60), ...ramp(100, 88, 12), ...ramp(89, 101, 4)];
  const bullHit = getPreset('macd_bull_cross').evaluate(series(bull), {});
  assert.ok(bullHit, 'expected an upward MACD cross');
  assert.match(bullHit.detail, /nahor/);
  assert.equal(getPreset('macd_bear_cross').evaluate(series(bull), {}), null);

  const bear = [...flat(100, 60), ...ramp(100, 115, 15), ...ramp(114, 98, 5)];
  const bearHit = getPreset('macd_bear_cross').evaluate(series(bear), {});
  assert.ok(bearHit, 'expected a downward MACD cross');
  assert.match(bearHit.detail, /nadol/);
  assert.equal(getPreset('macd_bull_cross').evaluate(series(bear), {}), null);
});

test('bb_squeeze needs an actual contraction below the percentile', () => {
  const noisy = Array.from({ length: 120 }, (_, i) => 100 + (i % 2 ? 6 : -6));
  const quiet = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 0.05 : -0.05));
  const hit = getPreset('bb_squeeze').evaluate(series([...noisy, ...quiet]), {});
  assert.ok(hit && hit.strength > 0.9, 'expected a squeeze signal');

  // expanding range is the opposite of a squeeze
  const expanding = Array.from({ length: 160 }, (_, i) => 100 + Math.sin(i / 3) * (1 + i / 20));
  assert.equal(getPreset('bb_squeeze').evaluate(series(expanding), {}), null);

  // constant bandwidth is not "below" the percentile cut
  const constant = Array.from({ length: 160 }, (_, i) => 100 + (i % 2 ? 2 : -2));
  assert.equal(getPreset('bb_squeeze').evaluate(series(constant), {}), null);
});

test('momentum_burst needs price momentum and volume together', () => {
  const prices = [...flat(100, 30), ...ramp(100, 112, 11)];
  const volumes = [...flat(1000, 40), 3000];
  const hit = getPreset('momentum_burst').evaluate(series(prices, { volume: volumes }), {});
  assert.ok(hit, 'expected a momentum burst');
  assert.match(hit.detail, /\+12\.00 %/);
  assert.equal(getPreset('momentum_burst').evaluate(series(prices), {}), null);
});

/* -------------------------------------------------------------------- scan */

test('scanSymbol aggregates signals into a deterministic score', () => {
  const candles = series(ramp(100, 220, 260));
  const first = scanSymbol(candles, { symbol: 'TESTUSDT' });
  const second = scanSymbol(candles, { symbol: 'TESTUSDT' });
  assert.deepEqual(first, second);
  assert.equal(first.symbol, 'TESTUSDT');
  assert.equal(first.candles, 260);
  assert.equal(first.trend, 'up');
  assert.equal(first.notReady, false);
  assert.ok(first.signals.length >= 2, `expected multiple signals, got ${first.signals.length}`);
  assert.equal(first.matched, first.signals.length);
  assert.ok(first.score > 0 && first.score <= 100);
  assert.ok(Number.isFinite(first.rsi) && Number.isFinite(first.atrPct));
});

test('scanSymbol marks short series as not ready and still returns a shape', () => {
  const result = scanSymbol(series(ramp(100, 105, 10)), { symbol: 'X' });
  assert.equal(result.notReady, true);
  assert.equal(result.matched, 0);
  assert.equal(result.score, 0);
  assert.equal(result.symbol, 'X');
});

test('scanSymbol tolerates garbage input', () => {
  const result = scanSymbol(null, { symbol: 'X' });
  assert.equal(result.candles, 0);
  assert.equal(result.matched, 0);
  assert.deepEqual(result.signals, []);
});

test('scanMarket sorts ready series by score and keeps skipped ones last', () => {
  const strong = series(ramp(100, 220, 260));
  const weak = series(Array.from({ length: 260 }, (_, i) => 100 + (i % 2 ? 0.1 : -0.1)));
  const short = series(ramp(100, 101, 12));
  const presets = ['trend_up', 'rsi_overbought', 'breakout_20'];

  const results = scanMarket({
    datasets: [
      { symbol: 'SHORT', candles: short },
      { symbol: 'WEAK', candles: weak },
      { symbol: 'STRONG', candles: strong },
    ],
    presetIds: presets,
  });

  assert.deepEqual(results.map((r) => r.symbol), ['STRONG', 'WEAK', 'SHORT']);
  assert.equal(results[0].notReady, false);
  assert.equal(results[2].notReady, true);
  assert.ok(results[0].score > results[1].score);

  const summary = summariseScan(results);
  assert.equal(summary.scanned, 3);
  assert.equal(summary.ready, 2);
  assert.equal(summary.matched, 2);
  assert.equal(summary.top, 'STRONG');
  assert.ok(summary.avgScore > 0);
});

test('scanMarket ignores malformed datasets', () => {
  const results = scanMarket({ datasets: [null, {}, { symbol: 'OK', candles: series(flat(100, 30)) }] });
  assert.equal(results.length, 1);
  assert.equal(results[0].symbol, 'OK');
});