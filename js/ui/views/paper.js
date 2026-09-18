/** paper.js — the live virtual-trading desk (paper trading, no API keys). */

import { h, stat, table, pill, toast, confirmDialog, fmtNum, fmtMoney, fmtPct, fmtQty, fmtDate, signClass, download } from '../dom.js';
import { drawCandles, drawEquity } from '../charts.js';
import { state, store, emit, navigate, loadCandles, ensureEngine, startFeed, stopFeed, resetEngine } from '../state.js';

let chartCanvas = null;
let equityCanvas = null;

export function render() {
  const wrap = h('div');

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Virtuálne obchodovanie'),
      h('p', { class: 'muted small' }, 'Simulovaný účet s reálnymi trhovými dátami. Žiadne reálne príkazy, žiadne API kľúče.')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => navigate('trades') }, 'História obchodov'),
      h('button', { class: 'btn', type: 'button', onclick: () => navigate('strategies') }, 'Pridať stratégiu'))));

  if (!store.strategies.length) {
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('p', null, 'Nemáš žiadnu stratégiu na obchodovanie.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('strategies') }, 'Vybrať šablónu'))));
    return wrap;
  }

  wrap.append(controlCard());

  const engine = state.engine;
  if (!engine) {
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'empty' },
      'Session nebeží. Zvolené stratégie sa spustia po stlačení „Štart“.',
      h('p', { class: 'muted small' }, 'Indikátory sa najprv zahrejú na historických dátach, potom sa simuluje obchodovanie po sviečkach.'))));
    return wrap;
  }

  const snap = engine.snapshot();
  wrap.append(statsCard(snap));
  wrap.append(chartCard(snap));
  wrap.append(positionsCard(snap));
  wrap.append(ordersCard(snap));
  wrap.append(activityCard(snap));
  return wrap;
}

/* ----------------------------------------------------------------- controls */

function controlCard() {
  const settings = store.settings;
  const selected = new Set(settings.paperStrategyIds ?? store.strategies.map((s) => s.id));

  const list = h('div', { class: 'grid cols-3' }, store.strategies.map((s) => h('label', {
    class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '.4rem' },
  },
    h('input', {
      type: 'checkbox', checked: selected.has(s.id),
      onchange: (e) => {
        const set = new Set(store.settings.paperStrategyIds ?? store.strategies.map((x) => x.id));
        if (e.target.checked) set.add(s.id); else set.delete(s.id);
        store.updateSettings({ paperStrategyIds: [...set] });
      },
    }),
    h('span', null, `${s.name} · ${s.symbol}`))));

  const speed = h('input', {
    type: 'range', min: '100', max: '3000', step: '100', value: String(state.paperSpeedMs),
    oninput: (e) => { state.paperSpeedMs = Number(e.target.value); if (state.paperRunning) { startFeed(); } },
  });

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, 'Ovládanie session'),
      h('div', { class: 'split' },
        state.paperRunning ? pill('beží', 'ok') : pill('zastavené', 'idle'),
        pill(state.dataInfo.degraded ? 'simulovaný feed' : 'Binance WebSocket', state.dataInfo.degraded ? 'warn' : 'ok'))),
    h('div', { class: 'grid cols-4' },
      h('label', { class: 'field' }, h('span', null, 'Pár'),
        (() => {
          const el = h('select', { onchange: (e) => { state.symbol = e.target.value; resetEngine(); loadCandles({ symbol: e.target.value }); } });
          for (const s of store.state.watchlist) {
            const o = h('option', { value: s }, s);
            if (s === state.symbol) o.selected = true;
            el.append(o);
          }
          return el;
        })()),
      h('label', { class: 'field' }, h('span', null, 'Rýchlosť simulácie'),
        h('div', { class: 'split' }, speed, h('span', { class: 'muted small' }, `${state.paperSpeedMs} ms/tick`))),
      h('label', { class: 'field' }, h('span', null, 'Počiatočný kapitál'),
        h('input', {
          type: 'number', value: settings.startingCash, step: 100,
          onchange: (e) => { store.updateSettings({ startingCash: Number(e.target.value) }); resetEngine(); },
        })),
      h('label', { class: 'field' }, h('span', null, 'Poplatok / slippage %'),
        h('div', { class: 'split' },
          h('input', { type: 'number', value: settings.feePct, step: 0.01, style: { width: '80px' }, onchange: (e) => store.updateSettings({ feePct: Number(e.target.value) }) }),
          h('input', { type: 'number', value: settings.slippagePct, step: 0.01, style: { width: '80px' }, onchange: (e) => store.updateSettings({ slippagePct: Number(e.target.value) }) })))),
    h('h4', null, 'Aktívne stratégie'),
    list,
    h('div', { class: 'split', style: { marginTop: '.75rem' } },
      state.paperRunning
        ? h('button', { class: 'btn danger', type: 'button', onclick: () => { stopFeed(); toast('Session zastavená', 'warn'); emit(); } }, '■ Zastaviť')
        : h('button', { class: 'btn primary', type: 'button', onclick: start }, '▶ Štart'),
      h('button', { class: 'btn', type: 'button', onclick: closeAll }, 'Zavrieť všetky pozície'),
      h('button', { class: 'btn', type: 'button', onclick: () => { state.engine?.cancelAll(); toast('Príkazy zrušené', 'ok'); emit(); } }, 'Zrušiť príkazy'),
      h('button', { class: 'btn', type: 'button', onclick: exportSession }, 'Export session'),
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => { if (await confirmDialog('Vymazať celú session a začať odznova?', { danger: true, confirmLabel: 'Vymazať' })) { resetEngine(); toast('Session vymazaná', 'ok'); } },
      }, 'Reset')));
}

