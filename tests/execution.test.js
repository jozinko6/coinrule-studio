/**
 * execution.test.js — correctness regressions for the trading engine.
 *
 * These tests describe the REQUIRED behaviour of the broker/backtester:
 *   T1 protective orders arm at the real entry fill and can trigger in that bar
 *   T2 a gap that shrinks a fill recomputes qty, notional and fee (cash >= 0)
 *   T3 trade PnL is net of allocated entry fees + exit fees, incl. partial exits
 *   T4 partial OCO legs stay quantity-synchronised and never oversell
 *   T5 all executions in one bar share the participation liquidity budget
 *   T6 the intrabar execution model decides whether a trailing stop may use the
 *      current bar's high before the low
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker, ORDER_STATUS } from '../js/core/paper.js';
import { Portfolio } from '../js/core/portfolio.js';
import { backtest } from '../js/core/backtest.js';
import { createStrategy, createRule, createGroup, createCondition, uid } from '../js/core/rules.js';

const candle = (time, open, high, low, close, volume = 1_000_000) => ({ time, open, high, low, close, volume });

function alwaysRule(then) {
  return createRule({
    id: uid('rule'),
    name: 'always',
    when: createGroup('AND', [createCondition({ type: 'always', id: uid('cond') })]),
    then,
  });
}

function makeBroker({ cash = 10_000, symbol = 'TESTUSDT', participationRate = 1, mode = 'backtest' } = {}) {
  const portfolio = new Portfolio({ cash, feePct: 0.1, startingCash: cash });
  return new PaperBroker({
    symbol,
    startingCash: cash,
    takerFeePct: 0.1,
    makerFeePct: 0.1,
    slippagePct: 0,
    participationRate,
    mode,
    portfolio,
  });
}

/* ------------------------------------------------------------------------ T1 */

test('T1 protective orders arm at the real entry fill and may trigger in that same bar', () => {
  const strategy = createStrategy({
    id: 't1-protection',
    name: 'T1 protection',
    symbol: 'TESTUSDT',
    timeframe: '1h',
    rules: [alwaysRule([
      { type: 'buy', sizeMode: 'percent_cash', value: 50 },
      { type: 'stop_loss', value: 5 },
    ])],
    risk: { maxPositionPct: 100, maxOpenPositions: 1 },
  });

  const bars = [];
  let t = 1_600_000_000_000;
  for (let i = 0; i < 10; i += 1) {
    bars.push(candle(t, 100, 100.4, 99.6, 100, 1_000_000));
    t += 3_600_000;
  }
  // entry signal bar: closes at 100 -> the market buy fills at the next open
  bars.push(candle(t, 100, 100.2, 99.8, 100, 1_000_000));
  t += 3_600_000;
  // the crash bar: open 100, low 85, high 112, close 110
  bars.push(candle(t, 100, 112, 85, 110, 1_000_000));

  const res = backtest({ strategy, candles: bars, startingCash: 10_000, feePct: 0, slippagePct: 0 });

  assert.equal(res.trades.length, 1, 'the protective stop must produce exactly one trade');
  const trade = res.trades[0];
  assert.equal(trade.reason, 'stop_loss');
  assert.ok(trade.exitPrice <= 95.000001, `stop should fill near 95, got ${trade.exitPrice}`);
  assert.ok(trade.netPnl < 0, 'a stopped trade must be a loss');
  assert.equal(res.finalPosition, null, 'the strategy must not survive the crash bar');
});

test('T1b protective orders never arm from a fill the strategy did not get', () => {
  const strategy = createStrategy({
    id: 't1b-no-entry',
    name: 'T1b no entry',
    symbol: 'TESTUSDT',
    timeframe: '1h',
    rules: [createRule({
      id: uid('rule'),
      name: 'never',
      when: createGroup('AND', [createCondition({
        id: uid('cond'),
        type: 'compare',
        left: { kind: 'const', value: 1 },
        op: 'gt',
        right: { kind: 'const', value: 2 },
      })]),
      then: [{ type: 'buy', sizeMode: 'percent_cash', value: 50 }, { type: 'stop_loss', value: 5 }],
    })],
    risk: { maxPositionPct: 100, maxOpenPositions: 1 },
  });
  const bars = Array.from({ length: 20 }, (_, i) => candle(1_600_000_000_000 + i * 3_600_000, 100, 112, 85, 110));
  const res = backtest({ strategy, candles: bars, startingCash: 10_000, feePct: 0, slippagePct: 0 });
  assert.equal(res.trades.length, 0);
  assert.equal(res.orders.length, 0);
});

/* ------------------------------------------------------------------------ T2 */

