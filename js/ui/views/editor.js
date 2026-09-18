/**
 * editor.js — the visual rule builder (the heart of a Coinrule-style app).
 *
 * Edits a strategy document in place: meta, nested AND/OR/NOT condition groups
 * and the action list, with a live human-readable preview and validation.
 */

import { h, table, pill, toast, confirmDialog, download } from '../dom.js';
import { state, store, emit, navigate, currentStrategy, openInEditor } from '../state.js';
import {
  OPERATORS, CONDITION_KINDS, ACTION_TYPES, ENTRY_SIZING_MODES, EXIT_SIZING_MODES,
  TIMEFRAMES, INDICATOR_REGISTRY, createCondition, createGroup, createRule,
  describeCondition, describeRule, describeAction,
  validateStrategy, strategyToJSON, strategyFromJSON,
} from '../../core/rules.js';

const PATTERNS = [
  'doji', 'hammer', 'hanging_man', 'inverted_hammer', 'shooting_star',
  'bullish_marubozu', 'bearish_marubozu', 'bullish_engulfing', 'bearish_engulfing',
  'piercing_line', 'dark_cloud_cover', 'bullish_harami', 'bearish_harami',
  'morning_star', 'evening_star', 'three_white_soldiers', 'three_black_crows',
];

const DIVERGENCES = ['bullish', 'bearish', 'hidden_bullish', 'hidden_bearish'];

const POSITION_STATES = [
  { id: 'none', label: 'žiadna pozícia' },
  { id: 'open', label: 'otvorená pozícia' },
  { id: 'profit_pct', label: 'zisk ≥ X %' },
  { id: 'loss_pct', label: 'strata ≥ X %' },
  { id: 'pnl_above', label: 'PnL > X %' },
  { id: 'pnl_below', label: 'PnL < X %' },
  { id: 'equity_above', label: 'kapitál > X' },
  { id: 'cash_above', label: 'hotovosť > X' },
  { id: 'drawdown_above', label: 'drawdown portfólia ≥ X %' },
];

const sel = (options, value, onChange) => {
  const el = h('select', { onchange: (e) => onChange(e.target.value) });
  for (const o of options) {
    const opt = h('option', { value: o.id ?? o.value }, o.label);
    if (String(o.id ?? o.value) === String(value)) opt.selected = true;
    el.append(opt);
  }
  return el;
};

const numIn = (value, onChange, attrs = {}) => h('input', {
  type: 'number', value: value ?? 0, step: attrs.step ?? 'any', ...attrs,
  onchange: (e) => onChange(Number(e.target.value)),
});

const txtIn = (value, onChange, attrs = {}) => h('input', {
  type: 'text', value: value ?? '', ...attrs,
  oninput: (e) => onChange(e.target.value),
});

/* -------------------------------------------------------------------- view */

