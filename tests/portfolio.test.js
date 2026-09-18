import test from 'node:test';
import assert from 'node:assert/strict';
import { Portfolio, Position } from '../js/core/portfolio.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

test('a fresh portfolio starts with cash and no exposure', () => {
  const p = new Portfolio({ cash: 5000 });
  assert.equal(p.cash, 5000);
  assert.equal(p.equity(100), 5000);
  assert.equal(p.exposurePct(100), 0);
  assert.equal(p.totalReturnPct(100), 0);
});

test('buying moves cash into a position and charges the fee', () => {
  const p = new Portfolio({ cash: 10_000, feePct: 0.1 });
  p.applyBuy({ symbol: 'BTCUSDT', qty: 1, price: 100, fee: 0.1 });
  approx(p.cash, 10_000 - 100 - 0.1);
  approx(p.feesPaid, 0.1);
  const pos = p.position('BTCUSDT');
  assert.equal(pos.qty, 1);
  assert.equal(pos.entryPrice, 100);
  approx(p.equity(100), 10_000 - 0.1);
});

test('selling realizes PnL and closes the position', () => {
  const p = new Portfolio({ cash: 10_000 });
  p.applyBuy({ symbol: 'BTCUSDT', qty: 1, price: 100, fee: 0.1 });
  const res = p.applySell({ symbol: 'BTCUSDT', qty: 1, price: 110, fee: 0.11 });
  assert.equal(res.closed, true);
  // Trade PnL is NET: gross 10 minus the allocated entry fee (0.10) and the exit fee (0.11)
  approx(res.realizedGross, 10);
  approx(res.entryFeeAlloc, 0.1);
  approx(res.exitFee, 0.11);
  approx(res.realized, 9.79);
  approx(p.cash, 10_000 - 100 - 0.1 + 110 - 0.11);
  approx(p.realizedPnl, 9.79);
  assert.equal(p.position('BTCUSDT'), null);
});

test('partial sells keep the remaining position and average entry', () => {
  const p = new Portfolio({ cash: 10_000 });
  p.applyBuy({ symbol: 'BTC', qty: 2, price: 100, fee: 0 });
  const res = p.applySell({ symbol: 'BTC', qty: 1, price: 120, fee: 0 });
  assert.equal(res.closed, false);
  approx(p.position('BTC').qty, 1);
  assert.equal(p.position('BTC').entryPrice, 100);
  approx(p.realizedPnl, 20);
});

test('adding to a position computes the weighted average entry', () => {
  const p = new Portfolio({ cash: 10_000 });
  p.applyBuy({ symbol: 'BTC', qty: 1, price: 100, fee: 0 });
  p.applyBuy({ symbol: 'BTC', qty: 1, price: 200, fee: 0 });
  approx(p.position('BTC').entryPrice, 150);
  approx(p.position('BTC').qty, 2);
});

test('equity, exposure and drawdown track the marked price', () => {
  const p = new Portfolio({ cash: 1000 });
  p.applyBuy({ symbol: 'BTC', qty: 5, price: 100, fee: 0 }); // spent 500
  approx(p.equity(100), 1000);
  approx(p.equity(120), 1000 + 100);
  approx(p.exposurePct(120), (600 / 1100) * 100, 1e-6);
  p.markToMarket(120);
  approx(p.maxDrawdownPct, 0);
  p.markToMarket(60);
  assert.ok(p.maxDrawdownPct > 0);
  assert.ok(p.drawdownPct(60) > 0);
});

test('deposits and withdrawals update the return baseline', () => {
  const p = new Portfolio({ cash: 1000 });
  p.deposit(1000);
  approx(p.cash, 2000);
  approx(p.totalReturnPct(0), 0);
  p.withdraw(500);
  approx(p.cash, 1500);
  approx(p.totalReturnPct(0), 0);
});

test('the ledger records every mutation', () => {
  const p = new Portfolio({ cash: 1000 });
  p.deposit(100);
  p.applyBuy({ symbol: 'BTC', qty: 1, price: 50, fee: 0.05 });
  p.applySell({ symbol: 'BTC', qty: 1, price: 60, fee: 0.06 });
  const types = p.ledger.map((e) => e.type);
  assert.deepEqual(types, ['deposit', 'buy', 'sell']);
  assert.equal(p.ledger[2].reason, 'signal');
});

test('snapshot and JSON round-trip preserve state', () => {
  const p = new Portfolio({ cash: 1000, feePct: 0.1 });
  p.applyBuy({ symbol: 'BTC', qty: 1, price: 100, fee: 0.1 });
  const json = JSON.parse(JSON.stringify(p.toJSON()));
  const back = Portfolio.fromJSON(json);
  assert.equal(back.cash, p.cash);
  assert.equal(back.feesPaid, p.feesPaid);
  approx(back.position('BTC').qty, 1);
  const snap = p.snapshot(120);
  assert.equal(snap.openPositions.length, 1);
  assert.ok(snap.equity > 0);
});

test('positions track watermarks and a trailing stop price', () => {
  const pos = new Position({ symbol: 'BTC', qty: 1, entryPrice: 100 });
  pos.updateWatermarks(130);
  pos.trailingStopPct = 10;
  approx(pos.trailingStopPrice(130), 117);
  approx(pos.unrealizedPct(130), 30);
  approx(pos.unrealized(130), 30);
});
