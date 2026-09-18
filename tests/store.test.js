import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryStorage, defaultState, defaultWatchlist, migrate, STORE_SCHEMA, STORE_KEY } from '../js/store/store.js';
import { createStrategy } from '../js/core/rules.js';
import { createAlert } from '../js/core/alerts.js';

const newStore = () => new Store({ storage: new MemoryStorage() });

test('a fresh store returns the default document', () => {
  const s = newStore().load();
  assert.equal(s.schema, STORE_SCHEMA);
  assert.deepEqual(s.strategies, []);
  assert.equal(s.settings.startingCash, 10_000);
  assert.ok(s.watchlist.includes('BTCUSDT'));
});

test('strategies persist across store instances', () => {
  const storage = new MemoryStorage();
  const a = new Store({ storage });
  a.load();
  const strategy = createStrategy({ name: 'Trvalá', symbol: 'ETHUSDT' });
  a.upsertStrategy(strategy);
  a.save();

  const b = new Store({ storage });
  b.load();
  assert.equal(b.strategies.length, 1);
  assert.equal(b.getStrategy(strategy.id).name, 'Trvalá');
  assert.equal(b.getStrategy(strategy.id).symbol, 'ETHUSDT');
});

test('upsert updates in place and remove deletes', () => {
  const s = newStore();
  s.load();
  const st = createStrategy({ name: 'A' });
  s.upsertStrategy(st);
  s.upsertStrategy({ ...st, name: 'B' });
  assert.equal(s.strategies.length, 1);
  assert.equal(s.strategies[0].name, 'B');
  assert.equal(s.removeStrategy(st.id), true);
  assert.equal(s.strategies.length, 0);
  assert.equal(s.removeStrategy('nope'), false);
});

test('duplicateStrategy creates an independent deep copy', () => {
  const s = newStore();
  s.load();
  const st = createStrategy({ name: 'Original' });
  s.upsertStrategy(st);
  const copy = s.duplicateStrategy(st.id);
  assert.notEqual(copy.id, st.id);
  assert.match(copy.name, /kópia/);
  copy.rules[0].name = 'zmenené';
  assert.notEqual(s.getStrategy(st.id).rules[0].name, 'zmenené');
});

test('settings merge instead of replacing', () => {
  const s = newStore();
  s.load();
  s.updateSettings({ feePct: 0.2 });
  assert.equal(s.settings.feePct, 0.2);
  assert.equal(s.settings.slippagePct, 0.05);
});

test('paper state and equity points are bounded', () => {
  const s = newStore();
  s.load();
  s.setPaper({ running: true, symbol: 'ETHUSDT' });
  assert.equal(s.state.paper.running, true);
  for (let i = 0; i < 5200; i += 1) s.appendEquityPoint({ time: i, equity: 1000 + i });
  assert.equal(s.state.paper.equityCurve.length, 5000);
  s.appendPaperTrades(Array.from({ length: 1100 }, (_, i) => ({ id: `t${i}` })));
  assert.equal(s.state.paper.trades.length, 1000);
});

test('backtests are capped at 50 records', () => {
  const s = newStore();
  s.load();
  for (let i = 0; i < 60; i += 1) s.saveBacktest({ strategyId: `s${i}`, metrics: { trades: i } });
  assert.equal(s.state.backtests.length, 50);
  assert.equal(s.state.backtests[0].strategyId, 's59');
});

test('export / import round-trips the whole document', () => {
  const a = newStore();
  a.load();
  a.upsertStrategy(createStrategy({ name: 'Exportovaná' }));
  a.updateSettings({ symbol: 'SOLUSDT' });
  const text = a.exportJSON();

  const b = newStore();
  b.load();
  b.importJSON(text);
  assert.equal(b.strategies.length, 1);
  assert.equal(b.strategies[0].name, 'Exportovaná');
  assert.equal(b.settings.symbol, 'SOLUSDT');
});

