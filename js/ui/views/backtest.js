/** backtest.js — configure and run a historical simulation, then inspect it. */

import { h, stat, table, pill, toast, confirmDialog, download, fmtNum, fmtMoney, fmtPct, fmtDate, fmtQty, fmtDuration, signClass } from '../dom.js';
import { drawEquity, drawBars, drawCandles } from '../charts.js';
import { state, store, emit, navigate, loadCandles } from '../state.js';
import { getBackendClient } from '../backend-session.js';
import { backtest, compareStrategies } from '../../core/backtest.js';
import { sma, ema } from '../../core/indicators.js';

let equityCanvas = null;
let monthlyCanvas = null;
let priceCanvas = null;

export function render() {
  const wrap = h('div');
  const settings = store.settings;

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Backtest'),
      h('p', { class: 'muted small' }, `Historická simulácia na ${state.candles.length} sviečkach ${state.symbol} · ${state.timeframe}`)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => loadCandles() }, 'Obnoviť dáta'))));

  if (!store.strategies.length) {
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('p', null, 'Najprv si vytvor alebo vyber stratégiu.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('strategies') }, 'Prezrieť knižnicu'))));
    return wrap;
  }

  wrap.append(setupCard());
  const res = state.backtest;
  if (res) {
    wrap.append(resultsCard(res));
    const attribution = attributionCard(res);
    if (attribution) wrap.append(attribution);
    wrap.append(chartsCard(res));
    wrap.append(tradesCard(res));
    wrap.append(activityCard(res));
  } else {
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Spusti backtest pre zobrazenie výsledkov.')));
  }
  wrap.append(historyCard());
  return wrap;
}

/** Per-strategy split of a shared-cash backtest (Phase 17). */
function attributionCard(res) {
  const rows = res.metrics?.perStrategy ?? [];
  if (!rows.length) return null;
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, 'Rozdelenie podľa stratégií'),
      pill(rows.length + (rows.length === 1 ? ' stratégia' : ' stratégie'), 'info')),
    table([
      { label: 'Stratégia' },
      { label: 'Obchody', num: true },
      { label: 'Win rate', num: true },
      { label: 'Hrubé PnL', num: true },
      { label: 'Poplatky', num: true },
      { label: 'Čisté PnL', num: true },
      { label: 'Výnos z kapitálu', num: true },
    ], rows.map((row) => [
      row.strategyName,
      String(row.trades),
      fmtPct(row.winRate),
      fmtMoney(row.grossPnl, 2),
      fmtMoney(row.fees, 2),
      h('span', { class: signClass(row.netPnl) }, fmtMoney(row.netPnl, 2)),
      fmtPct(row.returnOnDeployedPct),
    ])));
}