function start() {
  if (!state.candles.length) { toast('Najprv načítaj dáta', 'warn'); return; }
  const engine = ensureEngine(store.settings.paperStrategyIds);
  if (!engine.historyLoaded) engine.loadHistory(state.candles.slice(-400));
  startFeed();
  toast('Virtuálne obchodovanie spustené', 'ok');
  emit();
}

function closeAll() {
  if (!state.engine) return;
  const closed = state.engine.closeAll('manual');
  toast(closed.length ? `Zatvorených pozícií: ${closed.length}` : 'Žiadne otvorené pozície', closed.length ? 'ok' : 'warn');
  emit();
}

function exportSession() {
  if (!state.engine) return;
  download(`paper-session-${state.symbol}.json`, JSON.stringify(state.engine.toJSON(), null, 2));
  toast('Session exportovaná', 'ok');
}

/* -------------------------------------------------------------------- cards */

function statsCard(snap) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, 'Stav účtu'),
      h('span', { class: 'muted small' }, `tickov: ${snap.ticks} · sviečok: ${snap.bars} · posledná aktivita ${fmtDate(snap.lastTime)}`)),
    h('div', { class: 'grid cols-4' },
      stat('Kapitál', fmtMoney(snap.equity), `štart ${fmtMoney(snap.startEquity)}`),
      stat('Výnos', fmtPct(snap.returnPct), 'od začiatku session', signClass(snap.returnPct)),
      stat('Hotovosť', fmtMoney(snap.cash), `expozícia ${fmtNum(snap.exposurePct, 1)} %`),
      stat('Realizovaný PnL', fmtMoney(snap.realizedPnl), `poplatky ${fmtMoney(snap.feesPaid)}`, signClass(snap.realizedPnl)),
      stat('Cena', fmtNum(snap.price, snap.price > 100 ? 2 : 5), snap.symbol),
      stat('Drawdown', `${fmtNum(snap.drawdownPct, 2)} %`, 'od maxima kapitálu', snap.drawdownPct > 10 ? 'neg' : ''),
      stat('Pozície', String(snap.positions.length), `príkazov v knihe ${snap.openOrders.length}`),
      stat('Obchody', String(snap.trades), 'uzavreté round-tripy')));
}

function chartCard(snap) {
  chartCanvas = h('canvas', { style: { height: '320px' } });
  equityCanvas = h('canvas', { style: { height: '200px' } });
  const engine = state.engine;
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, `Live graf ${snap.symbol}`),
      h('span', { class: 'muted small' }, 'zelené/trojuholníky = vstupy, červené = výstupy')),
    h('div', { class: 'chart-box' }, chartCanvas),
    h('h4', null, 'Krivka kapitálu session'),
    h('div', { class: 'chart-box' }, equityCanvas),
    h('p', { class: 'muted small' }, engine?.runtime.signals.length ? `Posledný signál: ${engine.runtime.signals.at(-1)?.text ?? ''}` : ''));
}