export function render() {
  const wrap = h('div');
  const strategy = currentStrategy();

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Editor pravidiel'),
      h('p', { class: 'muted small' }, strategy ? `Upravuješ: ${strategy.name}` : 'Vyber alebo vytvor stratégiu')),
    h('div', { class: 'actions' },
      strategy ? h('button', { class: 'btn', type: 'button', onclick: () => navigate('strategies') }, 'Prehľad stratégií') : null,
      strategy ? h('button', { class: 'btn', type: 'button', onclick: () => { state.editorStrategyId = strategy.id; navigate('backtest'); } }, 'Spustiť backtest') : null,
      strategy ? h('button', { class: 'btn', type: 'button', onclick: () => duplicateCurrent(strategy) }, 'Duplikovať') : null)));

  if (!strategy) {
    wrap.append(h('div', { class: 'card' },
      h('div', { class: 'empty' },
        h('p', null, 'Žiadna stratégia nie je otvorená.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('strategies') }, 'Vybrať šablónu'))));
    return wrap;
  }

  wrap.append(metaCard(strategy));
  wrap.append(rulesCard(strategy));
  wrap.append(validationCard(strategy));
  return wrap;
}

function duplicateCurrent(strategy) {
  const copy = store.duplicateStrategy(strategy.id);
  if (copy) { openInEditor(copy.id); toast('Vytvorená kópia', 'ok'); }
}

/** Persist + re-render (structural change). */
function commit(strategy, { rerender = true } = {}) {
  store.upsertStrategy(strategy);
  if (rerender) emit();
}

/* -------------------------------------------------------------------- meta */

function metaCard(strategy) {
  const set = (patch, rerender = false) => {
    Object.assign(strategy, patch);
    commit(strategy, { rerender });
  };
  const setRisk = (patch) => {
    strategy.risk = { ...(strategy.risk ?? {}), ...patch };
    commit(strategy, { rerender: false });
  };

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Základné nastavenia')),
    h('div', { class: 'grid cols-4' },
      h('label', { class: 'field' }, h('span', null, 'Názov'), txtIn(strategy.name, (v) => set({ name: v }))),
      h('label', { class: 'field' }, h('span', null, 'Obchodný pár'), txtIn(strategy.symbol, (v) => set({ symbol: v.toUpperCase() }))),
      h('label', { class: 'field' }, h('span', null, 'Timeframe'), sel(TIMEFRAMES.map((t) => ({ id: t, label: t })), strategy.timeframe, (v) => set({ timeframe: v }))),
      h('label', { class: 'field' }, h('span', null, 'Stav'),
        sel([{ id: 'on', label: 'aktívna' }, { id: 'off', label: 'vypnutá' }], strategy.enabled === false ? 'off' : 'on', (v) => set({ enabled: v === 'on' })))),
    h('label', { class: 'field', style: { marginTop: '.6rem' } }, h('span', null, 'Popis'),
      txtIn(strategy.description ?? '', (v) => set({ description: v }))),
    h('h4', null, 'Riadenie rizika'),
    h('div', { class: 'grid cols-4' },
      h('label', { class: 'field' }, h('span', null, 'Max. veľkosť pozície %'), numIn(strategy.risk?.maxPositionPct ?? 100, (v) => setRisk({ maxPositionPct: v }))),
      h('label', { class: 'field' }, h('span', null, 'Max. otvorených pozícií'), numIn(strategy.risk?.maxOpenPositions ?? 1, (v) => setRisk({ maxOpenPositions: v }), { step: 1, min: 1 })),
      h('label', { class: 'field' }, h('span', null, 'Stop-loss % (pre sizing)'), numIn(strategy.risk?.stopLossPct ?? 5, (v) => setRisk({ stopLossPct: v }))),
      h('label', { class: 'field' }, h('span', null, 'Take-profit % (pre sizing)'), numIn(strategy.risk?.takeProfitPct ?? 10, (v) => setRisk({ takeProfitPct: v }))),
      h('label', { class: 'field' }, h('span', null, 'Cooldown (sviečky)'), numIn(strategy.risk?.cooldownBars ?? 0, (v) => setRisk({ cooldownBars: v }), { step: 1, min: 0 })),
      h('label', { class: 'field' }, h('span', null, 'Max. denná strata %'), numIn(strategy.risk?.maxDailyLossPct ?? 0, (v) => setRisk({ maxDailyLossPct: v }))),
      h('label', { class: 'field' }, h('span', null, 'Max. drawdown %'), numIn(strategy.risk?.maxDrawdownPct ?? 0, (v) => setRisk({ maxDrawdownPct: v }))),
      h('label', { class: 'field' }, h('span', null, 'Povoliť dokupovanie'),
        sel([{ id: 'no', label: 'nie (jedna pozícia)' }, { id: 'yes', label: 'áno (pyramiding)' }], strategy.allowPyramiding ? 'yes' : 'no', (v) => set({ allowPyramiding: v === 'yes' })))));
}

/* ------------------------------------------------------------------- rules */

function rulesCard(strategy) {
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, `Pravidlá (${strategy.rules.length})`),
      h('button', {
        class: 'btn primary small', type: 'button',
        onclick: () => { strategy.rules.push(createRule({ name: `Pravidlo ${strategy.rules.length + 1}` })); commit(strategy); },
      }, '＋ Pravidlo')));

  strategy.rules.forEach((rule, index) => {
    card.append(ruleBlock(strategy, rule, index));
  });
  return card;
}