test('T2 a gap-up that shrinks a fill recomputes the fee and never drives cash negative', () => {
  const broker = makeBroker({ cash: 100, participationRate: 1 });
  broker.setPrice(10, 0);
  const order = broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 9.99 });
  assert.equal(broker.openOrders.length, 1, 'the order must rest until the next bar open');

  broker.onCandle(candle(3_600_000, 12, 12.5, 11.8, 12));

  assert.ok(broker.cash() >= 0, `cash went negative: ${broker.cash()}`);
  assert.ok(order.filledQty > 0 && order.filledQty < 9.99, 'the fill must be downsized');
  const expectedFee = order.filledQty * order.avgFillPrice * 0.001;
  assert.ok(Math.abs(order.fee - expectedFee) < 1e-6, `fee ${order.fee} must match the final notional ${expectedFee}`);
  const spent = order.filledQty * order.avgFillPrice + order.fee;
  assert.ok(spent <= 100 + 1e-6, `cannot spend more than the cash available, spent ${spent}`);
});

/* ------------------------------------------------------------------------ T3 */

test('T3 trade PnL is net of allocated entry and exit fees, including partial exits', () => {
  const broker = makeBroker({ cash: 10_000, mode: 'live' });
  broker.setPrice(100, 0);
  broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 10 });
  assert.equal(broker.position().qty, 10);

  broker.setPrice(110, 3_600_000);
  broker.submit({ symbol: 'TESTUSDT', side: 'sell', type: 'market', qty: 5, reduceOnly: true });
  broker.setPrice(120, 7_200_000);
  broker.submit({ symbol: 'TESTUSDT', side: 'sell', type: 'market', qty: 5, reduceOnly: true });

  assert.equal(broker.trades.length, 2, 'two exits produce two trade records');
  const [first, second] = broker.trades;
  const entryFeeTotal = 10 * 100 * 0.001;

  assert.ok(first.entryFee > 0 && second.entryFee > 0, 'the entry fee must be allocated to both exits');
  assert.ok(Math.abs(first.entryFee + second.entryFee - entryFeeTotal) < 1e-6, 'allocations must sum to the entry fee');
  for (const trade of broker.trades) {
    assert.ok(Math.abs(trade.totalFees - (trade.entryFee + trade.exitFee)) < 1e-9, 'totalFees = entryFee + exitFee');
    assert.ok(Math.abs(trade.pnl - (trade.grossPnl - trade.totalFees)) < 1e-6, 'pnl must be the net result');
    assert.equal(trade.pnl, trade.netPnl);
  }
  assert.ok(Math.abs(first.grossPnl - 50) < 1e-6, 'partial gross PnL = (110-100)*5');
  assert.ok(Math.abs(second.grossPnl - 100) < 1e-6, 'partial gross PnL = (120-100)*5');

  const netSum = broker.trades.reduce((acc, t) => acc + t.netPnl, 0);
  const cashDelta = broker.cash() - 10_000;
  assert.ok(Math.abs(cashDelta - netSum) < 1e-6, `cash delta ${cashDelta} must equal the sum of net trade PnL ${netSum}`);
  assert.ok(Math.abs(broker.portfolio.feesPaid - (entryFeeTotal + first.exitFee + second.exitFee)) < 1e-6,
    'the ledger must account for every fee');
});

test('T3b a fully closed position leaves no unallocated entry fee behind', () => {
  const broker = makeBroker({ cash: 5_000, mode: 'live' });
  broker.setPrice(50, 0);
  broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 10 });
  broker.setPrice(60, 3_600_000);
  broker.submit({ symbol: 'TESTUSDT', side: 'sell', type: 'market', qty: 10, reduceOnly: true });
  assert.equal(broker.trades.length, 1);
  assert.equal(broker.position(), null);
  assert.ok(Math.abs(broker.trades[0].entryFee - (10 * 50 * 0.001)) < 1e-9);
});

/* ------------------------------------------------------------------------ T4 */

test('T4 partial OCO fill synchronises the sibling quantity and never oversells', () => {
  const broker = makeBroker({ cash: 10_000, participationRate: 0.25 });
  broker.setPrice(100, 0);
  broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 10 });
  // the entry itself consumes the shared budget, so fill it on a liquid bar first
  broker.onCandle(candle(3_600_000, 100, 101, 99, 100, 1_000_000));
  assert.equal(broker.position()?.qty ?? 0, 10, 'the entry must fill before the OCO bar');
  broker.setPrice(100, 3_600_000);

  const stop = broker.submit({
    symbol: 'TESTUSDT', side: 'sell', type: 'stop_market', qty: 10,
    stopPrice: 95, reduceOnly: true, ocoGroup: 'oco-1', reason: 'stop_loss',
  });
  const target = broker.submit({
    symbol: 'TESTUSDT', side: 'sell', type: 'take_profit', qty: 10,
    stopPrice: 110, reduceOnly: true, ocoGroup: 'oco-1', reason: 'take_profit',
  });

  // one bar touches both legs; volume 8 * 25% = 2 units of shared liquidity
  broker.onCandle(candle(7_200_000, 100, 120, 90, 105, 8));

  assert.equal(stop.filledQty, 2, 'the stop leg may only sell the shared budget');
  assert.equal(broker.position()?.qty ?? 0, 8, 'the position must shrink by exactly the filled quantity');
  assert.ok(target.qty <= 8, `the sibling must be synchronised down, got ${target.qty}`);
  assert.ok(stop.filledQty + target.filledQty <= 10 + 1e-9, 'the legs must never sell more than the position');

  // next bar: plenty of volume, the target must be able to close the remainder
  broker.onCandle(candle(10_800_000, 105, 115, 104, 112, 1_000_000));
  assert.equal(broker.position(), null, 'the remainder must be closable by the sibling leg');
  const sold = stop.filledQty + target.filledQty;
  assert.ok(Math.abs(sold - 10) < 1e-9, `total sold ${sold} must equal the position size`);
  assert.ok([ORDER_STATUS.CANCELED, ORDER_STATUS.FILLED].includes(stop.status));
});