/** Backtest history stored in the local SQLite database (Phase 4). */
function historyCard() {
  const card = h('div', { class: 'card' });
  card.append(h('div', { class: 'card-head' },
    h('h3', null, 'História (SQLite)'),
    pill('lokálna DB', 'info')));
  const body = h('div');
  card.append(body);

  const client = getBackendClient();
  if (!client) {
    body.append(h('div', { class: 'empty' },
      h('p', null, 'Backend nie je pripojený — história sa ukladá do lokálnej databázy.'),
      h('button', { class: 'btn', type: 'button', onclick: () => navigate('settings') }, 'Pripojiť backend v Nastaveniach')));
    return card;
  }

  const actions = h('div', { class: 'split' });
  if (state.backtest) {
    actions.append(h('button', {
      class: 'btn primary', type: 'button',
      onclick: () => { void saveCurrent(); },
    }, 'Uložiť aktuálny výsledok do DB'));
  }
  actions.append(h('button', { class: 'btn', type: 'button', onclick: () => { void refresh(); } }, 'Obnoviť zoznam'));
  body.append(actions);

  const listBox = h('div');
  body.append(listBox);

  async function saveCurrent() {
    try {
      const res = state.backtest;
      await client.saveBacktest({
        result: res,
        strategyName: res.strategyName,
        symbol: res.symbol ?? state.symbol,
        dataSource: 'ui',
      });
      toast('Backtest uložený do databázy', 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function refresh() {
    try {
      const data = await client.backtests({ limit: 25 });
      const rows = (data.runs ?? []).map((run) => [
        fmtDate(run.createdAt ?? run.created_at),
        run.strategyName ?? run.strategy_name ?? '—',
        run.symbol ?? '—',
        String(run.tradeCount ?? run.trade_count ?? 0),
        h('button', {
          class: 'icon-btn', type: 'button',
          onclick: () => { void (async () => {
            const yes = await confirmDialog('Zmazať tento uložený backtest z databázy?', { danger: true, confirmLabel: 'Zmazať' });
            if (!yes) return;
            try { await client.deleteBacktest(run.id); toast('Zmazané', 'ok'); await refresh(); }
            catch (err) { toast(err.message, 'err'); }
          })(); },
        }, '✕'),
      ]);
      listBox.replaceChildren(table(
        [{ label: 'Dátum' }, { label: 'Stratégia' }, { label: 'Symbol' }, { label: 'Obchody', num: true }, { label: '' }],
        rows,
        { empty: 'Žiadne uložené backtesty.' }));
    } catch (err) {
      listBox.replaceChildren(h('p', { class: 'neg' }, err.message));
    }
  }

  void refresh();
  return card;
}

/* -------------------------------------------------------------------- setup */

function setupCard() {
  const options = store.strategies.map((s) => ({ id: s.id, label: `${s.name} · ${s.symbol} ${s.timeframe}` }));
  const selectedId = state.editorStrategyId && store.getStrategy(state.editorStrategyId)
    ? state.editorStrategyId
    : options[0].id;

  const select = h('select', { onchange: (e) => { state.editorStrategyId = e.target.value; emit(); } });
  for (const o of options) {
    const opt = h('option', { value: o.id }, o.label);
    if (o.id === selectedId) opt.selected = true;
    select.append(opt);
  }

  const s = store.settings;
  const num = (label, value, key, attrs = {}) => h('label', { class: 'field' },
    h('span', null, label),
    h('input', {
      type: 'number', value, step: attrs.step ?? 'any', min: attrs.min, max: attrs.max,
      onchange: (e) => { store.updateSettings({ [key]: Number(e.target.value) }); },
    }));

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Nastavenia simulácie')),
    h('div', { class: 'grid cols-4' },
      h('label', { class: 'field' }, h('span', null, 'Stratégia'), select),
      num('Počiatočný kapitál (USDT)', s.startingCash, 'startingCash', { step: 100, min: 0 }),
      num('Poplatok % (taker)', s.feePct, 'feePct', { step: 0.01, min: 0 }),
      num('Slippage %', s.slippagePct, 'slippagePct', { step: 0.01, min: 0 }),
      num('Max. drawdown % (0 = vypnuté)', s.maxDrawdownPct, 'maxDrawdownPct', { min: 0 }),
      num('Max. denná strata % (0 = vypnuté)', s.maxDailyLossPct, 'maxDailyLossPct', { min: 0 }),
      num('Cooldown (sviečky)', s.cooldownBars ?? 0, 'cooldownBars', { min: 0, step: 1 }),
      h('label', { class: 'field' }, h('span', null, 'Dokupovanie (pyramiding)'),
        (() => {
          const el = h('select', { onchange: (e) => store.updateSettings({ allowPyramiding: e.target.value === 'yes' }) });
          el.append(h('option', { value: 'no' }, 'vypnuté'));
          const yes = h('option', { value: 'yes' }, 'zapnuté');
          if (store.settings.allowPyramiding) yes.selected = true;
          el.append(yes);
          return el;
        })())),
    h('div', { class: 'split', style: { marginTop: '.75rem' } },
      h('button', { class: 'btn primary', type: 'button', disabled: state.backtestRunning, onclick: runSelected }, state.backtestRunning ? 'Počítam…' : '▶ Spustiť backtest'),
      h('button', { class: 'btn', type: 'button', onclick: runComparison }, 'Porovnať všetky stratégie'),
      h('span', { class: 'muted small' }, 'Simulácia beží lokálne, bez sieťových volaní.')));
}

function runSelected() {
  const id = state.editorStrategyId ?? store.strategies[0].id;
  const strategy = store.getStrategy(id);
  if (!strategy) { toast('Stratégia sa nenašla', 'err'); return; }
  runBacktest(strategy);
}

function runBacktest(strategy) {
  state.backtestRunning = true;
  emit();
  try {
    const res = backtest({
      strategy,
      candles: state.candles,
      startingCash: store.settings.startingCash,
      feePct: store.settings.feePct,
      slippagePct: store.settings.slippagePct,
      allowPyramiding: store.settings.allowPyramiding,
      maxDrawdownPct: store.settings.maxDrawdownPct,
      maxDailyLossPct: store.settings.maxDailyLossPct,
      cooldownBars: store.settings.cooldownBars ?? 0,
    });
    state.backtest = { ...res, strategyId: strategy.id, strategyName: strategy.name };
    store.saveBacktest({
      strategyId: strategy.id,
      strategyName: strategy.name,
      symbol: res.symbol,
      timeframe: strategy.timeframe,
      metrics: res.metrics,
      tradeCount: res.trades.length,
    });
    toast(`Backtest dokončený: ${fmtPct(res.metrics.totalReturnPct)}`, res.metrics.totalReturnPct >= 0 ? 'ok' : 'warn');
  } catch (err) {
    toast(`Backtest zlyhal: ${err.message}`, 'err');
  } finally {
    state.backtestRunning = false;
    emit();
  }
}

function runComparison() {
  try {
    const results = compareStrategies({
      strategies: store.strategies,
      candles: state.candles,
      startingCash: store.settings.startingCash,
      feePct: store.settings.feePct,
      slippagePct: store.settings.slippagePct,
    });
    state.comparison = results;
    toast(`Porovnaných ${results.length} stratégií`, 'ok');
  } catch (err) {
    toast(`Porovnanie zlyhalo: ${err.message}`, 'err');
  }
  emit();
}

/* ------------------------------------------------------------------ results */

function resultsCard(res) {
  const m = res.metrics;
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, `Výsledky — ${res.strategyName ?? ''}`),
      h('div', { class: 'split' },
        pill(res.symbol, 'info'),
        pill(`${m.bars} sviečok`, 'idle'),
        pill(`warmup ${res.warmup}`, 'idle'))));

  if (res.warnings?.length) {
    card.append(h('div', { style: { marginBottom: '.6rem' } },
      ...res.warnings.map((w) => h('p', { class: 'warn small' }, `⚠ ${w}`))));
  }

  card.append(h('div', { class: 'grid cols-4' },
    stat('Celkový výnos', fmtPct(m.totalReturnPct), `konečný kapitál ${fmtMoney(m.finalEquity)}`, signClass(m.totalReturnPct)),
    stat('Čistý zisk', fmtMoney(m.netProfit), 'po poplatkoch', signClass(m.netProfit)),
    stat('CAGR', fmtPct(m.cagrPct), 'ročne', signClass(m.cagrPct)),
    stat('Max. drawdown', `-${fmtNum(m.maxDrawdownPct, 2)} %`, `trvanie ${fmtDuration(m.longestDrawdownMs)}`, m.maxDrawdownPct > 20 ? 'neg' : ''),
    stat('Sharpe', fmtNum(m.sharpe, 2), 'ročne (rf = 0)'),
    stat('Sortino', fmtNum(m.sortino, 2), `volatilita ${fmtNum(m.volatilityPct, 1)} %`),
    stat('Calmar', fmtNum(m.calmar, 2), 'CAGR / max DD'),
    stat('Expozícia', `${fmtNum(m.exposurePct, 1)} %`, 'času v pozícii')));

  card.append(h('div', { class: 'grid cols-4', style: { marginTop: '.6rem' } },
    stat('Obchody', String(m.trades), `${m.wins} ziskových / ${m.losses} stratových`),
    stat('Úspešnosť', `${fmtNum(m.winRatePct, 1)} %`, `expectancy ${fmtMoney(m.expectancy)}`, m.winRatePct >= 50 ? 'pos' : ''),
    stat('Profit factor', m.profitFactor === null ? '∞' : fmtNum(m.profitFactor, 2), `hrubý zisk ${fmtMoney(m.grossProfit)}`),
    stat('Payoff ratio', m.payoffRatio === null ? '∞' : fmtNum(m.payoffRatio, 2), `Ø zisk ${fmtMoney(m.avgWin)} / Ø strata ${fmtMoney(m.avgLoss)}`),
    stat('Max. séria ziskov', String(m.maxConsecutiveWins), 'v rade', 'pos'),
    stat('Max. séria strát', String(m.maxConsecutiveLosses), 'v rade', m.maxConsecutiveLosses > 5 ? 'neg' : ''),
    stat('Poplatky', fmtMoney(m.feesPaid), 'spolu zaplatené'),
    stat('Buy & hold', m.benchmarkReturnPct === null ? '—' : fmtPct(m.benchmarkReturnPct), m.alphaPct === null ? '' : `alfa ${fmtPct(m.alphaPct)}`, signClass(m.benchmarkReturnPct ?? 0))));

  return card;
}

