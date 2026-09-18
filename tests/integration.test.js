/**
 * integration.test.js — end-to-end flow with the real modules and no network.
 *
 * Flow under test (the app's critical path):
 *   offline market data -> strategy template -> backtest -> live virtual
 *   trading session with ticks -> trades -> persistence round-trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketData, SOURCE, sanitizeCandles } from '../js/data/market.js';
import { BinancePublic } from '../js/data/binance.js';
import { instantiate, getTemplate } from '../js/core/strategies.js';
import { backtest } from '../js/core/backtest.js';
import { LivePaperEngine } from '../js/core/session.js';
import { Store, MemoryStorage } from '../js/store/store.js';
import { createStrategy, createRule, createGroup, validateStrategy, strategyFromJSON, strategyToJSON } from '../js/core/rules.js';
import { tradeStats } from '../js/core/metrics.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

test('offline market data loads without touching the network', async () => {
  const market = new MarketData({ source: SOURCE.SYNTHETIC, client: new BinancePublic({ fetchImpl: async () => { throw new Error('network must not be used'); } }) });
  const res = await market.loadCandles({ symbol: 'BTCUSDT', timeframe: '1h', limit: 400 });
  assert.equal(res.source, SOURCE.SYNTHETIC);
  assert.equal(res.degraded, true);
  assert.equal(res.candles.length, 400);
  const clean = sanitizeCandles(res.candles);
  assert.equal(clean.length, 400);
  for (let i = 1; i < clean.length; i += 1) assert.ok(clean[i].time > clean[i - 1].time);
});

test('auto mode falls back to the simulator when Binance is unreachable', async () => {
  const market = new MarketData({
    source: SOURCE.AUTO,
    client: new BinancePublic({ fetchImpl: async () => { throw new Error('offline'); }, maxRetries: 0 }),
  });
  const res = await market.loadCandles({ symbol: 'ETHUSDT', timeframe: '1h', limit: 250 });
  assert.equal(res.source, SOURCE.SYNTHETIC);
  assert.equal(res.degraded, true);
  assert.match(res.message, /Simulované/);
  assert.equal(res.candles.length, 250);
});

test('a template can be instantiated, validated, backtested and persisted', () => {
  const candles = sanitizeCandles(new MarketData({ source: SOURCE.SYNTHETIC }).synthetic({ symbol: 'BTCUSDT', timeframe: '1h', limit: 600 }).candles);

  const strategy = instantiate('ema-cross', { symbol: 'BTCUSDT', timeframe: '1h' });
  assert.equal(validateStrategy(strategy).ok, true);

  const res = backtest({ strategy, candles, startingCash: 10_000, feePct: 0.1, slippagePct: 0.05 });
  assert.ok(res.metrics.bars > 400);
  assert.ok(Number.isFinite(res.metrics.totalReturnPct));
  assert.ok(res.trades.length > 0, 'the EMA cross template should trade on this data');

  // every trade must be internally consistent
  for (const t of res.trades) {
    assert.ok(t.qty > 0);
    assert.ok(t.exitPrice > 0 && t.entryPrice > 0);
    // pnlPct is the NET return on the position cost basis, and pnl is net of both fee legs
    approx(t.pnlPct, (t.netPnl / (t.entryPrice * t.qty)) * 100, 1e-3);
    approx(t.pnl, t.grossPnl - t.totalFees, 1e-6);
    approx(t.totalFees, t.entryFee + t.exitFee, 1e-9);
  }

  // persistence round-trip through the store
  const storage = new MemoryStorage();
  const store = new Store({ storage });
  store.load();
  store.upsertStrategy(strategy);
  store.save();
  const reloaded = new Store({ storage });
  reloaded.load();
  const back = reloaded.getStrategy(strategy.id);
  assert.equal(back.name, strategy.name);
  assert.equal(back.rules.length, strategy.rules.length);
  const reparsed = strategyFromJSON(strategyToJSON(back));
  assert.equal(validateStrategy(reparsed).ok, true);
});

test('the same strategy produces the same backtest twice (determinism)', () => {
  const candles = sanitizeCandles(new MarketData({ source: SOURCE.SYNTHETIC }).synthetic({ symbol: 'ETHUSDT', timeframe: '4h', limit: 500 }).candles);
  const strategy = getTemplate('rsi-oversold');
  const a = backtest({ strategy, candles });
  const b = backtest({ strategy, candles });
  assert.deepEqual(a.metrics, b.metrics);
  assert.deepEqual(a.trades.map((t) => [t.qty, t.entryPrice, t.exitPrice, t.pnl]), b.trades.map((t) => [t.qty, t.entryPrice, t.exitPrice, t.pnl]));
});

test('a live virtual session trades on a tick stream and keeps a ledger', () => {
  const candles = sanitizeCandles(new MarketData({ source: SOURCE.SYNTHETIC }).synthetic({ symbol: 'BTCUSDT', timeframe: '1h', limit: 300 }).candles);

  // Buy 50 % of cash, exit at +1 %, so a rising market produces round trips.
  const strategy = createStrategy({
    name: 'Integration scalper',
    symbol: 'BTCUSDT',
    timeframe: '1m',
    rules: [
      createRule({
        id: 'r-buy',
        name: 'Vstup',
        when: createGroup('AND', [{ id: 'c1', kind: 'condition', type: 'always' }]),
        then: [{ type: 'buy', sizeMode: 'percent_cash', value: 50 }],
      }),
      createRule({
        id: 'r-exit',
        name: 'Výstup +1 %',
        when: createGroup('AND', [{ id: 'c2', kind: 'condition', type: 'position', state: 'profit_pct', value: 1 }]),
        then: [{ type: 'close_position' }],
      }),
    ],
  });

  const engine = new LivePaperEngine({
    symbol: 'BTCUSDT',
    timeframe: '1m',
    startingCash: 10_000,
    feePct: 0.1,
    slippagePct: 0,
    strategies: [strategy],
  });
  engine.loadHistory(candles.slice(-200));
  assert.equal(engine.equityCurve.length, 1);

  let price = candles.at(-1).close;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 600; i += 1) {
    price *= 1.004; // steady climb -> repeated entries and +1 % exits
    engine.onTick({ time: start + i * 60_000, price, high: price, low: price * 0.999, close: price, volume: 100 });
  }
  engine.flush();

  const snap = engine.snapshot();
  assert.ok(snap.ticks === 600);
  assert.ok(snap.bars > 400, `expected many bars, got ${snap.bars}`);
  assert.ok(engine.broker.trades.length >= 2, `expected round trips, got ${engine.broker.trades.length}`);
  assert.ok(snap.equity > 0);
  assert.ok(Number.isFinite(snap.returnPct));
  assert.ok(engine.equityCurve.length > 100);
  assert.ok(snap.feesPaid > 0, 'fees must be charged');

  const stats = tradeStats(engine.broker.trades);
  assert.equal(stats.trades, engine.broker.trades.length);
  for (const t of engine.broker.trades) assert.ok(t.closedAt >= t.openedAt);

  // the session is serialisable (used by the "export session" button)
  const json = JSON.parse(JSON.stringify(engine.toJSON()));
  assert.equal(json.symbol, 'BTCUSDT');
  assert.ok(json.trades.length >= 1);
  assert.ok(json.equityCurve.length >= 1);

  // manual close leaves no open position
  const closed = engine.closeAll('test');
  assert.equal(closed.length, 0, 'nothing should be open after the last exit');
  assert.equal(engine.portfolio.openPositions.length, 0);
});

test('the kill switch closes everything when the market collapses', () => {
  const candles = sanitizeCandles(new MarketData({ source: SOURCE.SYNTHETIC }).synthetic({ symbol: 'BTCUSDT', timeframe: '1h', limit: 300 }).candles);
  const strategy = createStrategy({
    name: 'Always in',
    symbol: 'BTCUSDT',
    timeframe: '1m',
    rules: [createRule({
      when: createGroup('AND', [{ id: 'c', kind: 'condition', type: 'always' }]),
      then: [{ type: 'buy', sizeMode: 'percent_cash', value: 80 }],
    })],
  });
  const engine = new LivePaperEngine({
    symbol: 'BTCUSDT',
    timeframe: '1m',
    strategies: [strategy],
    options: { maxDrawdownPct: 3 },
  });
  engine.loadHistory(candles.slice(-200));

  let price = candles.at(-1).close;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 400; i += 1) {
    price *= 0.985;
    engine.onTick({ time: start + i * 60_000, price, volume: 100 });
  }
  engine.flush();
  assert.equal(engine.runtime.killed, true);
  assert.equal(engine.portfolio.openPositions.length, 0);
  assert.ok(engine.runtime.signals.some((s) => s.type === 'kill_switch'));
});