function ruleBlock(strategy, rule, index) {
  const block = h('div', { class: 'rule-block' });

  block.append(h('div', { class: 'rule-head' },
    h('span', { class: 'mono muted small' }, `#${index + 1}`),
    txtIn(rule.name, (v) => { rule.name = v; commit(strategy, { rerender: false }); }, { 'aria-label': 'Názov pravidla' }),
    h('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '.3rem' } },
      h('input', {
        type: 'checkbox', checked: rule.enabled !== false,
        onchange: (e) => { rule.enabled = e.target.checked; commit(strategy, { rerender: false }); },
      }), h('span', null, 'aktívne')),
    h('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '.3rem' } },
      h('input', {
        type: 'checkbox', checked: !!rule.oneShot,
        onchange: (e) => { rule.oneShot = e.target.checked; commit(strategy, { rerender: false }); },
      }), h('span', null, 'len raz')),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn small danger', type: 'button',
      onclick: async () => {
        if (await confirmDialog(`Zmazať pravidlo „${rule.name}“?`, { danger: true, confirmLabel: 'Zmazať' })) {
          strategy.rules.splice(index, 1);
          commit(strategy);
        }
      },
    }, 'Zmazať')));

  block.append(h('div', { class: 'split' },
    h('label', { class: 'field' }, h('span', null, 'Cooldown (sviečky)'),
      numIn(rule.cooldownBars ?? 0, (v) => { rule.cooldownBars = v; commit(strategy, { rerender: false }); }, { min: 0, step: 1, style: { width: '90px' } })),
    h('label', { class: 'field' }, h('span', null, 'Max. počet spustení (0 = ∞)'),
      numIn(rule.maxTriggers ?? 0, (v) => { rule.maxTriggers = v; commit(strategy, { rerender: false }); }, { min: 0, step: 1, style: { width: '90px' } }))));

  block.append(h('h4', null, 'AK (podmienky)'));
  block.append(groupEditor(strategy, rule.when, () => commit(strategy)));

  block.append(h('h4', null, 'POTOM (akcie)'));
  block.append(actionsEditor(strategy, rule));

  block.append(h('div', { class: 'preview', style: { marginTop: '.5rem' } }, describeRule(rule)));
  return block;
}

/* ------------------------------------------------------------- group editor */

function groupEditor(strategy, group, rerender) {
  const box = h('div', { class: `group ${group.logic === 'OR' ? 'or' : group.logic === 'NOT' ? 'not' : ''}` });

  box.append(h('div', { class: 'group-head' },
    h('span', { class: 'small muted' }, 'Logika:'),
    sel([{ id: 'AND', label: 'A ZÁROVEŇ (AND)' }, { id: 'OR', label: 'ALEBO (OR)' }, { id: 'NOT', label: 'NIE (NOT)' }],
      group.logic, (v) => { group.logic = v; rerender(); }),
    h('button', {
      class: 'btn small', type: 'button',
      onclick: () => { group.items.push(createCondition()); rerender(); },
    }, '＋ Podmienka'),
    h('button', {
      class: 'btn small', type: 'button',
      onclick: () => { group.items.push(createGroup('AND', [createCondition()])); rerender(); },
    }, '＋ Podskupina')));

  if (!group.items.length) box.append(h('p', { class: 'muted small' }, 'Skupina je prázdna — pridaj aspoň jednu podmienku.'));

  group.items.forEach((item, i) => {
    const row = h('div', { class: 'split', style: { alignItems: 'flex-start' } });
    if (item.kind === 'group') {
      row.append(groupEditor(strategy, item, rerender));
    } else {
      row.append(conditionEditor(strategy, item, rerender));
    }
    row.append(h('button', {
      class: 'icon-btn', type: 'button', title: 'Odstrániť',
      onclick: () => { group.items.splice(i, 1); rerender(); },
    }, '✕'));
    box.append(row);
  });

  return box;
}

/* --------------------------------------------------------- condition editor */

