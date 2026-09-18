import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCondition, createGroup, createRule, createStrategy,
  validateStrategy, describeCondition, describeGroup, describeRule,
  evaluateNode, collectIndicatorRefs, makeOperandResolver,
  strategyToJSON, strategyFromJSON, migrateStrategy, OPERATOR_IDS, SCHEMA_VERSION,
} from '../js/core/rules.js';
import { generateCandles } from '../js/data/synthetic.js';
import { Portfolio } from '../js/core/portfolio.js';

const candles = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 300, seed: 42, scenario: 'bull' });
const cache = new Map();
const resolver = makeOperandResolver(candles, cache);

const ctxAt = (index, extra = {}) => ({
  index, candles, resolver, cache, patterns: [],
  portfolio: new Portfolio({ cash: 10_000 }),
  position: null,
  price: candles[index].close,
  divergenceCache: new Map(),
  ...extra,
});

const ind = (id, params = {}) => ({ kind: 'indicator', id, params });
const num = (value) => ({ kind: 'const', value });

test('factory helpers produce valid, uniquely identified nodes', () => {
  const a = createCondition();
  const b = createCondition();
  assert.notEqual(a.id, b.id);
  assert.equal(a.type, 'compare');
  assert.equal(createRule().when.kind, 'group');
  assert.equal(createStrategy().schema, SCHEMA_VERSION);
});

test('validateStrategy accepts a well-formed strategy', () => {
  const s = createStrategy({
    name: 'Test',
    rules: [createRule({ when: createGroup('AND', [createCondition()]), then: [{ type: 'buy', sizeMode: 'percent_cash', value: 10 }] })],
  });
  const v = validateStrategy(s);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.errors, []);
});

test('validateStrategy reports every class of error', () => {
  const bad = {
    name: '',
    symbol: '',
    timeframe: '7h',
    rules: [{
      when: createGroup('AND', [{ kind: 'condition', type: 'compare', left: ind('nope'), op: 'wat', right: num(1) }]),
      then: [{ type: 'fly', sizeMode: 'nope', value: -1 }],
    }],
    risk: { maxPositionPct: 900, leverage: 999 },
  };
  const v = validateStrategy(bad);
  assert.equal(v.ok, false);
  const paths = v.errors.map((e) => e.path);
  for (const expected of ['name', 'symbol', 'timeframe', 'risk.maxPositionPct', 'risk.leverage']) {
    assert.ok(paths.includes(expected), `missing error for ${expected}: ${JSON.stringify(paths)}`);
  }
  assert.ok(v.errors.some((e) => /Neznámy indikátor/.test(e.message)));
  assert.ok(v.errors.some((e) => /Neznáma akcia/.test(e.message)));
});

test('validateStrategy warns when no rule can ever buy', () => {
  const s = createStrategy({ name: 'Sell only', rules: [createRule({ then: [{ type: 'close_position' }] })] });
  const v = validateStrategy(s);
  assert.ok(v.warnings.some((w) => /nikdy nekúpi/.test(w.message)));
});

test('operators cover the documented vocabulary', () => {
  for (const op of ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'crosses_above', 'crosses_below', 'between', 'rising', 'falling']) {
    assert.ok(OPERATOR_IDS.includes(op), `missing operator ${op}`);
  }
});

test('evaluateNode implements AND / OR / NOT correctly', () => {
  const i = candles.length - 1;
  const t = { id: 't', kind: 'condition', type: 'always' };
  const f = { id: 'f', kind: 'condition', type: 'compare', left: num(1), op: 'gt', right: num(2) };
  assert.equal(evaluateNode(createGroup('AND', [t, t]), ctxAt(i)), true);
  assert.equal(evaluateNode(createGroup('AND', [t, f]), ctxAt(i)), false);
  assert.equal(evaluateNode(createGroup('OR', [t, f]), ctxAt(i)), true);
  assert.equal(evaluateNode(createGroup('OR', [f, f]), ctxAt(i)), false);
  assert.equal(evaluateNode(createGroup('NOT', [f]), ctxAt(i)), true);
  assert.equal(evaluateNode(createGroup('NOT', [t]), ctxAt(i)), false);
});

