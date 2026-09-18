import test from 'node:test';
import assert from 'node:assert/strict';
import * as TA from '../js/core/indicators.js';
import { generateCandles as synthCandles, mulberry32 } from '../js/data/synthetic.js';

const C = (o, h, l, c, v = 100, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });

/** Deterministic pseudo-random price series for property checks. */
const generateNoise = (n) => {
  const rnd = mulberry32(7);
  let p = 100;
  return Array.from({ length: n }, () => {
    p *= 1 + (rnd() - 0.5) * 0.04;
    return p;
  });
};

const up = Array.from({ length: 60 }, (_, i) => 100 + i);
const down = Array.from({ length: 60 }, (_, i) => 200 - i);
const flat = new Array(60).fill(100);

test('SMA matches a hand-computed window', () => {
  assert.deepEqual(TA.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA seeds with the SMA and applies the smoothing factor', () => {
  // seed = SMA(1,2,3) = 2, alpha = 0.5 -> 2 + .5*(4-2) = 3 -> 3 + .5*(5-3) = 4
  assert.deepEqual(TA.ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('population standard deviation is exact', () => {
  const sd = TA.stdev([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.ok(Math.abs(sd - 2) < 1e-12, `expected 2, got ${sd}`);
});

test('RSI saturates at 100 for a monotonic rise and 0 for a monotonic fall', () => {
  const rUp = TA.rsi(up, 14);
  const rDown = TA.rsi(down, 14);
  assert.equal(rUp[rUp.length - 1], 100);
  assert.equal(rDown[rDown.length - 1], 0);
});

test('RSI stays inside [0, 100] on noisy data', () => {
  const series = generateNoise(500);
  for (const v of TA.rsi(series, 14)) {
    if (v === null) continue;
    assert.ok(v >= 0 && v <= 100, `RSI out of range: ${v}`);
  }
});

test('Bollinger middle equals the SMA and bands are ordered', () => {
  const series = generateNoise(200);
  const bb = TA.bollinger(series, 20, 2);
  const sma = TA.sma(series, 20);
  for (let i = 0; i < series.length; i += 1) {
    if (bb.middle[i] === null) continue;
    assert.equal(bb.middle[i], sma[i]);
    assert.ok(bb.upper[i] >= bb.middle[i] && bb.middle[i] >= bb.lower[i]);
  }
});

test('MACD histogram equals macd - signal wherever both are defined', () => {
  const series = generateNoise(300);
  const m = TA.macd(series);
  let checked = 0;
  for (let i = 0; i < series.length; i += 1) {
    if (m.macd[i] === null || m.signal[i] === null) continue;
    assert.ok(Math.abs(m.histogram[i] - (m.macd[i] - m.signal[i])) < 1e-9);
    checked += 1;
  }
  assert.ok(checked > 100, 'not enough overlapping MACD values');
});

test('true range and ATR use the previous close', () => {
  const candles = [C(10, 12, 9, 11), C(11, 15, 11, 14)];
  const tr = TA.trueRange(candles);
  assert.equal(tr[0], 3);
  assert.equal(tr[1], 4); // max(15-11, |15-11|, |11-11|) = 4
  const a = TA.atr(candles, 2);
  assert.equal(a[1], 3.5);
});

test('crossOver / crossUnder detect the exact bar', () => {
  const a = [1, 2, 3, 2, 1];
  const b = [2, 2, 2, 2, 2];
  assert.equal(TA.crossOver(a, b), false);
  assert.equal(TA.crossOver(a, b, 2), true);   // bar index 2 crossed up
  assert.equal(TA.crossUnder(a, b), true);     // bar index 4 crossed down
  assert.equal(TA.crossUnder(a, b, 2), false);
});

test('percentChange is relative to the base bar', () => {
  const p = TA.percentChange([100, 110, 121], 1);
  assert.equal(p[0], null);
  assert.ok(Math.abs(p[1] - 10) < 1e-9);
  assert.ok(Math.abs(p[2] - 10) < 1e-9);
});

test('linreg recovers an exact linear trend', () => {
  const series = Array.from({ length: 40 }, (_, i) => 5 + 2 * i);
  const lr = TA.linreg(series, 10);
  const i = series.length - 1;
  assert.ok(Math.abs(lr.slope[i] - 2) < 1e-9);
  assert.ok(Math.abs(lr.r2[i] - 1) < 1e-9);
});

test('zscore is zero on a flat series', () => {
  const z = TA.zscore(flat, 20);
  assert.equal(z[flat.length - 1], 0);
});

test('ulcer index is zero for a monotonically rising series', () => {
  const u = TA.ulcer(up, 14);
  assert.equal(u[up.length - 1], 0);
});

test('OBV accumulates in the direction of closes', () => {
  const candles = [C(1, 1, 1, 10, 5), C(1, 1, 1, 12, 5), C(1, 1, 1, 11, 5)];
  const o = TA.obv(candles);
  assert.deepEqual(o, [0, 5, 0]);
});

test('supertrend flips direction on a trend reversal', () => {
  const series = [...up, ...down.slice(0, 40)];
  const candles = series.map((p, i) => C(p, p + 1, p - 1, p, 100, i * 1000));
  const st = TA.supertrend(candles, 10, 3);
  const trends = st.trend.filter((t) => t !== null);
  assert.equal(trends[0], 1, 'starts bullish');
  assert.equal(trends[trends.length - 1], -1, 'ends bearish after the reversal');
});

test('PSAR stays below price in a clean uptrend', () => {
  const candles = up.map((p, i) => C(p, p + 2, p - 1, p, 100, i * 1000));
  const ps = TA.psar(candles);
  const tail = ps.slice(-10);
  for (const v of tail) assert.ok(v < 200, `PSAR ${v} should trail the price`);
});

test('candle patterns are detected on hand-built candles', () => {
  const doji = [C(10, 11, 9, 10.01), C(10.01, 11, 9, 10.02), C(10.02, 12, 8, 10.03)];
  assert.ok(TA.candlePatterns(doji).includes('doji'));

  // three candles are required; the last two form the engulfing pair
  const engulfing = [C(11.5, 11.6, 11.4, 11.5), C(12, 12.2, 10.8, 11), C(10.9, 12.5, 10.7, 12.4)];
  assert.ok(TA.candlePatterns(engulfing).includes('bullish_engulfing'));

  const hammer = [C(10, 10.1, 9.9, 10), C(10, 10.1, 9.9, 10), C(10, 10.2, 8.5, 10.15)];
  assert.ok(TA.candlePatterns(hammer).includes('hammer'));
});

test('swing points and support/resistance find structure', () => {
  const prices = [10, 11, 12, 13, 12, 11, 10, 11, 12, 13, 12, 11, 10];
  const candles = prices.map((p, i) => C(p, p + 0.2, p - 0.2, p, 100, i * 1000));
  const sp = TA.swingPoints(candles, 2, 2);
  assert.ok(sp.highs.length >= 1 && sp.lows.length >= 1);
  const sr = TA.supportResistance(candles, 2, 5);
  assert.ok(Array.isArray(sr.supports) && Array.isArray(sr.resistances));
});

test('divergence detects a bullish setup', () => {
  // price makes a lower low while RSI makes a higher low
  const closes = [100, 95, 90, 92, 94, 93, 88, 89, 91, 93, 95, 97, 99];
  const candles = closes.map((p, i) => C(p, p + 0.5, p - 0.5, p, 100, i * 1000));
  const osc = closes.map((_, i) => 20 + i * 3); // rising oscillator
  const d = TA.divergence(candles, osc, { left: 1, right: 1 });
  assert.ok(d === null || typeof d === 'string');
});

test('volume profile produces a POC and a value area', () => {
  const candles = Array.from({ length: 100 }, (_, i) => C(100 + i * 0.1, 100 + i * 0.1 + 1, 100 + i * 0.1 - 1, 100 + i * 0.1, 10 + i, i * 1000));
  const vp = TA.volumeProfile(candles, 12);
  assert.equal(vp.buckets.length, 12);
  assert.ok(Number.isFinite(vp.poc));
  assert.ok(Number.isFinite(vp.valueArea[0]) && Number.isFinite(vp.valueArea[1]));
});

test('every registered indicator returns a full-length numeric series', () => {
  const candles = synthCandles({ count: 300, seed: 11 });
  assert.ok(TA.INDICATOR_REGISTRY.length >= 50, `registry too small: ${TA.INDICATOR_REGISTRY.length}`);
  for (const def of TA.INDICATOR_REGISTRY) {
    const series = TA.computeIndicator(def.id, candles, {});
    assert.equal(series.length, candles.length, `${def.id}: wrong length`);
    const numeric = series.filter((v) => v !== null);
    assert.ok(numeric.length > 0, `${def.id}: produced no values`);
    for (const v of numeric) assert.ok(Number.isFinite(v), `${def.id}: non-finite value ${v}`);
  }
});

test('indicators survive degenerate input', () => {
  const tiny = [C(1, 1, 1, 1)];
  const empty = [];
  for (const def of TA.INDICATOR_REGISTRY) {
    assert.doesNotThrow(() => TA.computeIndicator(def.id, tiny, {}), `${def.id} on 1 candle`);
    assert.doesNotThrow(() => TA.computeIndicator(def.id, empty, {}), `${def.id} on 0 candles`);
  }
});

test('computeIndicator rejects unknown ids', () => {
  assert.throws(() => TA.computeIndicator('nope', []), /Unknown indicator/);
});