function conditionEditor(strategy, cond, rerender) {
  const box = h('div', { style: { flex: '1 1 320px' } });
  const kind = cond.type ?? 'compare';

  box.append(h('div', { class: 'cond-row' },
    h('span', { class: 'small muted' }, 'Typ:'),
    sel(CONDITION_KINDS, kind, (v) => {
      cond.type = v;
      if (v === 'change_pct' && cond.value === undefined) { cond.op = 'lt'; cond.value = 5; cond.bars = 6; }
      if (v === 'position' && !cond.state) cond.state = 'profit_pct';
      if (v === 'divergence' && !cond.oscillator) cond.oscillator = { kind: 'indicator', id: 'rsi', params: { period: 14 } };
      if (v === 'pattern' && !cond.pattern) cond.pattern = 'bullish_engulfing';
      rerender();
    })));

  switch (kind) {
    case 'always':
      box.append(h('p', { class: 'muted small' }, 'Podmienka je vždy splnená (použi s cooldownom ako časovač).'));
      break;

    case 'change_pct':
      box.append(h('div', { class: 'cond-row' },
        h('span', { class: 'small muted' }, 'Cena'),
        sel([{ id: 'lt', label: 'klesne o aspoň' }, { id: 'gt', label: 'stúpne o aspoň' }, { id: 'between', label: 'je medzi' }],
          cond.op ?? 'lt', (v) => { cond.op = v; commit(strategy, { rerender: false }); }),
        numIn(cond.value ?? 5, (v) => { cond.value = v; commit(strategy, { rerender: false }); }, { style: { width: '90px' } }),
        h('span', { class: 'small muted' }, '% za'),
        numIn(cond.bars ?? 6, (v) => { cond.bars = v; commit(strategy, { rerender: false }); }, { style: { width: '80px' }, min: 1, step: 1 }),
        h('span', { class: 'small muted' }, 'sviečok')));
      break;

    case 'pattern':
      box.append(h('div', { class: 'cond-row' },
        h('span', { class: 'small muted' }, 'Sviečkový pattern:'),
        sel(PATTERNS.map((p) => ({ id: p, label: p })), cond.pattern, (v) => { cond.pattern = v; commit(strategy, { rerender: false }); })));
      break;

    case 'divergence':
      box.append(h('div', { class: 'cond-row' },
        h('span', { class: 'small muted' }, 'Divergencia:'),
        sel(DIVERGENCES.map((d) => ({ id: d, label: d })), cond.divergenceType ?? 'bullish', (v) => { cond.divergenceType = v; commit(strategy, { rerender: false }); }),
        h('span', { class: 'small muted' }, 'na oscilátore:'),
        operandEditor(cond.oscillator ?? { kind: 'indicator', id: 'rsi', params: { period: 14 } }, (op) => { cond.oscillator = op; }, { allowConst: false, allowPrice: false, onChange: rerender })));
      break;

    case 'position':
      box.append(h('div', { class: 'cond-row' },
        h('span', { class: 'small muted' }, 'Stav:'),
        sel(POSITION_STATES, cond.state ?? 'profit_pct', (v) => { cond.state = v; commit(strategy, { rerender: false }); }),
        h('span', { class: 'small muted' }, 'hodnota:'),
        numIn(cond.value ?? 5, (v) => { cond.value = v; commit(strategy, { rerender: false }); }, { style: { width: '100px' } })));
      break;

    case 'time': {
      const days = cond.days ?? [];
      const dayRow = h('div', { class: 'cond-row' }, h('span', { class: 'small muted' }, 'Dni (UTC):'));
      for (const [idx, label] of [[1, 'Po'], [2, 'Ut'], [3, 'St'], [4, 'Št'], [5, 'Pi'], [6, 'So'], [0, 'Ne']]) {
        dayRow.append(h('label', { class: 'field', style: { flexDirection: 'row', gap: '.2rem' } },
          h('input', {
            type: 'checkbox', checked: days.includes(idx),
            onchange: (e) => {
              const set = new Set(cond.days ?? []);
              if (e.target.checked) set.add(idx); else set.delete(idx);
              cond.days = [...set].sort();
              commit(strategy, { rerender: false });
            },
          }), h('span', null, label)));
      }
      box.append(dayRow);
      const from = cond.hours?.length ? Math.min(...cond.hours) : 0;
      const to = cond.hours?.length ? Math.max(...cond.hours) : 23;
      box.append(h('div', { class: 'cond-row' },
        h('span', { class: 'small muted' }, 'Hodiny (UTC) od'),
        numIn(from, (v) => { cond.hours = rangeHours(v, to); commit(strategy, { rerender: false }); }, { min: 0, max: 23, step: 1, style: { width: '70px' } }),
        h('span', { class: 'small muted' }, 'do'),
        numIn(to, (v) => { cond.hours = rangeHours(from, v); commit(strategy, { rerender: false }); }, { min: 0, max: 23, step: 1, style: { width: '70px' } })));
      break;
    }

    default: {
      // compare
      const left = h('div', { class: 'cond-row' },
        h('span', { class: 'small muted' }, 'Ľavá strana:'),
        operandEditor(cond.left, (op) => { cond.left = op; }, { onChange: rerender }));
      box.append(left);
      const op = OPERATORS.find((o) => o.id === cond.op) ?? OPERATORS[0];
      const opRow = h('div', { class: 'cond-row' },
        h('span', { class: 'small muted' }, 'Operátor:'),
        sel(OPERATORS.map((o) => ({ id: o.id, label: `${o.symbol} — ${o.label}` })), cond.op, (v) => { cond.op = v; rerender(); }));
      if (op.id === 'rising' || op.id === 'falling') {
        opRow.append(h('span', { class: 'small muted' }, 'počet sviečok:'),
          numIn(cond.risingBars ?? 3, (v) => { cond.risingBars = v; commit(strategy, { rerender: false }); }, { min: 1, step: 1, style: { width: '70px' } }));
      }
      box.append(opRow);

      if (op.arity > 0) {
        box.append(h('div', { class: 'cond-row' },
          h('span', { class: 'small muted' }, 'Pravá strana:'),
          operandEditor(cond.right, (v) => { cond.right = v; }, { onChange: rerender })));
      }
      if (op.id === 'between') {
        box.append(h('div', { class: 'cond-row' },
          h('span', { class: 'small muted' }, 'Horná hranica:'),
          numIn(cond.right2 ?? 0, (v) => { cond.right2 = v; commit(strategy, { rerender: false }); }, { style: { width: '100px' } })));
      }
      if (op.id === 'pct_above' || op.id === 'pct_below') {
        box.append(h('div', { class: 'cond-row' },
          h('span', { class: 'small muted' }, 'Percento:'),
          numIn(cond.value ?? 1, (v) => { cond.value = v; commit(strategy, { rerender: false }); }, { style: { width: '100px' } })));
      }
      box.append(h('div', { class: 'cond-row' },
        h('span', { class: 'small muted' }, 'Musí platiť'),
        numIn(cond.hold ?? 1, (v) => { cond.hold = v; commit(strategy, { rerender: false }); }, { min: 1, step: 1, style: { width: '70px' } }),
        h('span', { class: 'small muted' }, 'sviečok v rade · posun'),
        numIn(cond.offset ?? 0, (v) => { cond.offset = v; commit(strategy, { rerender: false }); }, { min: 0, step: 1, style: { width: '70px' } })));
    }
  }

  box.append(h('div', { class: 'small muted mono' }, describeCondition(cond)));
  return box;
}

