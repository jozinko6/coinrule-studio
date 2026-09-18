import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker, createOrder, ORDER_STATUS } from '../js/core/paper.js';
import { Portfolio } from '../js/core/portfolio.js';

const approx = (a, b, eps = 1e-6) => {
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);
};

const bar = (open, high, low, close, volume = 1000, time = 0) => ({ time, open, high, low, close, volume });

function freshBroker(opts = {}) {
  return new PaperBroker({
    symbol: 'BTCUSDT',
    startingCash: 10_000,
    takerFeePct: 0.1,
    makerFeePct: 0.1,
    slippagePct: 0.05,
    mode: 'backtest',
    ...opts,
  });
}

test('createOrder fills sane defaults', () => {
  const o = createOrder({ side: 'buy', qty: 1 });
  assert.equal(o.type, 'market');
  assert.equal(o.status, ORDER_STATUS.NEW);
  assert.equal(o.timeInForce, 'GTC');
  assert.ok(o.id.startsWith('ord_'));
});

test('market orders are queued in backtest mode and filled at the NEXT bar open', () => {
  const b = freshBroker();
  b.setPrice(100, 0);
  const o = b.submit({ side: 'buy', type: 'market', qty: 1 });
  assert.equal(o.status, ORDER_STATUS.PENDING_OPEN, 'must not fill at the signal bar');
  assert.equal(b.portfolio.position('BTCUSDT'), null);

  b.onCandle(bar(150, 160, 145, 155, 1000, 1000));
  assert.equal(o.status, ORDER_STATUS.FILLED);
  approx(o.avgFillPrice, 150 * 1.0005, 1e-6);
  approx(b.portfolio.cash, 10_000 - 150.075 - 0.150075, 1e-4);
});

test('slippage moves buys up and sells down', () => {
  const b = freshBroker();
  b.setPrice(100);
  approx(b.slippagePrice(100, 'buy'), 100.05);
  approx(b.slippagePrice(100, 'sell'), 99.95);
  approx(b.slippagePrice(100, 'buy', { isMaker: true }), 100);
});

test('fees are charged on the notional of every fill', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  approx(b.portfolio.feesPaid, 0.10005, 1e-9);
});

test('stop-loss triggers intrabar and closes the position', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  b.executeAction({ type: 'stop_loss', value: 5 }, { price: 100, symbol: 'BTCUSDT', time: 1 });
  const stop = [...b.openOrders].find((o) => o.type === 'stop_market');
  approx(stop.stopPrice, 95);

  b.onCandle(bar(100, 101, 94, 96, 1000, 2000));
  assert.equal(b.portfolio.position('BTCUSDT'), null, 'position should be closed by the stop');
  assert.equal(b.trades.length, 1);
  approx(b.trades[0].exitPrice, 95 * 0.9995, 1e-6);
});

test('a gap through the stop fills at the open, not at the stop', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  b.executeAction({ type: 'stop_loss', value: 5 }, { price: 100, symbol: 'BTCUSDT', time: 1 });
  b.onCandle(bar(80, 82, 79, 81, 1000, 2000)); // gaps below the 95 stop
  approx(b.trades[0].exitPrice, 80 * 0.9995, 1e-6);
});

test('take-profit triggers when the high crosses the target', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  b.executeAction({ type: 'take_profit', value: 10 }, { price: 100, symbol: 'BTCUSDT', time: 1 });
  b.onCandle(bar(100, 112, 99, 111, 1000, 2000));
  assert.equal(b.portfolio.position('BTCUSDT'), null);
  approx(b.trades[0].exitPrice, 110 * 0.9995, 1e-6);
});

test('trailing stop follows the high-water mark', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  b.executeAction({ type: 'trailing_stop', value: 5 }, { price: 100, symbol: 'BTCUSDT', time: 1 });

  b.onCandle(bar(100, 120, 115, 118, 1000, 2000)); // high water 120 -> stop 114
  const t = [...b.openOrders].find((o) => o.type === 'trailing_stop');
  approx(t.stopPrice, 114);

  b.onCandle(bar(118, 119, 113, 115, 1000, 3000)); // dips through 114
  assert.equal(b.portfolio.position('BTCUSDT'), null);
  approx(b.trades[0].exitPrice, 114 * 0.9995, 1e-6);
});

test('limit orders fill at the limit price or better', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.submit({ side: 'buy', type: 'limit', qty: 1, price: 95 });
  b.onCandle(bar(100, 101, 94, 99, 1000, 1000));
  const o = [...b.orders.values()][0];
  assert.equal(o.status, ORDER_STATUS.FILLED);
  approx(o.avgFillPrice, 95, 1e-9); // min(limit, open) = 95
});

test('limit orders that are never touched stay open', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.submit({ side: 'buy', type: 'limit', qty: 1, price: 50 });
  b.onCandle(bar(100, 101, 90, 99, 1000, 1000));
  assert.equal([...b.orders.values()][0].status, ORDER_STATUS.NEW);
});