function chartsCard(res) {
  equityCanvas = h('canvas', { style: { height: '260px' } });
  monthlyCanvas = h('canvas', { style: { height: '180px' } });
  priceCanvas = h('canvas', { style: { height: '300px' } });

  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Krivka kapitálu')),
    h('div', { class: 'chart-box' }, equityCanvas),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: '#f0b90b' } }), 'Stratégia'),
      h('span', null, h('i', { style: { background: '#4c9aff' } }), 'Buy & hold (referencia)')));

  card.append(h('div', { class: 'card-head', style: { marginTop: '1rem' } }, h('h3', null, 'Mesačné výnosy')),
    h('div', { class: 'chart-box' }, monthlyCanvas));
  card.append(h('div', { class: 'card-head', style: { marginTop: '1rem' } }, h('h3', null, 'Vstupy a výstupy na grafe')),
    h('div', { class: 'chart-box' }, priceCanvas));
  return card;
}

function tradesCard(res) {
  const rows = res.trades.map((t) => [
    fmtDate(t.openedAt),
    fmtDate(t.closedAt),
    fmtQty(t.qty),
    fmtNum(t.entryPrice, 4),
    fmtNum(t.exitPrice, 4),
    h('span', { class: signClass(t.pnl) }, fmtMoney(t.pnl)),
    h('span', { class: signClass(t.pnlPct) }, fmtPct(t.pnlPct)),
    fmtDuration(t.durationMs),
    t.reason,
  ]);
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, `Obchody (${res.trades.length})`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => exportTrades(res) }, 'Export CSV'),
        h('button', { class: 'btn small', type: 'button', onclick: () => exportReport(res) }, 'Export reportu JSON'))),
    table([
      { label: 'Otvorené' }, { label: 'Zatvorené' }, { label: 'Množstvo', num: true },
      { label: 'Vstup', num: true }, { label: 'Výstup', num: true }, { label: 'PnL', num: true },
      { label: 'PnL %', num: true }, { label: 'Trvanie' }, { label: 'Dôvod' },
    ], rows, { empty: 'Stratégia počas tohto obdobia neobchodovala.' }));
}