function rangeHours(from, to) {
  const lo = Math.max(0, Math.min(23, Math.min(from, to)));
  const hi = Math.max(0, Math.min(23, Math.max(from, to)));
  const out = [];
  for (let i = lo; i <= hi; i += 1) out.push(i);
  return out;
}

/* ------------------------------------------------------------ operand editor */

function operandEditor(operand, onChange, { allowConst = true, allowPrice = true, onChange: afterChange = null } = {}) {
  const op = operand ?? { kind: 'indicator', id: 'rsi', params: {} };
  const box = h('div', { class: 'split' });

  const kinds = [
    { id: 'indicator', label: 'Indikátor' },
    ...(allowPrice ? [{ id: 'price', label: 'Cena' }] : []),
    ...(allowConst ? [{ id: 'const', label: 'Konštanta' }] : []),
  ];

  box.append(sel(kinds, op.kind, (kind) => {
    if (kind === 'const') onChange({ kind: 'const', value: op.value ?? 0 });
    else if (kind === 'price') onChange({ kind: 'price', field: op.field ?? 'close' });
    else onChange({ kind: 'indicator', id: op.id ?? 'rsi', params: op.params ?? {} });
    afterChange?.();
  }));

  if (op.kind === 'const') {
    box.append(numIn(op.value ?? 0, (v) => onChange({ kind: 'const', value: v }), { style: { width: '110px' } }));
    return box;
  }

  if (op.kind === 'price') {
    box.append(sel(['close', 'open', 'high', 'low', 'volume'].map((f) => ({ id: f, label: f })), op.field ?? 'close',
      (field) => onChange({ kind: 'price', field })));
    return box;
  }

  const groups = [...new Set(INDICATOR_REGISTRY.map((i) => i.group))];
  const grouped = h('select', {
    onchange: (e) => {
      const def = INDICATOR_REGISTRY.find((i) => i.id === e.target.value);
      onChange({ kind: 'indicator', id: def.id, params: Object.fromEntries(def.params.map((p) => [p.key, p.def])) });
      afterChange?.();
    },
  });
  for (const g of groups) {
    const og = h('optgroup', { label: g });
    for (const def of INDICATOR_REGISTRY.filter((i) => i.group === g)) {
      const o = h('option', { value: def.id }, def.label);
      if (def.id === op.id) o.selected = true;
      og.append(o);
    }
    grouped.append(og);
  }
  box.append(grouped);

  const def = INDICATOR_REGISTRY.find((i) => i.id === op.id);
  for (const p of def?.params ?? []) {
    box.append(h('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '.25rem' } },
      h('span', { class: 'small muted' }, p.key),
      numIn(op.params?.[p.key] ?? p.def, (v) => onChange({ ...op, params: { ...op.params, [p.key]: v } }),
        { min: p.min, max: p.max, step: 'any', style: { width: '80px' } })));
  }
  return box;
}

