/** strategies.js — template library browser + saved strategies. */

import { h, table, pill, toast, confirmDialog, download, button, modal, pickFile, mount } from '../dom.js';
import { state, store, emit, navigate, openInEditor, ensureEngine } from '../state.js';
import {
  STRATEGY_LIBRARY, STRATEGY_FAMILIES, STRATEGY_COUNT,
  instantiate, searchTemplates, getTemplate,
} from '../../core/strategies.js';
import { describeRule, validateStrategy } from '../../core/rules.js';

export function render() {
  const wrap = h('div');

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Stratégie'),
      h('p', { class: 'muted small' }, `${STRATEGY_COUNT} hotových šablón + ${store.strategies.length} vlastných stratégií`)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => createBlank() }, '＋ Nová stratégia'),
      h('button', { class: 'btn', type: 'button', onclick: importStrategy }, 'Importovať JSON'))));

  /* ------------------------------------------------------- saved strategies */
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Moje stratégie')),
    table(
      [{ label: 'Názov' }, { label: 'Pár' }, { label: 'TF' }, { label: 'Pravidlá', num: true }, { label: 'Stav' }, { label: 'Akcie' }],
      store.strategies.map((s) => {
        const v = validateStrategy(s);
        return [
          h('a', { href: '#/editor', onclick: (e) => { e.preventDefault(); openInEditor(s.id); } }, s.name),
          s.symbol,
          s.timeframe,
          String(s.rules?.length ?? 0),
          v.ok ? pill('platná', 'ok') : pill(`${v.errors.length} chýb`, 'err'),
          h('div', { class: 'split' },
            button('Upraviť', () => openInEditor(s.id), 'btn small'),
            button('Backtest', () => { state.editorStrategyId = s.id; navigate('backtest'); }, 'btn small'),
            button('Kópia', () => { store.duplicateStrategy(s.id); toast('Stratégia skopírovaná', 'ok'); emit(); }, 'btn small'),
            button('Export', () => download(`${s.id}.json`, JSON.stringify({ schema: 2, strategy: s }, null, 2)), 'btn small'),
            button('Zmazať', async () => {
              if (await confirmDialog(`Zmazať stratégiu „${s.name}“?`, { danger: true, confirmLabel: 'Zmazať' })) {
                store.removeStrategy(s.id);
                toast('Stratégia zmazaná', 'ok');
                emit();
              }
            }, 'btn small danger')),
        ];
      }),
      { empty: 'Zatiaľ nemáš vlastnú stratégiu. Vyber šablónu nižšie alebo vytvor novú.' })));

  /* ------------------------------------------------------------- templates */
  const filters = h('div', { class: 'family-filter' });
  const filterButtons = [];
  const setFilter = (id) => {
    state.strategyFilter = id;
    for (const [btnId, btn] of filterButtons) btn.classList.toggle('active', btnId === id);
    refresh();
  };
  const allBtn = h('button', { class: state.strategyFilter === 'all' ? 'active' : '', type: 'button', onclick: () => setFilter('all') }, `Všetky (${STRATEGY_COUNT})`);
  filterButtons.push(['all', allBtn]);
  filters.append(allBtn);
  for (const fam of STRATEGY_FAMILIES) {
    const count = STRATEGY_LIBRARY.filter((s) => s.family === fam.id).length;
    const btn = h('button', {
      class: state.strategyFilter === fam.id ? 'active' : '',
      type: 'button',
      onclick: () => setFilter(fam.id),
    }, `${fam.label} (${count})`);
    filterButtons.push([fam.id, btn]);
    filters.append(btn);
  }

  // The search box filters the grid in place so the input keeps focus while typing.
  const grid = h('div', { class: 'strategy-grid' });
  const empty = h('div', { class: 'empty hidden' }, 'Pre tento filter sa nič nenašlo.');
  const countLabel = h('span', { class: 'muted small' });

  const refresh = () => {
    let list = state.strategyQuery ? searchTemplates(state.strategyQuery) : STRATEGY_LIBRARY.map((s) => s);
    if (state.strategyFilter !== 'all') list = list.filter((s) => s.family === state.strategyFilter);
    mount(grid, ...list.map(templateCard));
    grid.classList.toggle('hidden', list.length === 0);
    empty.classList.toggle('hidden', list.length > 0);
    countLabel.textContent = `${list.length} z ${STRATEGY_COUNT} šablón`;
  };

  const search = h('input', {
    type: 'search',
    placeholder: 'Hľadať podľa názvu, popisu alebo tagu…',
    value: state.strategyQuery,
    oninput: (e) => { state.strategyQuery = e.target.value; refresh(); },
  });

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, 'Knižnica šablón'),
      h('div', { class: 'split', style: { minWidth: '280px' } }, search, countLabel)),
    filters,
    grid,
    empty));

  refresh();
  return wrap;
}

