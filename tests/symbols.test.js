/**
 * symbols.test.js — the curated USDT spot universe.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAJOR_SYMBOLS, POPULAR_SYMBOLS, SYMBOL_CATEGORIES, SYMBOL_PATTERN, VOLATILE_SYMBOLS,
  isVolatileSymbol, isValidSymbol,
} from '../js/data/symbols.js';
import { POPULAR_SYMBOLS as BINANCE_POPULAR, VOLATILE_SYMBOLS as BINANCE_VOLATILE } from '../js/data/binance.js';
import { MAJOR_SYMBOLS as MARKET_MAJOR, SYMBOL_CATEGORIES as MARKET_CATEGORIES } from '../js/data/market.js';

const sorted = (list) => [...list].sort();

test('the universe is large, unique and well-formed', () => {
  assert.ok(MAJOR_SYMBOLS.length >= 20, `only ${MAJOR_SYMBOLS.length} majors`);
  assert.ok(VOLATILE_SYMBOLS.length >= 30, `only ${VOLATILE_SYMBOLS.length} volatile pairs`);
  assert.ok(POPULAR_SYMBOLS.length >= 55, `only ${POPULAR_SYMBOLS.length} pairs in total`);

  for (const list of [MAJOR_SYMBOLS, VOLATILE_SYMBOLS]) {
    assert.equal(new Set(list).size, list.length, 'duplicate symbol in a group');
    for (const sym of list) {
      assert.match(sym, SYMBOL_PATTERN, `${sym} is malformed`);
      assert.ok(isValidSymbol(sym), `${sym} should be valid`);
      assert.ok(sym.endsWith('USDT'), `${sym} is not USDT-quoted`);
    }
  }
  assert.equal(new Set(POPULAR_SYMBOLS).size, POPULAR_SYMBOLS.length, 'duplicate symbol');
  assert.deepEqual(sorted(POPULAR_SYMBOLS), sorted([...MAJOR_SYMBOLS, ...VOLATILE_SYMBOLS]));
});

test('the volatile group really contains the high-beta names', () => {
  for (const sym of ['PEPEUSDT', 'SHIBUSDT', 'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT', '1000SATSUSDT', 'INJUSDT', 'SEIUSDT']) {
    assert.ok(VOLATILE_SYMBOLS.includes(sym), `${sym} missing from the volatile list`);
    assert.ok(isVolatileSymbol(sym), `${sym} should be flagged volatile`);
  }
  assert.equal(isVolatileSymbol('BTCUSDT'), false);
  assert.equal(isVolatileSymbol('pepeusdt'), true, 'lookup must be case-insensitive');
  assert.equal(isValidSymbol('btcusdt'), true);
  assert.equal(isValidSymbol('BTC-EUR'), false);
  assert.equal(isValidSymbol(''), false);
});

test('categories cover the whole universe exactly once', () => {
  const covered = SYMBOL_CATEGORIES.flatMap((c) => c.symbols);
  assert.deepEqual(sorted(covered), sorted(POPULAR_SYMBOLS));
  for (const category of SYMBOL_CATEGORIES) {
    assert.ok(category.id && category.label, 'category needs an id and a label');
    assert.ok(category.symbols.length >= 2, `${category.id} is too small`);
  }
});

test('binance and the market facade re-export the same universe', () => {
  assert.deepEqual(BINANCE_POPULAR, POPULAR_SYMBOLS);
  assert.deepEqual(BINANCE_VOLATILE, VOLATILE_SYMBOLS);
  assert.deepEqual(MARKET_MAJOR, MAJOR_SYMBOLS);
  assert.deepEqual(MARKET_CATEGORIES, SYMBOL_CATEGORIES);
});