function positionsCard(snap) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Otvorené pozície')),
    table([
      { label: 'Pár' }, { label: 'Množstvo', num: true }, { label: 'Vstup', num: true }, { label: 'Hodnota', num: true },
      { label: 'PnL', num: true }, { label: 'PnL %', num: true }, { label: 'Stop-loss', num: true }, { label: 'Take-profit', num: true }, { label: 'Trailing %', num: true }, { label: 'Otvorené' },
    ], snap.positions.map((p) => [
      p.symbol, fmtQty(p.qty), fmtNum(p.entryPrice, 4), fmtMoney(p.value),
      h('span', { class: signClass(p.pnl) }, fmtMoney(p.pnl)),
      h('span', { class: signClass(p.pnlPct) }, fmtPct(p.pnlPct)),
      p.stopLoss ? fmtNum(p.stopLoss, 4) : '—',
      p.takeProfit ? fmtNum(p.takeProfit, 4) : '—',
      p.trailingPct ? fmtNum(p.trailingPct, 2) : '—',
      fmtDate(p.openedAt),
    ]), { empty: 'Žiadne otvorené pozície.' }));
}

function ordersCard(snap) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Príkazy v knihe')),
    table([
      { label: 'ID' }, { label: 'Strana' }, { label: 'Typ' }, { label: 'Množstvo', num: true },
      { label: 'Naplnené', num: true }, { label: 'Cena', num: true }, { label: 'Stop', num: true }, { label: 'Stav' }, { label: 'Dôvod' },
    ], snap.openOrders.map((o) => [
      o.id, o.side, o.type, fmtQty(o.qty), fmtQty(o.filledQty),
      o.price ? fmtNum(o.price, 4) : '—', o.stopPrice ? fmtNum(o.stopPrice, 4) : '—', o.status, o.reason,
    ]), { empty: 'Žiadne pracovné príkazy.' }));
}

function activityCard(snap) {
  const engine = state.engine;
  const trades = engine ? engine.broker.trades.slice(-40).reverse() : [];
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Posledné obchody a udalosti')),
    h('h4', null, 'Uzavreté obchody'),
    table([
      { label: 'Zatvorené' }, { label: 'Vstup', num: true }, { label: 'Výstup', num: true },
      { label: 'PnL', num: true }, { label: 'PnL %', num: true }, { label: 'Dôvod' },
    ], trades.map((t) => [
      fmtDate(t.closedAt), fmtNum(t.entryPrice, 4), fmtNum(t.exitPrice, 4),
      h('span', { class: signClass(t.pnl) }, fmtMoney(t.pnl)),
      h('span', { class: signClass(t.pnlPct) }, fmtPct(t.pnlPct)), t.reason,
    ]), { empty: 'Zatiaľ žiadne uzavreté obchody.' }),
    h('h4', null, 'Signály pravidiel'),
    table([{ label: 'Čas' }, { label: 'Stratégia' }, { label: 'Pravidlo' }, { label: 'Definícia' }],
      snap.signals.map((s) => [fmtDate(s.time), s.strategyName ?? '—', s.ruleName ?? s.message ?? '—', s.text ?? '']),
      { empty: 'Žiadne signály.' }),
    h('h4', null, 'Udalosti brokera'),
    table([{ label: 'Čas' }, { label: 'Typ' }, { label: 'Správa' }],
      snap.events.map((e) => [fmtDate(e.time), e.type, e.message]),
      { empty: 'Žiadne udalosti.' }));
}

/* -------------------------------------------------------------------- mount */

export function afterMount() {
  const engine = state.engine;
  if (!engine) return;
  if (chartCanvas && engine.candles.length) {
    const slice = engine.candles.slice(-160);
    const offset = engine.candles.length - slice.length;
    const markers = engine.broker.trades.slice(-40).flatMap((t) => {
      const out = [];
      const oi = engine.candles.findIndex((c) => c.time === t.openedAt);
      const ci = engine.candles.findIndex((c) => c.time === t.closedAt);
      if (oi >= offset) out.push({ index: oi - offset, price: t.entryPrice, side: 'buy' });
      if (ci >= offset) out.push({ index: ci - offset, price: t.exitPrice, side: 'sell' });
      return out;
    });
    drawCandles(chartCanvas, { candles: slice, markers, height: 320 });
  }
  if (equityCanvas && engine.equityCurve.length > 1) {
    drawEquity(equityCanvas, engine.equityCurve, { height: 200, label: 'Kapitál' });
  }
}