test('partial fills respect the participation rate', () => {
  const b = freshBroker({ participationRate: 0.25 });
  b.setPrice(100);
  const o = b.submit({ side: 'buy', type: 'market', qty: 10 });
  b.onCandle(bar(100, 100, 100, 100, 8, 1000)); // capacity = 2
  assert.equal(o.status, ORDER_STATUS.PARTIAL);
  approx(o.filledQty, 2, 1e-9);
  b.onCandle(bar(100, 100, 100, 100, 100, 2000));
  assert.equal(o.status, ORDER_STATUS.FILLED);
  approx(o.filledQty, 10, 1e-9);
});

test('FOK orders are canceled when they cannot fill completely', () => {
  const b = freshBroker({ participationRate: 0.1 });
  b.setPrice(100);
  const o = b.submit({ side: 'buy', type: 'limit', qty: 10, price: 100, timeInForce: 'FOK' });
  b.onCandle(bar(100, 100, 100, 100, 5, 1000));
  assert.equal(o.status, ORDER_STATUS.CANCELED);
});

test('OCO cancels the sibling order when one leg fills', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  const tp = b.executeAction({ type: 'take_profit', value: 10 }, { price: 100, symbol: 'BTCUSDT', time: 1 })[0];
  const sl = b.executeAction({ type: 'stop_loss', value: 5 }, { price: 100, symbol: 'BTCUSDT', time: 1 })[0];
  tp.ocoGroup = 'g1';
  sl.ocoGroup = 'g1';
  b.onCandle(bar(100, 112, 99, 111, 1000, 2000));
  assert.equal(tp.status, ORDER_STATUS.FILLED);
  assert.equal(sl.status, ORDER_STATUS.CANCELED);
});

test('OCO never double-fills when both legs are touched in the same bar', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  const tp = b.submit({ side: 'sell', type: 'limit', qty: 1, price: 105, ocoGroup: 'g1', reduceOnly: true });
  const tp2 = b.submit({ side: 'sell', type: 'limit', qty: 1, price: 110, ocoGroup: 'g1', reduceOnly: true });

  // the bar touches BOTH legs
  b.onCandle(bar(100, 112, 99, 111, 1000, 2000));
  assert.equal(tp.status, ORDER_STATUS.FILLED);
  assert.equal(tp2.status, ORDER_STATUS.CANCELED);
  assert.equal(tp2.filledQty, 0, 'the cancelled leg must not be filled at all');
  assert.equal(b.trades.length, 1, 'a cancelled OCO sibling must never fill');
  assert.equal(b.portfolio.position('BTCUSDT'), null);
});

test('OCO also holds for non-reduce-only legs (no double entry)', () => {
  // Without reduceOnly the position check cannot mask a double fill, so this
  // test fails if the dead-order guard in fillOrder() is removed.
  const b = freshBroker();
  b.setPrice(100);
  const a = b.submit({ side: 'buy', type: 'limit', qty: 1, price: 105, ocoGroup: 'g2' });
  const c = b.submit({ side: 'buy', type: 'limit', qty: 1, price: 110, ocoGroup: 'g2' });

  b.onCandle(bar(100, 112, 99, 111, 1000, 2000)); // touches both limits
  const filled = [a, c].filter((o) => o.status === ORDER_STATUS.FILLED);
  assert.equal(filled.length, 1, 'exactly one OCO leg may fill');
  assert.equal(a.filledQty + c.filledQty, 1);
  assert.equal(b.portfolio.position('BTCUSDT').qty, 1, 'the position must not double');
});

test('reduce-only orders are cancelled once their position is gone', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  const sl = b.executeAction({ type: 'stop_loss', value: 50 }, { price: 100, symbol: 'BTCUSDT', time: 1 })[0];
  b.submit({ side: 'sell', type: 'market', qty: 1, reduceOnly: true }); // close manually
  assert.equal(b.portfolio.position('BTCUSDT'), null);
  b.onCandle(bar(100, 101, 99, 100, 1000, 2000));
  assert.equal(sl.status, ORDER_STATUS.CANCELED);
  assert.equal(b.trades.length, 1, 'the orphaned stop must not create a second trade');
});

test('limit and stop-limit orders without a price are rejected', () => {
  const b = freshBroker();
  b.setPrice(100);
  const l = b.submit({ side: 'buy', type: 'limit', qty: 1 });
  const sl = b.submit({ side: 'buy', type: 'stop_limit', qty: 1, stopPrice: 110 });
  assert.equal(l.status, ORDER_STATUS.REJECTED);
  assert.equal(sl.status, ORDER_STATUS.REJECTED);
  assert.deepEqual(b.rejections.map((r) => r.reason), ['missing_limit_price', 'missing_limit_price']);
  assert.equal(b.openOrders.length, 0);
});