/* ------------------------------------------------------------- actions editor */

function actionsEditor(strategy, rule) {
  const box = h('div', { class: 'actions-list' });

  rule.then.forEach((action, i) => {
    const row = h('div', { class: 'action-row' });
    row.append(sel(ACTION_TYPES.map((a) => ({ id: a.id, label: `${a.label} (${a.group})` })), action.type, (v) => {
      action.type = v;
      delete action.sizeMode; delete action.value; delete action.message;
      applyActionDefaults(action);
      commit(strategy);
    }));

    const isEntry = action.type === 'buy' || action.type === 'dca';
    const isExit = action.type === 'sell';
    if (isEntry || isExit) {
      const modes = isExit ? EXIT_SIZING_MODES : ENTRY_SIZING_MODES;
      row.append(sel(modes, action.sizeMode ?? (isExit ? 'percent_position' : 'percent_cash'), (v) => {
        action.sizeMode = v; commit(strategy, { rerender: false });
      }));
      if (action.sizeMode !== 'all_cash' && action.sizeMode !== 'all') {
        row.append(numIn(action.value ?? 10, (v) => { action.value = v; commit(strategy, { rerender: false }); }, { style: { width: '90px' } }));
      }
      if (action.sizeMode === 'atr_risk') {
        row.append(h('span', { class: 'small muted' }, 'ATR násobok'),
          numIn(action.atrMult ?? 2, (v) => { action.atrMult = v; commit(strategy, { rerender: false }); }, { style: { width: '70px' } }));
      }
    }
    if (['take_profit', 'stop_loss', 'trailing_stop'].includes(action.type)) {
      row.append(h('span', { class: 'small muted' }, '%'),
        numIn(action.value ?? 5, (v) => { action.value = v; commit(strategy, { rerender: false }); }, { style: { width: '90px' } }));
    }
    if (action.type === 'notify' || action.type === 'log') {
      row.append(txtIn(action.message ?? '', (v) => { action.message = v; commit(strategy, { rerender: false }); }, { placeholder: 'text správy', style: { flex: '1 1 200px' } }));
    }
    if (action.type === 'set_leverage') {
      row.append(numIn(action.value ?? 1, (v) => { action.value = v; commit(strategy, { rerender: false }); }, { min: 1, max: 125, style: { width: '80px' } }));
    }
    if (action.type === 'rebalance') {
      row.append(h('span', { class: 'small muted' }, 'cieľ %'),
        numIn(action.value ?? 50, (v) => { action.value = v; commit(strategy, { rerender: false }); }, { style: { width: '80px' } }));
    }
    if (action.type === 'pause') {
      row.append(numIn(action.bars ?? 0, (v) => { action.bars = v; commit(strategy, { rerender: false }); }, { min: 0, step: 1, style: { width: '80px' } }),
        h('span', { class: 'small muted' }, 'sviečok (0 = navždy)'));
    }

    row.append(h('span', { class: 'small muted mono' }, describeAction(action)));
    row.append(h('button', {
      class: 'icon-btn', type: 'button', title: 'Odstrániť akciu',
      onclick: () => { rule.then.splice(i, 1); commit(strategy); },
    }, '✕'));
    box.append(row);
  });

  box.append(h('button', {
    class: 'btn small', type: 'button',
    onclick: () => { const a = { type: 'buy', sizeMode: 'percent_cash', value: 10 }; rule.then.push(a); commit(strategy); },
  }, '＋ Akcia'));

  return box;
}

