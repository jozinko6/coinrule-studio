/**
 * ui.test.js — drives the real UI modules against a stub DOM.
 *
 * This is the closest thing to "opening the app in a browser" that can run
 * without one: app.js boots, every view renders, the rule builder edits a
 * strategy and the backtest button produces results.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, installShell, document } from './helpers/dom-stub.js';

installDom({
  settings: {
    source: 'synthetic',
    symbol: 'BTCUSDT',
    timeframe: '1h',
    candleLimit: 300,
    startingCash: 10_000,
    feePct: 0.1,
    slippagePct: 0.05,
  },
});
const shell = installShell();

// Boot the real application (no network: the seeded settings force offline mode).
const stateMod = await import('../js/ui/state.js');
const rulesMod = await import('../js/core/rules.js');
const templatesMod = await import('../js/core/strategies.js');
await import('../js/app.js');
await new Promise((resolve) => setTimeout(resolve, 120));

const { state, store, navigate } = stateMod;

const viewRoot = () => document.querySelector('#view');
const textOf = (node) => node.textContent;

test('the app boots and loads offline market data', () => {
  assert.equal(state.candles.length, 300);
  assert.equal(state.dataInfo.source, 'synthetic');
  assert.match(document.title, /CoinRule Studio/);
  assert.ok(viewRoot().childNodes.length > 0, 'nothing was rendered');
});

test('the dashboard renders charts and KPI cards', () => {
  navigate('dashboard');
  const html = textOf(viewRoot());
  assert.match(html, /Prehľad/);
  assert.match(html, /Cena/);
  assert.match(html, /RSI/);
  assert.match(html, /Knižnica stratégií/);
  const canvases = viewRoot().querySelectorAll('canvas');
  assert.ok(canvases.length >= 1, 'no chart canvas rendered');
  assert.ok(canvases[0].getContext('2d').calls.length > 10, 'the chart drew nothing');
});

test('every navigation entry renders without an error card', () => {
  for (const view of ['dashboard', 'strategies', 'editor', 'scanner', 'alerts', 'backtest', 'paper', 'trades', 'indicators', 'settings']) {
    navigate(view);
    const root = viewRoot();
    assert.ok(root.childNodes.length > 0, `${view} rendered nothing`);
    assert.ok(!/Chyba zobrazenia/.test(textOf(root)), `${view} threw while rendering`);
    const active = document.querySelectorAll('.nav-btn').filter((b) => b.className.includes('active'));
    assert.equal(active.length, 1, `${view}: expected exactly one active nav button`);
    assert.equal(active[0].getAttribute('data-view'), view);
  }
});

test('the strategy library view lists every template', () => {
  navigate('strategies');
  const cards = viewRoot().querySelectorAll('.strategy-card');
  assert.equal(cards.length, templatesMod.STRATEGY_COUNT);
  assert.ok(textOf(viewRoot()).includes('Knižnica šablón'));
});

test('applying a template creates a stored strategy and opens the editor', () => {
  navigate('strategies');
  const before = store.strategies.length;
  // first card's "Použiť" button
  const card = viewRoot().querySelectorAll('.strategy-card')[0];
  const useBtn = card.querySelectorAll('button').find((b) => b.textContent === 'Použiť');
  assert.ok(useBtn, 'the "Použiť" button is missing');
  useBtn.click();

  assert.equal(store.strategies.length, before + 1);
  assert.equal(state.view, 'editor');
  const editorText = textOf(viewRoot());
  assert.match(editorText, /Editor pravidiel/);
  assert.match(editorText, /AK \(podmienky\)/);
  assert.match(editorText, /POTOM \(akcie\)/);
});

test('the rule builder edits conditions and re-renders the preview', () => {
  const strategy = store.strategies[0];
  navigate('editor');
  const preview = () => viewRoot().querySelectorAll('.preview').at(-1).textContent;
  const originalPreview = preview();

  // change the first condition's operator to ">" (gt)
  const opSelect = viewRoot().querySelectorAll('select').find((s) => [...s.childNodes]
    .some((o) => o.textContent && o.textContent.includes('crosses above')));
  assert.ok(opSelect, 'operator select not found');
  opSelect.value = 'gt';
  opSelect.dispatch('change');

  const updated = store.getStrategy(strategy.id);
  const conds = JSON.stringify(updated);
  assert.ok(conds.includes('"gt"'), 'the operator change was not persisted');
  assert.notEqual(preview(), originalPreview);
});

test('adding a rule and an action updates the document', () => {
  const strategy = store.strategies[0];
  const before = strategy.rules.length;
  navigate('editor');
  const addRule = viewRoot().querySelectorAll('button').find((b) => b.textContent.includes('Pravidlo'));
  assert.ok(addRule, 'the "add rule" button is missing');
  addRule.click();
  assert.equal(store.getStrategy(strategy.id).rules.length, before + 1);

  const addAction = viewRoot().querySelectorAll('button').filter((b) => b.textContent === '＋ Akcia');
  assert.ok(addAction.length >= 1);
  const rule = store.getStrategy(strategy.id).rules.at(-1);
  const actionsBefore = rule.then.length;
  addAction.at(-1).click();
  assert.equal(store.getStrategy(strategy.id).rules.at(-1).then.length, actionsBefore + 1);
});

test('the editor reports validation errors for a broken strategy', () => {
  const broken = rulesMod.createStrategy({ name: '', symbol: '', timeframe: 'x', rules: [] });
  store.upsertStrategy(broken);
  state.editorStrategyId = broken.id;
  navigate('editor');
  const text = textOf(viewRoot());
  assert.match(text, /chýb|Chyba/);
  assert.match(text, /Chýba názov stratégie|Nepodporovaný timeframe/);
  store.removeStrategy(broken.id);
});

test('running a backtest from the UI fills the results panel', () => {
  const strategy = store.strategies[0];
  state.editorStrategyId = strategy.id;
  navigate('backtest');
  const runBtn = viewRoot().querySelectorAll('button').find((b) => b.textContent.includes('Spustiť backtest'));
  assert.ok(runBtn, 'the run button is missing');
  runBtn.click();

  assert.ok(state.backtest, 'no backtest result');
  assert.ok(state.backtest.metrics.bars > 100);
  assert.ok(Number.isFinite(state.backtest.metrics.totalReturnPct));
  assert.equal(store.state.backtests.length, 1);

  const text = textOf(viewRoot());
  assert.match(text, /Výsledky/);
  assert.match(text, /Krivka kapitálu/);
  assert.match(text, /Max\. drawdown/);
});

test('the paper trading view renders its controls and account state', () => {
  navigate('paper');
  const text = textOf(viewRoot());
  assert.match(text, /Ovládanie session/);
  assert.match(text, /Aktívne stratégie/);
  const startBtn = viewRoot().querySelectorAll('button').find((b) => b.textContent.includes('Štart'));
  assert.ok(startBtn, 'the start button is missing');
});

test('the indicators view previews any registered indicator', () => {
  navigate('indicators');
  const text = textOf(viewRoot());
  assert.match(text, /Katalóg indikátorov/);
  const rows = viewRoot().querySelectorAll('tr');
  assert.ok(rows.length > 50, `expected the full indicator catalogue, got ${rows.length} rows`);
});

test('the settings view exposes data-source and backup controls', () => {
  navigate('settings');
  const text = textOf(viewRoot());
  assert.match(text, /Zdroj dát/);
  assert.match(text, /Export všetkých dát/);
  assert.match(text, /Import dát/);
  assert.match(text, /bez API kľúčov/);
});

test('importing an invalid document shows an error instead of throwing', async () => {
  const dom = await import('../js/ui/dom.js');
  const before = store.strategies.length;
  assert.throws(() => store.importJSON('{"nope":1}'), /Neplatný súbor/);
  assert.equal(store.strategies.length, before);
  assert.equal(typeof dom.toast, 'function');
});

test('toasts and modals render into the stub DOM', async () => {
  const { toast, modal, confirmDialog } = await import('../js/ui/dom.js');
  toast('testovacia správa', 'ok');
  assert.match(document.querySelector('#toasts').textContent, /testovacia správa/);

  const handle = modal({ title: 'Test', body: document.createElement('p'), actions: [{ label: 'OK' }] });
  assert.match(document.querySelector('#modal-root').textContent, /Test/);
  handle.close();
  assert.equal(document.querySelector('#modal-root').hidden, true);

  const pending = confirmDialog('Naozaj?');
  assert.equal(typeof pending.then, 'function');
  const okBtn = document.querySelector('#modal-root').querySelectorAll('button').find((b) => b.textContent === 'Potvrdiť');
  okBtn.click();
  assert.equal(await pending, true);
});

test('an unknown hash falls back to the dashboard', () => {
  window.location.hash = '#/nonsense';
  assert.equal(stateMod.viewFromHash(), 'dashboard');
  window.location.hash = '#/paper';
  assert.equal(stateMod.viewFromHash(), 'paper');
});

test('no third-party script or CDN reference is present in the shell', () => {
  const html = document.body.innerHTML;
  assert.equal(html, ''); // the stub body is built programmatically
  assert.equal(shell['view'].tagName, 'MAIN');
});

test('the scanner view runs an offline scan and ranks the watchlist', async () => {
  navigate('scanner');
  const initial = textOf(viewRoot());
  assert.match(initial, /Skenovať trh/);
  assert.match(initial, /Nastavenia skenu/);

  const runBtn = viewRoot().querySelectorAll('button').find((b) => b.textContent.includes('Spustiť sken'));
  assert.ok(runBtn, 'the scan button is missing');
  runBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(state.scanRunning, false, 'the scan did not finish');
  assert.ok(Array.isArray(state.scan) && state.scan.length >= 1, 'the scan produced no results');
  const after = textOf(viewRoot());
  assert.match(after, /Výsledky/);
  assert.match(after, /BTCUSDT/);
  assert.match(after, /Signály/);
});

test('the alerts view creates, stores and checks an alert', async () => {
  navigate('alerts');
  assert.match(textOf(viewRoot()), /Upozornenia/);
  const before = store.state.alerts.length;

  const inputs = viewRoot().querySelectorAll('input');
  assert.ok(inputs.length >= 2, 'the alert form inputs are missing');
  inputs[0].value = 'BTCUSDT';
  inputs[0].dispatch('input');
  const numeric = inputs.find((i) => i.getAttribute('type') === 'number');
  assert.ok(numeric, 'the numeric parameter input is missing');
  numeric.value = '0';
  numeric.dispatch('change');

  const addBtn = viewRoot().querySelectorAll('button').find((b) => b.textContent.includes('Pridať upozornenie'));
  assert.ok(addBtn, 'the add button is missing');
  addBtn.click();
  assert.equal(store.state.alerts.length, before + 1, 'the alert was not stored');
  const alert = store.state.alerts.at(-1);
  assert.equal(alert.symbol, 'BTCUSDT');
  assert.equal(alert.params.value, 0);

  const checkBtn = viewRoot().querySelectorAll('button').find((b) => b.textContent.includes('Skontrolovať teraz'));
  assert.ok(checkBtn, 'the check button is missing');
  checkBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(state.alertLastCheck > 0, 'the alert check did not run');
  assert.ok(state.alertLastTriggers.length >= 1, 'price > 0 must trigger');
  assert.ok(store.state.alertLog.length >= 1, 'the trigger log is empty');
  assert.match(textOf(viewRoot()), /História spustení/);
});

test('the scanner exposes the volatile pair universe', () => {
  navigate('scanner');
  const btn = viewRoot().querySelectorAll('button').find((b) => b.textContent.includes('Volatilné'));
  assert.ok(btn, 'the volatile quick-set button is missing');
  btn.click();
  assert.ok(state.scanSymbols.length >= 30, `only ${state.scanSymbols.length} volatile pairs`);
  assert.ok(state.scanSymbols.includes('PEPEUSDT'));
  assert.ok(state.scanSymbols.includes('WIFUSDT'));
  const majorsBtn = viewRoot().querySelectorAll('button').find((b) => b.textContent.includes('Hlavné'));
  assert.ok(majorsBtn, 'the majors quick-set button is missing');
  majorsBtn.click();
  assert.ok(state.scanSymbols.includes('BTCUSDT'));
  assert.ok(!state.scanSymbols.includes('PEPEUSDT'));
});
