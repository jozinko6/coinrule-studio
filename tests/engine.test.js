import test from 'node:test';
import assert from 'node:assert/strict';
import { StrategyRuntime, PROTECTIVE_ACTIONS } from '../js/core/engine.js';
import { PaperBroker } from '../js/core/paper.js';
import { createStrategy, createRule, createGroup, createCondition } from '../js/core/rules.js';
import { generateCandles } from '../js/data/synthetic.js';

const candles = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 200, seed: 77, scenario: 'sideways' });

const always = () => ({ id: 'c-always', kind: 'condition', type: 'always' });
const mkRule = (then, extra = {}) => createRule({
  when: createGroup('AND', [always()]),
  then,
  ...extra,
});

function mkRuntime(strategies, options = {}) {
  const broker = new PaperBroker({
    symbol: 'BTCUSDT', startingCash: 10_000, takerFeePct: 0.1, slippagePct: 0,
    mode: 'backtest', idFactory: (n) => `o${n}`,
  });
  const rt = new StrategyRuntime({ strategies, broker, options });
  rt.prepare(candles);
  return { broker, rt };
}

const baseStrategy = (rules, extra = {}) => createStrategy({
  id: 'strat1', name: 'Test', symbol: 'BTCUSDT', timeframe: '1h', rules, ...extra,
});

test('prepare pre-computes every referenced indicator once', () => {
  const strategy = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 10 }], {
    when: createGroup('AND', [createCondition({
      left: { kind: 'indicator', id: 'rsi', params: { period: 14 } },
      op: 'lt', right: { kind: 'const', value: 100 },
    })]),
  })]);
  const { rt } = mkRuntime([strategy]);
  const cache = rt.cache.get('strat1');
  assert.equal(cache.size, 1);
  assert.ok(cache.has('rsi|{"period":14}'));
  assert.equal(cache.get('rsi|{"period":14}').length, candles.length);
});

test('a matching rule fires once per bar and records a signal', () => {
  const { rt } = mkRuntime([baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 10 }])])]);
  const fired = [];
  for (let i = 0; i < candles.length; i += 1) {
    rt.broker.onCandle(candles[i]);
    fired.push(...rt.onBar(candles, i));
  }
  assert.equal(fired.length, candles.length, 'an always-rule should fire on every bar');
  assert.equal(rt.signals.length, candles.length);
  assert.equal(rt.signals[0].ruleName, rt.signals[0].ruleName);
  assert.ok(rt.signals[0].text.startsWith('AK '));
});

test('cooldownBars suppresses repeated triggers', () => {
  const { rt } = mkRuntime([baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 1 }], { cooldownBars: 10 })])]);
  let count = 0;
  for (let i = 0; i < candles.length; i += 1) {
    rt.broker.onCandle(candles[i]);
    count += rt.onBar(candles, i).length;
  }
  assert.ok(count <= Math.ceil(candles.length / 10) + 1, `cooldown ignored (${count} triggers)`);
  assert.ok(count >= 2);
});

test('maxTriggers caps the rule permanently', () => {
  const { rt } = mkRuntime([baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 1 }], { maxTriggers: 3 })])]);
  let count = 0;
  for (let i = 0; i < candles.length; i += 1) {
    rt.broker.onCandle(candles[i]);
    count += rt.onBar(candles, i).length;
  }
  assert.equal(count, 3);
});

test('oneShot rules never fire twice', () => {
  const { rt } = mkRuntime([baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 1 }], { oneShot: true })])]);
  let count = 0;
  for (let i = 0; i < candles.length; i += 1) {
    rt.broker.onCandle(candles[i]);
    count += rt.onBar(candles, i).length;
  }
  assert.equal(count, 1);
});

test('disabled rules and disabled strategies are skipped', () => {
  const rule = mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 1 }], { enabled: false });
  const { rt } = mkRuntime([baseStrategy([rule])]);
  for (let i = 0; i < 20; i += 1) rt.onBar(candles, i);
  assert.equal(rt.signals.length, 0);

  const disabledStrategy = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 1 }])], { enabled: false });
  const { rt: rt2 } = mkRuntime([disabledStrategy]);
  for (let i = 0; i < 20; i += 1) rt2.onBar(candles, i);
  assert.equal(rt2.signals.length, 0);
});