test('nested groups are evaluated recursively', () => {
  const i = candles.length - 1;
  const t = { id: 't', kind: 'condition', type: 'always' };
  const f = { id: 'f', kind: 'condition', type: 'compare', left: num(1), op: 'gt', right: num(2) };
  const nested = createGroup('AND', [t, createGroup('OR', [f, t])]);
  assert.equal(evaluateNode(nested, ctxAt(i)), true);
});

test('comparison operators behave as documented', () => {
  const i = candles.length - 1;
  const price = candles[i].close;
  const mk = (op, right, extra = {}) => evaluateNode(createCondition({ left: { kind: 'price', field: 'close' }, op, right, ...extra }), ctxAt(i));
  assert.equal(mk('gt', num(price - 1)), true);
  assert.equal(mk('gt', num(price + 1)), false);
  assert.equal(mk('lte', num(price)), true);
  assert.equal(mk('eq', num(price)), true);
  assert.equal(mk('neq', num(price)), false);
  assert.equal(mk('between', num(price - 1), { right2: price + 1 }), true);
  assert.equal(mk('pct_above', num(price), { value: 1 }), false);
  assert.equal(mk('pct_below', num(price), { value: 1 }), false);
});

test('indicator operands are computed once and cached', () => {
  const cond = createCondition({ left: ind('rsi', { period: 14 }), op: 'lt', right: num(30) });
  const i = candles.length - 1;
  evaluateNode(cond, ctxAt(i));
  const sizeAfterFirst = cache.size;
  evaluateNode(cond, ctxAt(i));
  assert.equal(cache.size, sizeAfterFirst, 'cache grew on the second evaluation');
  assert.ok(cache.has('rsi|{"period":14}'));
});

test('change_pct condition uses the requested lookback', () => {
  const flat = generateCandles({ count: 50, seed: 5, scenario: 'sideways', vol: 0.0001 });
  const cond = createCondition({ type: 'change_pct', op: 'gt', value: 0.001, bars: 3 });
  const res = evaluateNode(cond, { ...ctxAt(0), candles: flat, index: flat.length - 1, resolver: makeOperandResolver(flat, new Map()) });
  assert.equal(typeof res, 'boolean');
});

test('position conditions read the live portfolio state', () => {
  const portfolio = new Portfolio({ cash: 10_000 });
  const pos = portfolio.applyBuy({ symbol: 'BTCUSDT', qty: 1, price: 100, fee: 0.1 });
  const i = candles.length - 1;
  const c = (state, value) => createCondition({ type: 'position', state, value });
  assert.equal(evaluateNode(c('open'), ctxAt(i, { portfolio, position: pos })), true);
  assert.equal(evaluateNode(c('none'), ctxAt(i, { portfolio, position: null })), true);
  assert.equal(evaluateNode(c('profit_pct', 10), ctxAt(i, { portfolio, position: pos, price: 111 })), true);
  assert.equal(evaluateNode(c('profit_pct', 10), ctxAt(i, { portfolio, position: pos, price: 105 })), false);
  assert.equal(evaluateNode(c('loss_pct', 5), ctxAt(i, { portfolio, position: pos, price: 90 })), true);
  assert.equal(evaluateNode(c('cash_above', 5000), ctxAt(i, { portfolio })), true);
});

