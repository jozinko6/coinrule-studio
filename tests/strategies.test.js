import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_LIBRARY, STRATEGY_FAMILIES, STRATEGY_COUNT,
  getTemplate, templatesByFamily, searchTemplates, instantiate,
} from '../js/core/strategies.js';
import { validateStrategy, collectIndicatorRefs, INDICATOR_REGISTRY, TIMEFRAMES } from '../js/core/rules.js';
import { INDICATOR_IDS } from '../js/core/indicators.js';
import { ACTION_TYPES } from '../js/core/rules.js';
import { backtest } from '../js/core/backtest.js';
import { generateCandles } from '../js/data/synthetic.js';

const VALID_ACTIONS = new Set(ACTION_TYPES.map((a) => a.id));

test('the library is large and covers every family', () => {
  assert.ok(STRATEGY_COUNT >= 50, `expected >= 50 strategies, found ${STRATEGY_COUNT}`);
  for (const fam of STRATEGY_FAMILIES) {
    const items = templatesByFamily(fam.id);
    assert.ok(items.length >= 2, `family "${fam.id}" has only ${items.length} strategies`);
  }
});

test('every template has a unique id and complete metadata', () => {
  const ids = new Set();
  for (const s of STRATEGY_LIBRARY) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.name && s.name.length > 3, `${s.id}: weak name`);
    assert.ok(s.description && s.description.length > 30, `${s.id}: description too short`);
    assert.ok(Array.isArray(s.tags) && s.tags.length >= 1, `${s.id}: tags missing`);
    assert.ok(STRATEGY_FAMILIES.some((f) => f.id === s.family), `${s.id}: unknown family ${s.family}`);
    assert.ok(TIMEFRAMES.includes(s.timeframe), `${s.id}: bad timeframe ${s.timeframe}`);
    assert.ok(s.riskLevel >= 1 && s.riskLevel <= 5, `${s.id}: riskLevel out of range`);
  }
});

test('every template passes validation', () => {
  for (const s of STRATEGY_LIBRARY) {
    const v = validateStrategy(s);
    assert.equal(v.ok, true, `${s.id}: ${JSON.stringify(v.errors)}`);
  }
});

test('every template only uses registered indicators', () => {
  for (const s of STRATEGY_LIBRARY) {
    for (const ref of collectIndicatorRefs(s)) {
      assert.ok(INDICATOR_IDS.includes(ref.id), `${s.id}: unknown indicator "${ref.id}"`);
    }
  }
});

test('every template only uses known actions', () => {
  for (const s of STRATEGY_LIBRARY) {
    for (const rule of s.rules) {
      for (const action of rule.then) {
        assert.ok(VALID_ACTIONS.has(action.type), `${s.id}: unknown action "${action.type}"`);
      }
    }
  }
});

test('every template has at least one entry rule and one exit rule', () => {
  let accumulationOnly = 0;
  for (const s of STRATEGY_LIBRARY) {
    const actions = s.rules.flatMap((r) => r.then.map((a) => a.type));
    assert.ok(actions.includes('buy') || actions.includes('dca'), `${s.id}: never buys`);
    const hasExit = actions.some((a) => ['sell', 'close_position'].includes(a))
      || actions.some((a) => ['stop_loss', 'take_profit', 'trailing_stop'].includes(a));
    if (s.accumulation) { accumulationOnly += 1; continue; }
    assert.ok(hasExit, `${s.id}: never exits`);
  }
  assert.ok(accumulationOnly >= 1 && accumulationOnly <= 5, `unexpected number of accumulation-only strategies: ${accumulationOnly}`);
});

test('rule ids are unique across the whole library', () => {
  const ids = new Set();
  for (const s of STRATEGY_LIBRARY) {
    for (const r of s.rules) {
      assert.ok(!ids.has(r.id), `duplicate rule id ${r.id}`);
      ids.add(r.id);
    }
  }
});

test('every template runs through the backtester without throwing', () => {
  // 900 bars so that even long-lookback templates (percent_rank 365) get a curve.
  const candles = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 900, seed: 2024, scenario: 'bull' });
  const failures = [];
  for (const s of STRATEGY_LIBRARY) {
    try {
      const res = backtest({ strategy: s, candles, startingCash: 10_000, feePct: 0.1, slippagePct: 0.05 });
      assert.ok(res.metrics && Number.isFinite(res.metrics.totalReturnPct), `${s.id}: no metrics`);
      assert.ok(res.equityCurve.length > 100, `${s.id}: short equity curve`);
      for (const point of res.equityCurve) {
        assert.ok(Number.isFinite(point.equity), `${s.id}: non-finite equity`);
        assert.ok(point.equity >= -1, `${s.id}: equity went negative (${point.equity})`);
      }
    } catch (err) {
      failures.push(`${s.id}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('the backtester produces trades for at least half of the library on trending data', () => {
  const candles = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 900, seed: 99, scenario: 'bull' });
  const withTrades = STRATEGY_LIBRARY.filter((s) => {
    try {
      const res = backtest({ strategy: s, candles, startingCash: 10_000 });
      return res.trades.length > 0;
    } catch { return false; }
  });
  assert.ok(withTrades.length >= STRATEGY_LIBRARY.length * 0.5,
    `only ${withTrades.length}/${STRATEGY_LIBRARY.length} strategies traded`);
});

test('templates are returned as deep copies', () => {
  const a = getTemplate('rsi-oversold');
  const b = getTemplate('rsi-oversold');
  assert.notEqual(a, b);
  a.rules[0].name = 'zmenené';
  assert.notEqual(getTemplate('rsi-oversold').rules[0].name, 'zmenené');
});

test('getTemplate returns null for unknown ids', () => {
  assert.equal(getTemplate('does-not-exist'), null);
});

test('searchTemplates matches name, description, tag and family', () => {
  assert.ok(searchTemplates('rsi').length >= 5);
  assert.ok(searchTemplates('grid').length >= 3);
  assert.ok(searchTemplates('mean-reversion').length >= 5);
  assert.ok(searchTemplates('').length === STRATEGY_COUNT);
  assert.equal(searchTemplates('zzzzz').length, 0);
});

test('instantiate produces an independent, editable strategy', () => {
  const s = instantiate('dca-weekly', { symbol: 'ETHUSDT', timeframe: '4h' });
  assert.equal(s.symbol, 'ETHUSDT');
  assert.equal(s.timeframe, '4h');
  assert.notEqual(s.id, 'dca-weekly');
  s.rules[0].name = 'upravené';
  assert.notEqual(getTemplate('dca-weekly').rules[0].name, 'upravené');
  assert.throws(() => instantiate('nope'), /Neznáma šablóna/);
});

test('the indicator registry exposes at least 50 entries with metadata', () => {
  assert.ok(INDICATOR_REGISTRY.length >= 50);
  for (const def of INDICATOR_REGISTRY) {
    assert.ok(def.id && def.label && def.group, `bad registry entry ${JSON.stringify(def.id)}`);
    assert.equal(typeof def.fn, 'function');
    for (const p of def.params) assert.ok(p.key && typeof p.def === 'number');
  }
});