test('pyramiding is blocked unless the strategy allows it', () => {
  const strategy = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 10 }])]);
  const { broker, rt } = mkRuntime([strategy]);
  for (let i = 0; i < 40; i += 1) {
    broker.onCandle(candles[i]);
    rt.onBar(candles, i);
  }
  assert.equal(broker.portfolio.openPositions.length, 1);
  const buys = [...broker.orders.values()].filter((o) => o.side === 'buy' && o.status !== 'rejected');
  assert.equal(buys.length, 1, 'only one entry should have been allowed');
});

test('allowPyramiding lets a strategy add to a position', () => {
  const strategy = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 5 }])], { allowPyramiding: true });
  const { broker, rt } = mkRuntime([strategy]);
  for (let i = 0; i < 40; i += 1) {
    broker.onCandle(candles[i]);
    rt.onBar(candles, i);
  }
  const buys = [...broker.orders.values()].filter((o) => o.side === 'buy');
  assert.ok(buys.length > 1, 'pyramiding should add to the position');
});

test('maxPositionPct caps the notional that can be bought', () => {
  const strategy = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 100 }])], {
    risk: { maxPositionPct: 20, maxOpenPositions: 1, stopLossPct: 5, takeProfitPct: 10, leverage: 1 },
  });
  const { broker, rt } = mkRuntime([strategy]);
  for (let i = 0; i < 60; i += 1) {
    broker.onCandle(candles[i]);
    rt.onBar(candles, i);
  }
  const pos = broker.portfolio.position('BTCUSDT');
  const equity = broker.portfolio.equity(broker.lastPrice);
  assert.ok(pos.qty * broker.lastPrice <= equity * 0.21, 'position exceeded the cap');
});

test('protective actions are queued and attached after the fill', () => {
  const strategy = baseStrategy([mkRule([
    { type: 'buy', sizeMode: 'percent_cash', value: 50 },
    { type: 'stop_loss', value: 25 },
    { type: 'take_profit', value: 500 },
  ])]);
  const { broker, rt } = mkRuntime([strategy]);
  broker.onCandle(candles[0]);
  rt.onBar(candles, 0);
  assert.equal(broker.portfolio.position('BTCUSDT'), null, 'entry must not fill in the signal bar');
  assert.ok(rt.pendingProtection.has('BTCUSDT'), 'protection should be queued');
  broker.onCandle(candles[1]);
  const pos = broker.portfolio.position('BTCUSDT');
  assert.ok(pos, 'the entry must fill at the next bar open');
  assert.equal(pos.protectionApplied, true, 'protection must be armed at the real fill price');
  assert.equal(rt.pendingProtection.has('BTCUSDT'), false, 'protection should have been flushed');
  const protective = [...broker.orders.values()].filter((o) => ['stop_market', 'take_profit'].includes(o.type));
  assert.equal(protective.length, 2);
  rt.onBar(candles, 1);
  assert.equal(rt.pendingProtection.has('BTCUSDT'), false, 'an already protected position must not be re-queued');
});

test('protective exits stay attributable to the rule that opened the trade', () => {
  const strategy = baseStrategy([createRule({
    id: 'entry-rule',
    name: 'Vstup s ochranou',
    when: createGroup('AND', [always()]),
    then: [
      { type: 'buy', sizeMode: 'percent_cash', value: 50 },
      { type: 'take_profit', value: 1 },
    ],
  })]);
  const { broker, rt } = mkRuntime([strategy]);
  for (let i = 0; i < 60 && broker.trades.length === 0; i += 1) {
    broker.onCandle(candles[i]);
    rt.onBar(candles, i);
  }
  assert.ok(broker.trades.length >= 1, 'the take-profit never fired');
  assert.equal(broker.trades[0].ruleId, 'entry-rule');
  assert.equal(broker.trades[0].strategyId, 'strat1');
});