function activityCard(res) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Priebeh simulácie')));

  if (state.comparison?.length) {
    card.append(h('h4', null, 'Porovnanie stratégií'));
    card.append(table(
      [{ label: 'Stratégia' }, { label: 'Výnos', num: true }, { label: 'Max DD', num: true }, { label: 'Sharpe', num: true }, { label: 'Obchody', num: true }],
      state.comparison.map((c) => [
        c.name,
        h('span', { class: signClass(c.metrics?.totalReturnPct ?? 0) }, fmtPct(c.metrics?.totalReturnPct ?? 0)),
        `${fmtNum(c.metrics?.maxDrawdownPct ?? 0, 2)} %`,
        fmtNum(c.metrics?.sharpe ?? 0, 2),
        String(c.metrics?.trades ?? 0),
      ])));
  }

  card.append(h('h4', null, `Signály (${res.signals.length})`));
  card.append(table(
    [{ label: 'Čas' }, { label: 'Pravidlo' }, { label: 'Cena', num: true }, { label: 'Akcie' }],
    res.signals.slice(-60).reverse().map((s) => [
      fmtDate(s.time), s.ruleName ?? s.message ?? '—', fmtNum(s.price ?? 0, 4),
      (s.actions ?? []).map((a) => `${a.type}:${a.status}`).join(', ') || '—',
    ])));

  card.append(h('h4', null, `Príkazy (${res.orders.length})`));
  card.append(table(
    [{ label: 'ID' }, { label: 'Strana' }, { label: 'Typ' }, { label: 'Množstvo', num: true }, { label: 'Naplnené', num: true }, { label: 'Ø cena', num: true }, { label: 'Stav' }, { label: 'Dôvod' }],
    res.orders.slice(-80).reverse().map((o) => [
      o.id, o.side, o.type, fmtQty(o.qty), fmtQty(o.filledQty),
      o.avgFillPrice ? fmtNum(o.avgFillPrice, 4) : '—', o.status, o.reason,
    ])));

  return card;
}