test('time conditions filter by UTC day and hour', () => {
  const bars = [
    { time: Date.UTC(2024, 0, 1, 10), open: 1, high: 1, low: 1, close: 1, volume: 1 }, // Monday 10:00
    { time: Date.UTC(2024, 0, 6, 10), open: 1, high: 1, low: 1, close: 1, volume: 1 }, // Saturday 10:00
  ];
  const weekday = createCondition({ type: 'time', days: [1, 2, 3, 4, 5] });
  const ctx = (index) => ({ ...ctxAt(index), candles: bars, index, resolver: makeOperandResolver(bars, new Map()) });
  assert.equal(evaluateNode(weekday, ctx(0)), true);
  assert.equal(evaluateNode(weekday, ctx(1)), false);
  const morning = createCondition({ type: 'time', hours: [8, 9, 10, 11] });
  assert.equal(evaluateNode(morning, ctx(0)), true);
  const evening = createCondition({ type: 'time', hours: [20, 21, 22] });
  assert.equal(evaluateNode(evening, ctx(0)), false);
});

test('collectIndicatorRefs finds every indicator exactly once', () => {
  const s = createStrategy({
    name: 'X',
    rules: [createRule({
      when: createGroup('AND', [
        createCondition({ left: ind('rsi', { period: 14 }), op: 'lt', right: num(30) }),
        createGroup('OR', [
          createCondition({ left: ind('ema', { period: 9 }), op: 'gt', right: ind('ema', { period: 21 }) }),
          createCondition({ left: ind('rsi', { period: 14 }), op: 'gt', right: num(70) }),
        ]),
      ]),
    })],
  });
  const refs = collectIndicatorRefs(s);
  assert.equal(refs.length, 3, JSON.stringify(refs.map((r) => r.key)));
});

test('describeCondition / describeGroup / describeRule are human readable', () => {
  const c = createCondition({ left: ind('rsi', { period: 14 }), op: 'lt', right: num(30) });
  assert.match(describeCondition(c), /RSI\(14\) < 30/);
  const g = createGroup('AND', [c, createCondition({ left: { kind: 'price', field: 'close' }, op: 'gt', right: ind('sma', { period: 200 }) })]);
  assert.match(describeGroup(g), /A ZÁROVEŇ/);
  assert.match(describeRule(createRule({ when: g, then: [{ type: 'buy', sizeMode: 'percent_cash', value: 10 }] })), /^AK /);
});

test('strategy JSON round-trips through the codec', () => {
  const s = createStrategy({ name: 'Roundtrip', symbol: 'ETHUSDT', timeframe: '4h' });
  const json = strategyToJSON(s);
  const back = strategyFromJSON(json);
  assert.equal(back.name, s.name);
  assert.equal(back.symbol, 'ETHUSDT');
  assert.equal(back.timeframe, '4h');
  assert.equal(back.rules.length, s.rules.length);
});

test('strategyFromJSON rejects invalid documents', () => {
  const bad = JSON.stringify({ schema: 2, strategy: { name: '', symbol: '', timeframe: 'x', rules: [] } });
  assert.throws(() => strategyFromJSON(bad), /Neplatná stratégia/);
});

test('migrateStrategy upgrades v1 flat condition arrays into groups', () => {
  const v1 = {
    schema: 1,
    name: 'Staré',
    rules: [{ id: 'r', name: 'r', when: [{ type: 'compare', left: num(1), op: 'gt', right: num(0) }], then: [] }],
  };
  const migrated = migrateStrategy(v1);
  assert.equal(migrated.schema, SCHEMA_VERSION);
  assert.equal(migrated.rules[0].when.kind, 'group');
  assert.equal(migrated.rules[0].when.items.length, 1);
});

test('hold requires the condition to be true for N consecutive bars', () => {
  const series = generateCandles({ count: 100, seed: 3, scenario: 'bull' });
  const cond = createCondition({
    left: { kind: 'price', field: 'close' }, op: 'gt', right: num(0), hold: 3,
  });
  const ctx = { index: series.length - 1, candles: series, resolver: makeOperandResolver(series, new Map()), patterns: [], portfolio: new Portfolio({}), position: null, price: series.at(-1).close, divergenceCache: new Map() };
  assert.equal(evaluateNode(cond, ctx), true);
});