test('every strategy in a multi-strategy backtest is evaluated', () => {
  const fast = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 5 }])], { timeframe: '1h' });
  fast.id = 'fast';
  const slow = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 5 }])], { timeframe: '4h' });
  slow.id = 'slow';
  const { rt } = mkRuntime([fast, slow], { allowPyramiding: true });
  for (let i = 0; i < 30; i += 1) rt.onBar(candles, i);
  const ids = new Set(rt.signals.map((s) => s.strategyId));
  assert.ok(ids.has('fast') && ids.has('slow'), 'a strategy was silently skipped by the timeframe filter');
});

test('PROTECTIVE_ACTIONS lists exactly the position-dependent actions', () => {
  assert.deepEqual([...PROTECTIVE_ACTIONS].sort(), ['break_even', 'stop_loss', 'take_profit', 'trailing_stop']);
});

test('pause and resume actions toggle the rule', () => {
  const strategy = baseStrategy([
    mkRule([{ type: 'pause' }], { id: 'pauser', oneShot: true }),
    mkRule([{ type: 'notify', message: 'hi' }], { id: 'worker' }),
  ]);
  const { rt } = mkRuntime([strategy]);
  for (let i = 0; i < 10; i += 1) rt.onBar(candles, i);
  const workerState = rt.stateFor('strat1', 'worker');
  const pauserState = rt.stateFor('strat1', 'pauser');
  assert.equal(pauserState.triggers, 1);
  assert.equal(workerState.triggers, 0, 'the worker must be paused from the first bar');
});

test('the drawdown kill switch closes every position', () => {
  const crash = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 200, seed: 4, scenario: 'crash' });
  const strategy = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 90 }])]);
  const { broker, rt } = mkRuntime([strategy], { maxDrawdownPct: 5 });
  rt.prepare(crash);
  for (let i = 0; i < crash.length; i += 1) {
    broker.onCandle(crash[i]);
    rt.onBar(crash, i);
  }
  assert.equal(rt.killed, true);
  assert.ok(rt.signals.some((s) => s.type === 'kill_switch'));
});

test('diagnose explains why a rule did or did not fire', () => {
  const strategy = baseStrategy([createRule({
    name: 'RSI check',
    when: createGroup('AND', [
      createCondition({ left: { kind: 'indicator', id: 'rsi', params: { period: 14 } }, op: 'lt', right: { kind: 'const', value: 0 } }),
      createGroup('OR', [always()]),
    ]),
    then: [{ type: 'buy', sizeMode: 'percent_cash', value: 10 }],
  })]);
  const { rt } = mkRuntime([strategy]);
  const [diag] = rt.diagnose(strategy, candles.length - 1);
  assert.equal(diag.matches, false);
  assert.equal(diag.tree.kind, 'group');
  assert.equal(diag.tree.pass, false);
  assert.equal(diag.tree.items[0].pass, false);
  assert.equal(diag.tree.items[1].pass, true);
  assert.match(diag.text, /^AK /);
});

test('dry run records signals without touching the portfolio', () => {
  const { broker, rt } = mkRuntime([baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 50 }])])], { dryRun: true });
  for (let i = 0; i < 30; i += 1) {
    broker.onCandle(candles[i]);
    rt.onBar(candles, i);
  }
  assert.ok(rt.signals.length > 0);
  assert.equal(broker.portfolio.openPositions.length, 0);
  assert.equal(broker.portfolio.cash, 10_000);
});

test('the daily loss guard blocks entries for the rest of the day', () => {
  const crash = generateCandles({ symbol: 'BTCUSDT', timeframe: '1h', count: 120, seed: 6, scenario: 'crash' });
  const strategy = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 90 }])]);
  const { broker, rt } = mkRuntime([strategy], { maxDailyLossPct: 0.5 });
  rt.prepare(crash);
  for (let i = 0; i < crash.length; i += 1) {
    broker.onCandle(crash[i]);
    rt.onBar(crash, i);
  }
  assert.ok(rt.signals.some((s) => s.type === 'guard'));
});

test('strategies for other symbols are ignored by a broker', () => {
  const other = baseStrategy([mkRule([{ type: 'buy', sizeMode: 'percent_cash', value: 10 }])]);
  other.symbol = 'ETHUSDT';
  const { rt } = mkRuntime([other]);
  for (let i = 0; i < 20; i += 1) rt.onBar(candles, i);
  assert.equal(rt.signals.length, 0);
});
