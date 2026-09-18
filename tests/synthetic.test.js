import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCandles, createTickSimulator, mulberry32, hashSeed, SCENARIOS } from '../js/data/synthetic.js';
import { getSeedCandles, SEED_DATASETS, SEED_SYMBOLS } from '../js/data/seed.js';
import { sanitizeCandles } from '../js/data/market.js';

test('mulberry32 is deterministic and stays in [0,1)', () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  for (let i = 0; i < 50; i += 1) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('hashSeed is stable across runs', () => {
  assert.equal(hashSeed('BTCUSDT|1h'), hashSeed('BTCUSDT|1h'));
  assert.notEqual(hashSeed('BTCUSDT'), hashSeed('ETHUSDT'));
});

test('generated candles are identical for the same seed', () => {
  const a = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 100, seed: 7 });
  const b = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 100, seed: 7 });
  assert.deepEqual(a, b);
  const c = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 100, seed: 8 });
  assert.notDeepEqual(a, c);
});

test('generated candles are internally consistent', () => {
  for (const scenario of Object.keys(SCENARIOS)) {
    const candles = generateCandles({ count: 200, scenario, seed: 3 });
    assert.equal(candles.length, 200);
    for (const c of candles) {
      assert.ok(c.high >= c.low, 'high must be >= low');
      assert.ok(c.high >= Math.max(c.open, c.close) - 1e-9, 'high must cover the body');
      assert.ok(c.low <= Math.min(c.open, c.close) + 1e-9, 'low must cover the body');
      assert.ok(c.close > 0 && c.volume > 0);
    }
    for (let i = 1; i < candles.length; i += 1) {
      assert.ok(candles[i].time > candles[i - 1].time, 'time must increase');
    }
  }
});

test('a bull scenario trends up and a crash scenario trends down', () => {
  // A single random walk is noisy, so average the growth factor over 12 seeds.
  const avgGrowth = (scenario) => {
    let acc = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const c = generateCandles({ count: 1200, scenario, seed, startPrice: 100 });
      acc += c.at(-1).close / c[0].close;
    }
    return acc / 12;
  };
  const bull = avgGrowth('bull');
  const crash = avgGrowth('crash');
  assert.ok(bull > 1.1, `bull average growth ${bull.toFixed(3)} should be well above 1`);
  assert.ok(crash < 0.9, `crash average growth ${crash.toFixed(3)} should be well below 1`);
  assert.ok(bull > crash, 'bull must outperform crash');
});

test('the tick simulator is deterministic per seed', () => {
  const a = createTickSimulator({ symbol: 'BTCUSDT', seed: 1 });
  const b = createTickSimulator({ symbol: 'BTCUSDT', seed: 1 });
  for (let i = 0; i < 20; i += 1) assert.equal(a.next().price, b.next().price);
});

test('seed datasets are stable and correctly shaped', () => {
  assert.ok(SEED_SYMBOLS.length >= 3);
  for (const [key, cfg] of Object.entries(SEED_DATASETS)) {
    const candles = getSeedCandles(cfg.symbol, cfg.timeframe);
    assert.equal(candles.length, cfg.count, `${key}: wrong count`);
    assert.equal(candles, getSeedCandles(cfg.symbol, cfg.timeframe), 'must be cached');
    assert.equal(candles[0].time % 1000, 0);
  }
});

test('unknown symbols still produce a usable dataset', () => {
  const candles = getSeedCandles('WEIRDUSDT', '2h');
  assert.ok(candles.length > 100);
  assert.ok(candles.every((c) => c.close > 0));
});

test('sanitizeCandles sorts, dedupes and drops invalid rows', () => {
  const dirty = [
    { time: 2000, open: 2, high: 3, low: 1, close: 2, volume: 10 },
    { time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5 },
    { time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5 },
    { time: 3000, open: 0, high: 0, low: 0, close: 0, volume: 0 },
    { time: 'nope', open: 1, high: 1, low: 1, close: 1, volume: 1 },
  ];
  const clean = sanitizeCandles(dirty);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].time, 1000);
  assert.equal(clean[1].time, 2000);
});

test('unknown pairs get deterministic, symbol-specific simulated series', () => {
  const a1 = getSeedCandles('NEWCOINUSDT', '1h');
  const a2 = getSeedCandles('NEWCOINUSDT', '1h');
  const b = getSeedCandles('OTHERCOINUSDT', '1h');
  assert.deepEqual(a1, a2, 'same symbol must be deterministic');
  assert.notDeepEqual(a1.map((c) => c.close), b.map((c) => c.close), 'different symbols must differ');

  const avgRange = (candles) => candles.slice(-200)
    .reduce((acc, c) => acc + (c.high - c.low) / c.close, 0) / 200;
  const volatileSeries = getSeedCandles('PEPEUSDT', '1h');
  const stableSeries = getSeedCandles('NEWCOINUSDT', '1h');
  assert.ok(avgRange(volatileSeries) > avgRange(stableSeries),
    'volatile universe members should have wider ranges than an unknown pair');
});