test('import with merge=false replaces the document', () => {
  const a = newStore();
  a.load();
  a.upsertStrategy(createStrategy({ name: 'A' }));
  const text = a.exportJSON();

  const b = newStore();
  b.load();
  b.upsertStrategy(createStrategy({ name: 'B' }));
  b.importJSON(text, { merge: false });
  assert.equal(b.strategies.length, 1);
  assert.equal(b.strategies[0].name, 'A');
});

test('import with merge=true unions strategies by id', () => {
  const a = newStore();
  a.load();
  const s1 = createStrategy({ name: 'Jeden' });
  a.upsertStrategy(s1);
  const text = a.exportJSON();

  const b = newStore();
  b.load();
  b.upsertStrategy(createStrategy({ name: 'Dva' }));
  b.importJSON(text, { merge: true });
  assert.equal(b.strategies.length, 2);
});

test('invalid import documents are rejected without corrupting state', () => {
  const s = newStore();
  s.load();
  s.upsertStrategy(createStrategy({ name: 'Bezpečná' }));
  assert.throws(() => s.importJSON('{"nope":1}'), /Neplatný súbor/);
  assert.throws(() => s.importJSON('{ not json'), SyntaxError);
  assert.equal(s.strategies.length, 1);
  assert.equal(s.strategies[0].name, 'Bezpečná');
});

test('migrate upgrades a v1 document', () => {
  const v1 = {
    schema: 1,
    name: 'Staré pravidlo',
    symbol: 'BTCUSDT',
    rules: [{ id: 'r1', name: 'r1', when: { id: 'g', kind: 'group', logic: 'AND', items: [] }, then: [] }],
  };
  const out = migrate(v1);
  assert.equal(out.schema, STORE_SCHEMA);
  assert.equal(out.strategies.length, 1);
  assert.equal(out.strategies[0].name, 'Staré pravidlo');
  assert.ok(out.settings);
  assert.ok(out.paper);
});

test('migrate tolerates garbage input', () => {
  assert.equal(migrate(null).schema, STORE_SCHEMA);
  assert.equal(migrate({}).schema, STORE_SCHEMA);
  assert.deepEqual(migrate({ strategies: 'nope' }).strategies, []);
});

test('corrupted storage falls back to defaults', () => {
  const storage = new MemoryStorage();
  storage.setItem(STORE_KEY, '{ broken json');
  const s = new Store({ storage });
  s.load();
  assert.deepEqual(s.strategies, []);
});

test('change listeners fire on save and can be removed', () => {
  const s = newStore();
  s.load();
  let hits = 0;
  const off = s.onChange(() => { hits += 1; });
  s.updateSettings({ feePct: 0.3 });
  assert.equal(hits, 1);
  off();
  s.updateSettings({ feePct: 0.4 });
  assert.equal(hits, 1);
});

test('a throwing listener cannot break persistence', () => {
  const s = newStore();
  s.load();
  s.onChange(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => s.updateSettings({ feePct: 0.5 }));
  assert.equal(s.settings.feePct, 0.5);
});

test('size reports the persisted byte length', () => {
  const s = newStore();
  s.load();
  s.upsertStrategy(createStrategy({ name: 'X' }));
  assert.ok(s.size() > 100);
});

test('reset returns the store to defaults', () => {
  const s = newStore();
  s.load();
  s.upsertStrategy(createStrategy({ name: 'Z' }));
  s.reset();
  assert.equal(s.strategies.length, 0);
  assert.deepEqual(s.state, { ...defaultState(), updatedAt: s.state.updatedAt, schema: STORE_SCHEMA });
});

/* ------------------------------------------------------------------ alerts */

test('a fresh store has empty alert state and schema v5', () => {
  const s = newStore().load();
  assert.equal(STORE_SCHEMA, 5);
  assert.deepEqual(s.alerts, []);
  assert.deepEqual(s.alertLog, []);
});