test('a stop-limit does not fill until its stop price is reached', () => {
  const b = freshBroker();
  b.setPrice(100);
  const order = b.submit({ side: 'buy', type: 'stop_limit', qty: 1, stopPrice: 110, price: 105 });

  // price never reaches the 110 stop, so the 105 limit must stay untouched
  b.onCandle(bar(100, 106, 99, 100, 1000, 1000));
  assert.equal(order.filledQty, 0, 'stop-limit filled before its stop triggered');
  assert.equal(order.status, ORDER_STATUS.NEW);

  // stop triggered -> the order becomes a resting limit order
  b.onCandle(bar(100, 111, 99, 110, 1000, 2000));
  assert.equal(order.type, 'limit');
  assert.equal(order.filledQty, 0, 'a freshly triggered stop-limit must not fill in the same bar');

  // now the limit price is touched
  b.onCandle(bar(110, 112, 104, 105, 1000, 3000));
  assert.equal(order.status, ORDER_STATUS.FILLED);
  approx(order.avgFillPrice, 105, 1e-9);
});

test('a cancelled order is never filled afterwards', () => {
  const b = freshBroker();
  b.setPrice(100);
  const order = b.submit({ side: 'buy', type: 'limit', qty: 1, price: 95 });
  b.cancel(order.id);
  b.onCandle(bar(100, 101, 90, 92, 1000, 1000));
  assert.equal(order.status, ORDER_STATUS.CANCELED);
  assert.equal(order.filledQty, 0);
  assert.equal(b.portfolio.position('BTCUSDT'), null);
});

test('orders that cost more than the cash balance are downsized', () => {
  const b = freshBroker({ startingCash: 100 });
  b.setPrice(100);
  const o = b.submit({ side: 'buy', type: 'market', qty: 100 });
  assert.ok(o.qty < 100);
  assert.ok(o.qty > 0);
  b.onCandle(bar(100, 100, 100, 100, 1000, 1000));
  assert.ok(b.portfolio.cash >= 0);
});

test('selling more than the position size is impossible', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  b.submit({ side: 'sell', type: 'market', qty: 5, reduceOnly: true });
  assert.equal(b.portfolio.position('BTCUSDT'), null);
  assert.ok(b.portfolio.cash >= 0);
});

test('sizeOrder implements every sizing mode', () => {
  const b = freshBroker({ startingCash: 10_000 });
  b.setPrice(100);
  approx(b.sizeOrder({ sizeMode: 'fixed_quote', value: 1000 }, { price: 100 }), 10, 1e-9);
  approx(b.sizeOrder({ sizeMode: 'fixed_base', value: 3 }, { price: 100 }), 3, 1e-9);
  approx(b.sizeOrder({ sizeMode: 'percent_cash', value: 50 }, { price: 100 }), 50, 1e-6);
  approx(b.sizeOrder({ sizeMode: 'percent_equity', value: 100 }, { price: 100 }), 99.9, 1e-6);
  approx(b.sizeOrder({ sizeMode: 'all_cash' }, { price: 100 }), 99.9, 1e-6);
  // risk 1 % of 10 000 = 100 with a 2 % stop distance (2 USDT) -> 50 units
  approx(b.sizeOrder({ sizeMode: 'risk_percent', value: 1 }, { price: 100, stopPct: 2 }), 50, 1e-9);
  // ATR sizing: risk 100 / (ATR 1 * mult 2) = 50 units
  approx(b.sizeOrder({ sizeMode: 'atr_risk', value: 1, atrMult: 2 }, { price: 100, atr: 1 }), 50, 1e-9);
});

test('cancelAll clears every open order for a symbol', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.submit({ side: 'buy', type: 'limit', qty: 1, price: 90 });
  b.submit({ side: 'buy', type: 'limit', qty: 1, price: 80 });
  assert.equal(b.openOrders.length, 2);
  assert.equal(b.cancelAll('BTCUSDT'), 2);
  assert.equal(b.openOrders.length, 0);
});

test('rejections are recorded with a reason', () => {
  const b = freshBroker({ startingCash: 0 });
  b.setPrice(100);
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  assert.ok(b.rejections.length >= 1);
  assert.equal(b.rejections[0].reason, 'insufficient_funds');
});

test('summary aggregates trades and fees', () => {
  const b = freshBroker();
  b.setPrice(100);
  b.mode = 'live';
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  b.setPrice(120);
  b.submit({ side: 'sell', type: 'market', qty: 1, reduceOnly: true });
  const s = b.summary();
  assert.equal(s.trades, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.winRate, 100);
  assert.ok(s.feesPaid > 0);
  assert.ok(s.equity > 10_000);
});

test('the broker never mutates the shared portfolio when rejected', () => {
  const portfolio = new Portfolio({ cash: 0 });
  const b = freshBroker({ portfolio });
  b.setPrice(100);
  b.submit({ side: 'buy', type: 'market', qty: 1 });
  assert.equal(portfolio.cash, 0);
  assert.equal(portfolio.openPositions.length, 0);
});