/* ------------------------------------------------------------------------ T5 */

test('T5 every execution in one bar shares a single liquidity budget', () => {
  const broker = makeBroker({ cash: 100_000, participationRate: 0.25 });
  broker.setPrice(100, 0);
  const a = broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 100 });
  const b = broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 100 });
  broker.onCandle(candle(3_600_000, 100, 100, 100, 100, 100));
  const filled = a.filledQty + b.filledQty;
  assert.ok(filled <= 25 + 1e-9, `bar executions must share the budget, filled ${filled}`);
  assert.ok(filled > 0, 'the budget must still allow some fill');

  broker.onCandle(candle(7_200_000, 100, 100, 100, 100, 100));
  assert.ok(a.filledQty + b.filledQty > filled, 'a new bar replenishes the liquidity budget');
});

/* ------------------------------------------------------------------------ T6 */

test('T6 conservative mode never uses the current bar high to trigger a trailing stop on the earlier low', () => {
  const broker = makeBroker({ cash: 10_000, participationRate: 1, mode: 'live' });
  broker.setExecutionModel('conservative');
  broker.setPrice(110, 0);
  broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 1 });
  broker.executeAction({ type: 'trailing_stop', value: 5 }, { symbol: 'TESTUSDT', price: 110, time: 0 });
  const trail = [...broker.orders.values()].find((o) => o.type === 'trailing_stop');
  assert.ok(trail);

  broker.onCandle(candle(3_600_000, 110, 120, 105, 115, 1_000_000));

  assert.equal(broker.position()?.qty ?? 0, 1, 'the low did not reach the level derived from the pre-bar high');
  assert.ok(Math.abs(broker.position().highWater - 120) < 1e-9, 'the high must update the watermark for later bars');
  assert.ok(Math.abs(trail.stopPrice - 114) < 1e-9, 'the next bar level becomes 120 * 0.95');
});

test('T6b ohlc path mode allows the high to raise the trailing level before the low is checked', () => {
  const broker = makeBroker({ cash: 10_000, participationRate: 1, mode: 'live' });
  broker.setExecutionModel('ohlc');
  broker.setPrice(110, 0);
  broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 1 });
  broker.executeAction({ type: 'trailing_stop', value: 5 }, { symbol: 'TESTUSDT', price: 110, time: 0 });

  broker.onCandle(candle(3_600_000, 110, 120, 105, 115, 1_000_000));
  assert.equal(broker.position(), null, 'in O->H->L path the 114 level is reachable by the 105 low');
  assert.equal(broker.trades.length, 1);
  assert.ok(Math.abs(broker.trades[0].exitPrice - 114) < 1e-6,
    `a mid-bar trailing trigger fills at its level, not at the earlier open: ${broker.trades[0].exitPrice}`);
});

test('T6c olhc path mode keeps the pre-bar level for the low and only then raises it', () => {
  const broker = makeBroker({ cash: 10_000, participationRate: 1, mode: 'live' });
  broker.setExecutionModel('olhc');
  broker.setPrice(110, 0);
  broker.submit({ symbol: 'TESTUSDT', side: 'buy', type: 'market', qty: 1 });
  broker.executeAction({ type: 'trailing_stop', value: 5 }, { symbol: 'TESTUSDT', price: 110, time: 0 });

  broker.onCandle(candle(3_600_000, 110, 120, 105, 115, 1_000_000));
  assert.equal(broker.position()?.qty ?? 0, 1, 'the low came first, so the pre-bar 104.5 level applies');
  assert.ok(Math.abs(broker.position().highWater - 120) < 1e-9, 'the high is still recorded afterwards');
});

test('T6d conservative mode is the default', () => {
  const broker = makeBroker({});
  assert.equal(broker.executionModel, 'conservative');
});

test('the execution model is explicit and validated', () => {
  const broker = makeBroker({});
  broker.setExecutionModel('ohlc');
  assert.equal(broker.executionModel, 'ohlc');
  assert.throws(() => broker.setExecutionModel('nonsense'), /execution model/i);
});