function exportTrades(res) {
  const header = 'openedAt,closedAt,qty,entryPrice,exitPrice,pnl,pnlPct,fees,reason';
  const lines = res.trades.map((t) => [
    new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString(),
    t.qty, t.entryPrice, t.exitPrice, t.pnl, t.pnlPct, t.fees, t.reason,
  ].join(','));
  download(`backtest-${res.symbol}-trades.csv`, [header, ...lines].join('\n'), 'text/csv');
  toast('CSV exportované', 'ok');
}

function exportReport(res) {
  download(`backtest-${res.symbol}.json`, JSON.stringify({
    strategy: res.strategyName,
    symbol: res.symbol,
    metrics: res.metrics,
    trades: res.trades,
    signals: res.signals,
  }, null, 2));
  toast('Report exportovaný', 'ok');
}

/* ------------------------------------------------------------------- mount */

export function afterMount() {
  const res = state.backtest;
  if (!res) return;
  if (equityCanvas) drawEquity(equityCanvas, res.equityCurve, { height: 260, benchmark: res.candles ? res.candles.map((c) => ({ time: c.time, price: c.close })) : null });
  if (monthlyCanvas) {
    const months = res.metrics.monthly ?? [];
    drawBars(monthlyCanvas, months.map((m) => ({ label: m.month, value: m.returnPct })), { height: 180 });
  }
  if (priceCanvas) {
    const closes = res.candles.map((c) => c.close);
    const startIndex = Math.max(0, res.candles.length - res.equityCurve.length + 1);
    const indexOfTime = new Map(res.candles.map((c, i) => [c.time, i]));
    const markers = [];
    for (const t of res.trades) {
      const oi = indexOfTime.get(t.openedAt);
      const ci = indexOfTime.get(t.closedAt);
      if (oi !== undefined) markers.push({ index: oi, price: t.entryPrice, side: 'buy' });
      if (ci !== undefined) markers.push({ index: ci, price: t.exitPrice, side: 'sell' });
    }
    drawCandles(priceCanvas, {
      candles: res.candles.slice(-Math.max(120, res.candles.length - startIndex)),
      overlays: [
        { label: 'SMA 20', series: sma(closes, 20).slice(-Math.max(120, res.candles.length - startIndex)) },
        { label: 'EMA 50', series: ema(closes, 50).slice(-Math.max(120, res.candles.length - startIndex)) },
      ],
      markers: markers.slice(-Math.max(120, res.candles.length - startIndex)),
      height: 300,
    });
  }
}