function applyActionDefaults(action) {
  switch (action.type) {
    case 'buy': action.sizeMode = 'percent_cash'; action.value = 10; break;
    case 'dca': action.sizeMode = 'fixed_quote'; action.value = 50; break;
    case 'sell': action.sizeMode = 'percent_position'; action.value = 100; break;
    case 'take_profit': action.value = 10; break;
    case 'stop_loss': action.value = 5; break;
    case 'trailing_stop': action.value = 4; break;
    case 'rebalance': action.value = 50; break;
    case 'set_leverage': action.value = 1; break;
    case 'notify': action.message = 'Signál z pravidla'; break;
    case 'log': action.message = ''; break;
    default: break;
  }
}

/* --------------------------------------------------------------- validation */

function validationCard(strategy) {
  const v = validateStrategy(strategy);
  const preview = h('div', { class: 'preview' },
    strategy.rules.map((r, i) => `${i + 1}. ${describeRule(r)}`).join('\n\n'));

  const box = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, 'Kontrola a náhľad'),
      h('div', { class: 'split' },
        v.ok ? pill('stratégia je platná', 'ok') : pill(`${v.errors.length} chýb`, 'err'),
        v.warnings.length ? pill(`${v.warnings.length} upozornení`, 'warn') : null)),
    v.errors.length ? table([{ label: 'Chyba' }, { label: 'Kde' }], v.errors.map((e) => [e.message, e.path])) : null,
    v.warnings.length ? table([{ label: 'Upozornenie' }, { label: 'Kde' }], v.warnings.map((e) => [e.message, e.path])) : null,
    h('h4', null, 'Ľudský náhľad'),
    preview,
    h('div', { class: 'split', style: { marginTop: '.75rem' } },
      h('button', { class: 'btn primary', type: 'button', onclick: () => { store.upsertStrategy(strategy); toast('Stratégia uložená', 'ok'); emit(); } }, 'Uložiť'),
      h('button', { class: 'btn', type: 'button', onclick: () => exportStrategy(strategy) }, 'Export JSON'),
      h('button', { class: 'btn', type: 'button', onclick: () => importInto(strategy) }, 'Import JSON'),
      h('button', { class: 'btn', type: 'button', onclick: () => { state.editorStrategyId = strategy.id; navigate('backtest'); } }, 'Backtest'),
      h('button', { class: 'btn', type: 'button', onclick: () => { state.editorStrategyId = strategy.id; navigate('paper'); } }, 'Virtuálne obchodovanie')));

  return box;
}

function exportStrategy(strategy) {
  download(`${strategy.id}.json`, strategyToJSON(strategy));
  toast('Stratégia exportovaná', 'ok');
}

async function importInto(strategy) {
  const { pickFile } = await import('../dom.js');
  const file = await pickFile('.json');
  if (!file) return;
  try {
    const parsed = JSON.parse(file.text);
    const incoming = strategyFromJSON(parsed.strategy ?? parsed);
    Object.assign(strategy, incoming, { id: strategy.id, name: incoming.name ?? strategy.name });
    commit(strategy);
    toast('Pravidlá nahradené importovaným dokumentom', 'ok');
  } catch (err) {
    toast(`Import zlyhal: ${err.message}`, 'err');
  }
}

export { operandEditor, groupEditor };