test('alert CRUD persists across store instances', () => {
  const storage = new MemoryStorage();
  const a = new Store({ storage });
  a.load();
  const alert = createAlert({ id: 'al_test_1', symbol: 'ETHUSDT', kind: 'rsi_below', params: { value: 25 }, createdAt: 123 });
  a.upsertAlert(alert);
  a.upsertAlert({ ...alert, symbol: 'SOLUSDT' });
  assert.equal(a.alerts.length, 1);
  assert.equal(a.alerts[0].symbol, 'SOLUSDT');

  a.toggleAlert('al_test_1', false);
  assert.equal(a.alerts[0].enabled, false);
  a.toggleAlert('al_test_1');
  assert.equal(a.alerts[0].enabled, true);
  assert.equal(a.toggleAlert('nope'), null);

  const b = new Store({ storage });
  b.load();
  assert.equal(b.alerts.length, 1);
  assert.equal(b.alerts[0].id, 'al_test_1');
  assert.equal(b.alerts[0].symbol, 'SOLUSDT');
  assert.equal(b.removeAlert('al_test_1'), true);
  assert.equal(b.removeAlert('al_test_1'), false);
});

test('replaceAlerts and the trigger log behave and stay bounded', () => {
  const s = newStore();
  s.load();
  s.replaceAlerts([{ id: 'a' }, { id: 'b' }]);
  assert.equal(s.alerts.length, 2);
  s.replaceAlerts(null);
  assert.deepEqual(s.alerts, []);

  s.replaceAlerts([{ id: 'a' }]);
  s.appendAlertLog({ alertId: 'a', at: 1, symbol: 'BTCUSDT' });
  s.appendAlertLog([{ alertId: 'a', at: 2 }, { alertId: 'a', at: 3 }]);
  assert.equal(s.state.alertLog.length, 3);
  assert.equal(s.state.alertLog[0].at, 3, 'newest entry first');

  for (let i = 0; i < 520; i += 1) s.appendAlertLog({ alertId: 'a', at: 100 + i });
  assert.equal(s.state.alertLog.length, 500);
  assert.equal(s.state.alertLog[0].at, 619);
  s.clearAlertLog();
  assert.deepEqual(s.state.alertLog, []);
});

test('migrate upgrades a v3 document and preserves stored alerts', () => {
  const v3 = {
    schema: 3,
    strategies: [],
    settings: {},
    alerts: [{ id: 'kept', symbol: 'BTCUSDT' }],
    alertLog: [{ alertId: 'kept', at: 1 }],
  };
  const out = migrate(v3);
  assert.equal(out.schema, STORE_SCHEMA);
  assert.equal(out.alerts[0].id, 'kept');
  assert.equal(out.alertLog.length, 1);

  const older = migrate({ schema: 2, strategies: 'nope' });
  assert.deepEqual(older.alerts, []);
  assert.deepEqual(older.alertLog, []);
});

test('export/import round-trips alerts and unions them on merge', () => {
  const a = newStore();
  a.load();
  a.replaceAlerts([{ id: 'a1', symbol: 'BTCUSDT' }]);
  a.appendAlertLog({ alertId: 'a1', at: 10 });
  const text = a.exportJSON();

  const b = newStore();
  b.load();
  b.replaceAlerts([{ id: 'b1', symbol: 'ETHUSDT' }]);
  b.importJSON(text, { merge: true });
  assert.deepEqual(b.alerts.map((x) => x.id).sort(), ['a1', 'b1']);
  assert.equal(b.state.alertLog.length, 1);

  const c = newStore();
  c.load();
  c.importJSON(text, { merge: false });
  assert.deepEqual(c.alerts.map((x) => x.id), ['a1']);
  assert.equal(c.state.alertLog.length, 1);
});

test('migrate widens an untouched default watchlist but keeps curated lists', () => {
  const untouched = migrate({ schema: 4, watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] });
  assert.ok(untouched.watchlist.includes('PEPEUSDT'), 'volatile pairs should be added');
  assert.ok(untouched.watchlist.length >= 6);

  const curated = migrate({ schema: 4, watchlist: ['BTCUSDT', 'LINKUSDT'] });
  assert.deepEqual(curated.watchlist, ['BTCUSDT', 'LINKUSDT'], 'user curation must survive');

  const fresh = migrate(null);
  assert.deepEqual(fresh.watchlist, defaultWatchlist());
});
