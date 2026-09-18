/** alerts.js — local price/indicator alerts: create, review, check. */

import { h, table, pill, toast, button, numberInput, textInput, fmtDate, stat } from '../dom.js';
import { state, store, emit, market } from '../state.js';
import { sanitizeCandles } from '../../data/market.js';
import {
  ALERT_KINDS, applyTriggers, checkAlerts, createAlert, defaultParams, describeAlert,
  getAlertKind, validateAlert,
} from '../../core/alerts.js';

export function render() {
  const wrap = h('div');

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Upozornenia'),
      h('p', { class: 'muted small' }, 'Upozornenia sa vyhodnocujú lokálne nad načítanými sviečkami. Nikam sa neposielajú.')),
    h('div', { class: 'actions' },
      notificationControl(),
      button(state.alertCheckRunning ? 'Kontrolujem…' : 'Skontrolovať teraz', checkNow, 'btn primary', { disabled: state.alertCheckRunning }))));

  wrap.append(draftCard());
  wrap.append(alertsCard());
  wrap.append(logCard());
  return wrap;
}

/* ------------------------------------------------------------------- draft */

function draft() {
  if (!state.alertDraft) {
    const kind = ALERT_KINDS[0];
    state.alertDraft = { symbol: state.symbol, kind: kind.id, params: defaultParams(kind), note: '' };
  }
  return state.alertDraft;
}

function draftCard() {
  const d = draft();
  const kind = getAlertKind(d.kind) ?? ALERT_KINDS[0];

  const kindSelect = h('select', {
    onchange: (e) => {
      const next = getAlertKind(e.target.value) ?? ALERT_KINDS[0];
      state.alertDraft = { ...draft(), kind: next.id, params: defaultParams(next) };
      emit();
    },
  });
  for (const k of ALERT_KINDS) {
    const opt = h('option', { value: k.id, title: k.description }, k.label);
    if (k.id === d.kind) opt.selected = true;
    kindSelect.append(opt);
  }

  const paramFields = Object.entries(kind.params).map(([key, spec]) => h('label', { class: 'field' },
    h('span', null, spec.label),
    numberInput(d.params[key], (v) => { d.params[key] = v; }, { step: spec.step ?? 'any', min: spec.min })));

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Nové upozornenie'),
      h('span', { class: 'muted small' }, kind.description)),
    h('div', { class: 'grid cols-4' },
      h('label', { class: 'field' }, h('span', null, 'Pár'),
        textInput(d.symbol, (v) => { d.symbol = String(v).toUpperCase(); })),
      h('label', { class: 'field' }, h('span', null, 'Typ'), kindSelect),
      ...paramFields,
      h('label', { class: 'field' }, h('span', null, 'Poznámka'),
        textInput(d.note, (v) => { d.note = v; }))),
    h('div', { class: 'split', style: { marginTop: '.75rem' } },
      button('Pridať upozornenie', addAlert, 'btn primary'),
      h('span', { class: 'muted small' }, `Podmienka: ${describeAlert({ kind: kind.id, params: d.params })}`)));
}

function addAlert() {
  const d = draft();
  const alert = createAlert({ symbol: d.symbol, kind: d.kind, params: d.params, note: d.note, createdAt: Date.now() });
  const errors = validateAlert(alert);
  if (errors.length) { toast(errors[0], 'err'); return; }
  store.upsertAlert(alert);
  state.alertDraft = null;
  emit();
  toast(`Upozornenie pridané: ${alert.symbol} ${describeAlert(alert)}`, 'ok');
}

/* ------------------------------------------------------------------ alerts */

