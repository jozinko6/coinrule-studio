/** trades.js — portfolio ledger, trade history and backtest archive. */

import { h, stat, table, pill, toast, download, fmtNum, fmtMoney, fmtPct, fmtQty, fmtDate, fmtDuration, signClass } from '../dom.js';
import { state, store, emit, navigate } from '../state.js';
import { tradeStats, computeMetrics } from '../../core/metrics.js';
import { drawBars } from '../charts.js';

let barsCanvas = null;

export function render() {
  const wrap = h('div');
  const engine = state.engine;

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Obchody a portfólio'),
      h('p', { class: 'muted small' }, 'Kompletný denník virtuálneho účtu a archív backtestov.')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => navigate('paper') }, 'Panel obchodovania'),
      h('button', { class: 'btn', type: 'button', onclick: exportAll }, 'Export všetkého'))));

  if (!engine) {
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'empty' },
      'Session ešte nebežala. Spusti virtuálne obchodovanie a tu sa objaví celý denník.',
      h('p', null, h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('paper') }, 'Spustiť obchodovanie')))));
  } else {
    const portfolio = engine.portfolio;
    const snap = engine.snapshot();
    const stats = tradeStats(engine.broker.trades);
    const price = engine.broker.lastPrice;

    wrap.append(h('div', { class: 'grid cols-4' },
      stat('Kapitál', fmtMoney(snap.equity), `hotovosť ${fmtMoney(snap.cash)}`),
      stat('Realizovaný PnL', fmtMoney(portfolio.realizedPnl), `poplatky ${fmtMoney(portfolio.feesPaid)}`, signClass(portfolio.realizedPnl)),
      stat('Max. drawdown', `${fmtNum(portfolio.maxDrawdownPct, 2)} %`, 'od peaku kapitálu', portfolio.maxDrawdownPct > 15 ? 'neg' : ''),
      stat('Expozícia', `${fmtNum(portfolio.exposurePct(price), 1)} %`, `${portfolio.openPositions.length} pozícií`)));

    wrap.append(h('div', { class: 'grid cols-4' },
      stat('Obchody', String(stats.trades), `${stats.wins} / ${stats.losses}`),
      stat('Úspešnosť', `${fmtNum(stats.winRatePct, 1)} %`, `expectancy ${fmtMoney(stats.expectancy)}`),
      stat('Profit factor', stats.profitFactor === null ? '∞' : fmtNum(stats.profitFactor, 2), `Ø zisk ${fmtMoney(stats.avgWin)}`),
      stat('Ø PnL %', fmtPct(stats.avgPnlPct), `Ø trvanie ${fmtDuration(stats.avgDurationMs)}`)));

    barsCanvas = h('canvas', { style: { height: '160px' } });
    wrap.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Kapitál session')),
      h('div', { class: 'chart-box' }, barsCanvas),
      h('div', { class: 'legend' }, h('span', null, 'Zelené stĺpce = kladné zmeny kapitálu, červené = záporné.'))));

    wrap.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, `Denník (${engine.broker.trades.length} obchodov)`),
        h('button', {
          class: 'btn small', type: 'button',
          onclick: () => { download('trades.csv', toCsv(engine.broker.trades), 'text/csv'); toast('CSV exportované', 'ok'); },
        }, 'Export CSV')),
      table([
        { label: 'Zatvorené' }, { label: 'Pár' }, { label: 'Množstvo', num: true }, { label: 'Vstup', num: true },
        { label: 'Výstup', num: true }, { label: 'PnL', num: true }, { label: 'PnL %', num: true },
        { label: 'Poplatky', num: true }, { label: 'Trvanie' }, { label: 'Dôvod' },
      ], [...engine.broker.trades].reverse().map((t) => [
        fmtDate(t.closedAt), t.symbol, fmtQty(t.qty), fmtNum(t.entryPrice, 4), fmtNum(t.exitPrice, 4),
        h('span', { class: signClass(t.pnl) }, fmtMoney(t.pnl)),
        h('span', { class: signClass(t.pnlPct) }, fmtPct(t.pnlPct)),
        fmtMoney(t.fees, 4), fmtDuration(t.durationMs), t.reason,
      ]), { empty: 'Žiadne obchody.' })));

    wrap.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Peňažný denník (ledger)')),
      table([{ label: 'Čas' }, { label: 'Typ' }, { label: 'Suma', num: true }, { label: 'Hotovosť po', num: true }, { label: 'Poznámka' }],
        [...(portfolio.ledger ?? [])].slice(-80).reverse().map((e) => [
          fmtDate(e.at ?? e.time), e.type,
          fmtMoney(e.amount ?? e.realized ?? 0, 4),
          e.cash !== undefined ? fmtMoney(e.cash) : '—',
          e.reason ?? e.note ?? (e.qty ? `${fmtQty(e.qty)} @ ${fmtNum(e.price, 4)}` : ''),
        ]), { empty: 'Denník je prázdny.' })));
  }

  /* ------------------------------------------------------- backtest archive */
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Archív backtestov')),
    table([
      { label: 'Kedy' }, { label: 'Stratégia' }, { label: 'Pár' }, { label: 'TF' },
      { label: 'Výnos', num: true }, { label: 'Max DD', num: true }, { label: 'Sharpe', num: true }, { label: 'Obchody', num: true },
    ], (store.state.backtests ?? []).map((b) => [
      fmtDate(b.at), b.strategyName, b.symbol, b.timeframe,
      h('span', { class: signClass(b.metrics?.totalReturnPct ?? 0) }, fmtPct(b.metrics?.totalReturnPct ?? 0)),
      `${fmtNum(b.metrics?.maxDrawdownPct ?? 0, 2)} %`,
      fmtNum(b.metrics?.sharpe ?? 0, 2),
      String(b.tradeCount ?? 0),
    ]), { empty: 'Zatiaľ žiadne backtesty.' })));

  return wrap;
}

function toCsv(trades) {
  const header = 'closedAt,symbol,qty,entryPrice,exitPrice,pnl,pnlPct,fees,reason';
  return [header, ...trades.map((t) => [
    new Date(t.closedAt).toISOString(), t.symbol, t.qty, t.entryPrice, t.exitPrice, t.pnl, t.pnlPct, t.fees, t.reason,
  ].join(','))].join('\n');
}

function exportAll() {
  const payload = {
    exportedAt: new Date(0).toISOString(),
    settings: store.settings,
    strategies: store.strategies,
    backtests: store.state.backtests,
    session: state.engine ? state.engine.toJSON() : null,
  };
  download('coinrule-studio-export.json', JSON.stringify(payload, null, 2));
  toast('Export hotový', 'ok');
}

export function afterMount() {
  const engine = state.engine;
  if (!barsCanvas || !engine || engine.equityCurve.length < 3) return;
  const points = engine.equityCurve;
  const changes = [];
  for (let i = 1; i < points.length; i += 1) {
    changes.push({ label: `${i}`, value: ((points[i].equity - points[i - 1].equity) / points[i - 1].equity) * 100 });
  }
  drawBars(barsCanvas, changes.slice(-80), { height: 160 });
}
