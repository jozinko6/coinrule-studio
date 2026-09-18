/**
 * seed.js — bundled deterministic datasets.
 *
 * These are SIMULATED markets (see synthetic.js), not real historical prices.
 * They exist so the application is fully functional with no network access and
 * so tests have exact, reproducible inputs. The UI labels them as "simulované".
 */

import { generateCandles } from './synthetic.js';

export const SEED_DATASETS = {
  'BTCUSDT:1h': { symbol: 'BTCUSDT', timeframe: '1h', scenario: 'bull', count: 1500, startPrice: 26_000, seed: 1001 },
  'BTCUSDT:4h': { symbol: 'BTCUSDT', timeframe: '4h', scenario: 'sideways', count: 900, startPrice: 30_000, seed: 1002 },
  'BTCUSDT:1d': { symbol: 'BTCUSDT', timeframe: '1d', scenario: 'bull', count: 730, startPrice: 16_500, seed: 1003 },
  'ETHUSDT:1h': { symbol: 'ETHUSDT', timeframe: '1h', scenario: 'volatile', count: 1500, startPrice: 1_800, seed: 2001 },
  'ETHUSDT:4h': { symbol: 'ETHUSDT', timeframe: '4h', scenario: 'sideways', count: 900, startPrice: 2_400, seed: 2002 },
  'SOLUSDT:15m': { symbol: 'SOLUSDT', timeframe: '15m', scenario: 'volatile', count: 2000, startPrice: 140, seed: 3001 },
  'BNBUSDT:1h': { symbol: 'BNBUSDT', timeframe: '1h', scenario: 'calm', count: 1200, startPrice: 300, seed: 4001 },
  'XRPUSDT:1h': { symbol: 'XRPUSDT', timeframe: '1h', scenario: 'crash', count: 1000, startPrice: 0.72, seed: 5001 },
};

const cache = new Map();

/** Deterministic candle series for a symbol/timeframe (never hits the network). */
export function getSeedCandles(symbol = 'BTCUSDT', timeframe = '1h', count = null) {
  const key = `${symbol}:${timeframe}`;
  const cfg = SEED_DATASETS[key] ?? {
    symbol,
    timeframe,
    scenario: 'sideways',
    count: 1000,
    startPrice: 100,
    seed: 9000,
  };
  const cacheKey = `${key}:${count ?? cfg.count}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const candles = generateCandles({
    symbol: cfg.symbol,
    timeframe: cfg.timeframe,
    scenario: cfg.scenario,
    count: count ?? cfg.count,
    startPrice: cfg.startPrice,
    seed: cfg.seed,
  });
  cache.set(cacheKey, candles);
  return candles;
}

export const SEED_SYMBOLS = [...new Set(Object.values(SEED_DATASETS).map((d) => d.symbol))];
export const SEED_TIMEFRAMES = [...new Set(Object.values(SEED_DATASETS).map((d) => d.timeframe))];