function alertsCard() {
  const alerts = store.state.alerts ?? [];
  const rows = alerts.map((alert) => [
    h('span', { class: alert.enabled ? '' : 'muted' }, alert.symbol),
    describeAlert(alert),
    h('span', { class: 'muted small' }, alert.note || '—'),
    button(alert.enabled ? 'zapnuté' : 'vypnuté', () => { store.toggleAlert(alert.id); emit(); },
      `btn small ${alert.enabled ? '' : 'ghost'}`),
    String(alert.triggerCount ?? 0),
    alert.lastTriggeredAt ? fmtDate(alert.lastTriggeredAt) : '—',
    button('Zmazať', () => { store.removeAlert(alert.id); emit(); toast('Upozornenie zmazané', 'info'); }, 'btn small danger'),
  ]);

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, `Uložené upozornenia (${alerts.length})`),
      h('span', { class: 'muted small' }, state.alertCheckRunning ? 'kontrolujem…' : 'vyhodnocujú sa ručne alebo pri obnovení dát')),
    table([
      { label: 'Pár' }, { label: 'Podmienka' }, { label: 'Poznámka' }, { label: 'Stav' },
      { label: 'Spustení', num: true }, { label: 'Naposledy' }, { label: 'Akcia' },
    ], rows, { empty: 'Zatiaľ žiadne upozornenia — pridaj prvé vyššie.' }));
}

/* --------------------------------------------------------------------- log */

function logCard() {
  const log = (store.state.alertLog ?? []).slice(0, 20);
  const rows = log.map((entry) => [
    fmtDate(entry.at),
    entry.symbol ?? '—',
    entry.message ?? '—',
  ]);
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, `História spustení (${(store.state.alertLog ?? []).length})`),
      log.length ? button('Vymazať log', () => { store.clearAlertLog(); emit(); }, 'btn small') : null),
    state.alertLastCheck
      ? h('p', { class: 'muted small' }, `Posledná kontrola: ${fmtDate(state.alertLastCheck)} · spustené: ${state.alertLastTriggers.length}`)
      : null,
    table([{ label: 'Čas' }, { label: 'Pár' }, { label: 'Správa' }], rows, { empty: 'Žiadne spustenia.' }));
}

/* -------------------------------------------------------------- evaluation */

async function checkNow() {
  const enabled = (store.state.alerts ?? []).filter((a) => a.enabled);
  if (!enabled.length) { toast('Žiadne zapnuté upozornenia', 'warn'); return; }

  state.alertCheckRunning = true;
  emit();

  const symbols = [...new Set(enabled.map((a) => a.symbol))];
  const forceSource = state.dataInfo.degraded ? 'synthetic' : null;
  const datasets = [];
  for (const symbol of symbols) {
    try {
      const res = await market.loadCandles({ symbol, timeframe: state.timeframe, limit: 400, forceSource });
      datasets.push({ symbol, candles: sanitizeCandles(res.candles) });
    } catch (err) {
      toast(`${symbol}: ${err.message}`, 'err');
    }
  }

  const now = Date.now();
  const { triggers, checked, skipped } = checkAlerts(store.state.alerts, datasets, { now });
  if (triggers.length) {
    store.replaceAlerts(applyTriggers(store.state.alerts, triggers, now));
    store.appendAlertLog(triggers.map((t, i) => ({
      id: `log_${now}_${i}`,
      at: now,
      alertId: t.alertId,
      symbol: t.symbol,
      message: t.message,
    })));
    for (const t of triggers) toast(`${t.symbol}: ${t.message}`, 'ok', 8000);
    notify(triggers);
  }

  state.alertLastCheck = now;
  state.alertLastTriggers = triggers;
  state.alertCheckRunning = false;
  emit();
  toast(`Skontrolované ${checked} upozornení (${skipped} preskočených)`, triggers.length ? 'ok' : 'info');
}

function notify(triggers) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const t of triggers) {
    try { new Notification('CoinRule Studio', { body: `${t.symbol}: ${t.message}` }); } catch { /* browser refused */ }
  }
}

function notificationControl() {
  if (typeof Notification === 'undefined') return null;
  if (Notification.permission === 'granted') return pill('systémové notifikácie zapnuté', 'ok');
  if (Notification.permission === 'denied') return pill('notifikácie zakázané', 'warn');
  return button('Povoliť notifikácie', () => {
    Notification.requestPermission().then(() => emit());
  }, 'btn small');
}

/* ------------------------------------------------------------------- mount */

export function afterMount() {
  // Nothing to draw — all state is rendered synchronously.
}