function templateCard(t) {
  const isFav = (store.state.favourites ?? []).includes(t.id);
  return h('div', { class: 'strategy-card' },
    h('div', { class: 'split' },
      h('h4', null, t.name),
      h('span', { class: 'spacer' }),
      pill(`riziko ${t.riskLevel}/5`, t.riskLevel >= 4 ? 'err' : t.riskLevel === 3 ? 'warn' : 'ok')),
    h('p', null, t.description),
    h('div', null,
      h('span', { class: 'tag' }, t.family),
      h('span', { class: 'tag' }, t.timeframe),
      ...(t.tags ?? []).slice(0, 2).map((tag) => h('span', { class: 'tag' }, tag))),
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn small primary', type: 'button', onclick: () => useTemplate(t.id) }, 'Použiť'),
      h('button', { class: 'btn small', type: 'button', onclick: () => showRules(t.id) }, 'Pravidlá'),
      h('button', { class: 'btn small', type: 'button', onclick: () => toggleFav(t.id) }, isFav ? '★' : '☆')));
}

function toggleFav(id) {
  store.toggleFavourite(id);
  emit();
}

function useTemplate(id) {
  const strategy = instantiate(id, { symbol: state.symbol, timeframe: state.timeframe });
  strategy.name = `${getTemplate(id).name} · ${state.symbol}`;
  store.upsertStrategy(strategy);
  toast('Stratégia pridaná do tvojich stratégií', 'ok');
  openInEditor(strategy.id);
}

function showRules(id) {
  const t = getTemplate(id);
  const rows = t.rules.map((r) => [r.name, h('span', { class: 'mono small' }, describeRule(r))]);
  modal({
    title: `${t.name} — pravidlá`,
    wide: true,
    body: h('div', null,
      h('p', { class: 'muted small' }, t.description),
      table([{ label: 'Pravidlo' }, { label: 'Definícia' }], rows),
      h('p', { class: 'muted small' }, `Odporúčaný timeframe: ${t.timeframe} · rodina: ${t.family} · riziko: ${t.riskLevel}/5`)),
    actions: [
      { label: 'Zavrieť' },
      { label: 'Použiť šablónu', class: 'btn primary', onClick: () => { useTemplate(id); return false; } },
    ],
  });
}

function createBlank() {
  import('../../core/rules.js').then(({ createStrategy }) => {
    const s = createStrategy({ name: 'Moja stratégia', symbol: state.symbol, timeframe: state.timeframe });
    store.upsertStrategy(s);
    toast('Nová stratégia vytvorená', 'ok');
    openInEditor(s.id);
  });
}

async function importStrategy() {
  const file = await pickFile('.json');
  if (!file) return;
  try {
    const parsed = JSON.parse(file.text);
    const raw = parsed.strategy ?? parsed;
    const { strategyFromJSON } = await import('../../core/rules.js');
    const strategy = strategyFromJSON(raw);
    strategy.id = `${strategy.id}_${Math.random().toString(36).slice(2, 6)}`;
    store.upsertStrategy(strategy);
    toast(`Importovaná stratégia „${strategy.name}“`, 'ok');
    emit();
  } catch (err) {
    toast(`Import zlyhal: ${err.message}`, 'err');
  }
}
