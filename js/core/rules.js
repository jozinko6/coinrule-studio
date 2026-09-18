/**
 * rules.js — the Coinrule-style rule DSL.
 *
 * Grammar (informal)
 *   Strategy := { symbol, timeframe, rules[] , risk }
 *   Rule      := WHEN <group> THEN <action>+      (group may be nested)
 *   Group     := { logic: AND|OR|NOT, items: [ Condition | Group ] }
 *   Condition := <operand> <operator> <operand>   (+ optional bars/offset)
 *
 * Everything here is pure data + pure functions: it runs identically in the
 * browser and under `node --test`.
 */

import { computeIndicator, INDICATOR_REGISTRY } from './indicators.js';

export const SCHEMA_VERSION = 2;

// Re-exported so the UI can build condition menus from a single import.
export { INDICATOR_REGISTRY };

/* ------------------------------------------------------------ vocabularies */

export const OPERATORS = [
  { id: 'gt', label: '>', symbol: '>', arity: 1, series: true },
  { id: 'gte', label: '≥', symbol: '>=', arity: 1, series: true },
  { id: 'lt', label: '<', symbol: '<', arity: 1, series: true },
  { id: 'lte', label: '≤', symbol: '<=', arity: 1, series: true },
  { id: 'eq', label: '=', symbol: '==', arity: 1, series: true },
  { id: 'neq', label: '≠', symbol: '!=', arity: 1, series: true },
  { id: 'crosses_above', label: 'pretne zdola nahor', symbol: 'crosses above', arity: 1, series: true },
  { id: 'crosses_below', label: 'pretne zhora nadol', symbol: 'crosses below', arity: 1, series: true },
  { id: 'rising', label: 'rastie', symbol: 'rising', arity: 0, series: false },
  { id: 'falling', label: 'klesá', symbol: 'falling', arity: 0, series: false },
  { id: 'between', label: 'je medzi', symbol: 'between', arity: 2, series: false },
  { id: 'pct_above', label: '% nad', symbol: '% above', arity: 1, series: false },
  { id: 'pct_below', label: '% pod', symbol: '% below', arity: 1, series: false },
];

export const OPERATOR_IDS = OPERATORS.map((o) => o.id);

export const CONDITION_KINDS = [
  { id: 'compare', label: 'Porovnanie hodnôt' },
  { id: 'change_pct', label: 'Zmena ceny za N sviečok' },
  { id: 'pattern', label: 'Sviečkový pattern' },
  { id: 'divergence', label: 'Divergencia' },
  { id: 'position', label: 'Stav pozície / portfólia' },
  { id: 'time', label: 'Časový filter' },
  { id: 'always', label: 'Vždy (spúšťač)' },
];

export const ACTION_TYPES = [
  { id: 'buy', label: 'Kúpiť', group: 'entry' },
  { id: 'sell', label: 'Predať', group: 'exit' },
  { id: 'close_position', label: 'Zavrieť pozíciu', group: 'exit' },
  { id: 'take_profit', label: 'Nastaviť take-profit', group: 'manage' },
  { id: 'stop_loss', label: 'Nastaviť stop-loss', group: 'manage' },
  { id: 'trailing_stop', label: 'Nastaviť trailing stop', group: 'manage' },
  { id: 'break_even', label: 'Posunúť na break-even', group: 'manage' },
  { id: 'rebalance', label: 'Rebalancovať na cieľ %', group: 'manage' },
  { id: 'dca', label: 'Dokúpiť (DCA krok)', group: 'entry' },
  { id: 'grid', label: 'Umiestniť grid', group: 'entry' },
  { id: 'cancel_orders', label: 'Zrušiť otvorené príkazy', group: 'manage' },
  { id: 'set_leverage', label: 'Nastaviť páku', group: 'manage' },
  { id: 'pause', label: 'Pozastaviť stratégiu', group: 'control' },
  { id: 'resume', label: 'Obnoviť stratégiu', group: 'control' },
  { id: 'notify', label: 'Notifikácia', group: 'control' },
  { id: 'log', label: 'Zápis do denníka', group: 'control' },
];

/** Sizing modes for entries (buy / dca). */
export const ENTRY_SIZING_MODES = [
  { id: 'fixed_quote', label: 'Fixná suma (quote, napr. USDT)' },
  { id: 'fixed_base', label: 'Fixné množstvo (base, napr. BTC)' },
  { id: 'percent_cash', label: '% z voľnej hotovosti' },
  { id: 'percent_equity', label: '% z celkového kapitálu' },
  { id: 'all_cash', label: 'Celá voľná hotovosť' },
  { id: 'risk_percent', label: 'Riziko % kapitálu (so stop-lossom)' },
  { id: 'atr_risk', label: 'Riziko podľa ATR' },
];

/** Sizing modes for exits (sell / close). */
export const EXIT_SIZING_MODES = [
  { id: 'percent_position', label: '% z otvorenej pozície' },
  { id: 'all', label: 'Celá pozícia' },
  { id: 'fixed_base', label: 'Fixné množstvo (base)' },
  { id: 'fixed_quote', label: 'Fixná protihodnota (quote)' },
  { id: 'percent_equity', label: '% z celkového kapitálu' },
  { id: 'percent_cash', label: '% z voľnej hotovosti' },
];

/** Union used by the UI's dropdown. */
export const SIZING_MODES = [
  ...ENTRY_SIZING_MODES,
  ...EXIT_SIZING_MODES.filter((m) => !ENTRY_SIZING_MODES.some((e) => e.id === m.id)),
];

export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w'];

export const TIMEFRAME_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
};

/* -------------------------------------------------------------- factories */

let seq = 0;
export function uid(prefix = 'id') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createOperand(kind = 'indicator', extra = {}) {
  if (kind === 'const') return { kind: 'const', value: extra.value ?? 0 };
  if (kind === 'price') return { kind: 'price', field: extra.field ?? 'close' };
  return { kind: 'indicator', id: extra.id ?? 'rsi', params: extra.params ?? {} };
}

export function createCondition(patch = {}) {
  return {
    id: patch.id ?? uid('cond'),
    type: patch.type ?? 'compare',
    left: patch.left ?? createOperand('indicator', { id: 'rsi', params: { period: 14 } }),
    op: patch.op ?? 'lt',
    right: patch.right ?? createOperand('const', { value: 30 }),
    right2: patch.right2 ?? 0,
    bars: patch.bars ?? 1,
    hold: patch.hold ?? 1,
    offset: patch.offset ?? 0,
    risingBars: patch.risingBars ?? 3,
    ...patch,
  };
}

export function createGroup(logic = 'AND', items = []) {
  return { id: uid('grp'), kind: 'group', logic, items };
}

export function createRule(patch = {}) {
  return {
    id: patch.id ?? uid('rule'),
    name: patch.name ?? 'Nové pravidlo',
    enabled: patch.enabled !== false,
    when: patch.when ?? createGroup('AND', [createCondition()]),
    then: patch.then ?? [{ type: 'buy', sizeMode: 'percent_cash', value: 10 }],
    cooldownBars: patch.cooldownBars ?? 0,
    maxTriggers: patch.maxTriggers ?? 0, // 0 = unlimited
    oneShot: patch.oneShot ?? false,
    ...patch,
  };
}

export function createStrategy(patch = {}) {
  return {
    schema: SCHEMA_VERSION,
    id: patch.id ?? uid('strategy'),
    name: patch.name ?? 'Nová stratégia',
    description: patch.description ?? '',
    symbol: patch.symbol ?? 'BTCUSDT',
    timeframe: patch.timeframe ?? '1h',
    enabled: patch.enabled !== false,
    tags: patch.tags ?? [],
    rules: patch.rules ?? [createRule()],
    risk: {
      maxPositionPct: 100,
      maxOpenPositions: 1,
      stopLossPct: 5,
      takeProfitPct: 10,
      trailingStopPct: 0,
      maxDailyLossPct: 0,
      maxDrawdownPct: 0,
      cooldownBars: 0,
      leverage: 1,
      ...(patch.risk ?? {}),
    },
    ...patch,
  };
}

/* -------------------------------------------------------------- describing */

const OP_LABEL = Object.fromEntries(OPERATORS.map((o) => [o.id, o.label]));
const IND_LABEL = Object.fromEntries(INDICATOR_REGISTRY.map((i) => [i.id, i.label]));

export function describeOperand(op) {
  if (!op) return '?';
  if (op.kind === 'const') return String(op.value);
  if (op.kind === 'price') return op.field === 'close' ? 'cena' : op.field;
  const base = IND_LABEL[op.id] ?? op.id;
  const params = Object.entries(op.params ?? {}).filter(([, v]) => v !== undefined && v !== null);
  return params.length ? `${base}(${params.map(([, v]) => v).join(',')})` : base;
}

export function describeCondition(cond) {
  if (!cond) return '';
  switch (cond.type) {
    case 'always':
      return 'vždy';
    case 'change_pct': {
      const dir = cond.op === 'lt' ? 'klesne o' : 'stúpne o';
      return `cena ${dir} ${Math.abs(cond.value ?? 0)} % za ${cond.bars ?? 1} sviečok`;
    }
    case 'pattern':
      return `pattern „${cond.pattern}“`;
    case 'divergence':
      return `divergencia „${cond.divergenceType}“ na ${describeOperand(cond.oscillator)}`;
    case 'position': {
      const map = {
        none: 'žiadna otvorená pozícia',
        open: 'otvorená pozícia',
        pnl_above: `PnL pozície > ${cond.value} %`,
        pnl_below: `PnL pozície < ${cond.value} %`,
        profit_pct: `zisk pozície ≥ ${cond.value} %`,
        loss_pct: `strata pozície ≥ ${Math.abs(cond.value ?? 0)} %`,
        equity_above: `kapitál > ${cond.value}`,
        cash_above: `hotovosť > ${cond.value}`,
        drawdown_above: `drawdown portfólia > ${cond.value} %`,
      };
      return map[cond.state] ?? `stav: ${cond.state}`;
    }
    case 'time': {
      const parts = [];
      if (cond.days?.length) parts.push(`dni ${cond.days.join(',')}`);
      if (cond.hours?.length) parts.push(`hodiny ${cond.hours[0]}–${cond.hours[cond.hours.length - 1]}`);
      return parts.length ? `čas (${parts.join('; ')})` : 'čas';
    }
    default: {
      const left = describeOperand(cond.left);
      const op = OP_LABEL[cond.op] ?? cond.op;
      let text;
      if (cond.op === 'rising' || cond.op === 'falling') {
        text = `${left} ${op} ${cond.risingBars ?? 3} sviečky`;
      } else if (cond.op === 'between') {
        text = `${left} ${op} ${describeOperand(cond.right)} a ${cond.right2}`;
      } else if (cond.op === 'pct_above' || cond.op === 'pct_below') {
        text = `${left} ${op} ${describeOperand(cond.right)} o ${cond.value ?? 0} %`;
      } else {
        text = `${left} ${op} ${describeOperand(cond.right)}`;
      }
      if ((cond.hold ?? 1) > 1) text += ` (${cond.hold} sviečok v rade)`;
      if ((cond.offset ?? 0) > 0) text += ` (posun ${cond.offset})`;
      return text;
    }
  }
}

export function describeGroup(group) {
  if (!group) return '';
  if (group.kind !== 'group') return describeCondition(group);
  const joiner = group.logic === 'OR' ? ' ALEBO ' : group.logic === 'NOT' ? ' NIE ' : ' A ZÁROVEŇ ';
  const parts = (group.items ?? []).map((it) => (it.kind === 'group' ? `(${describeGroup(it)})` : describeCondition(it)));
  if (group.logic === 'NOT') return `NIE (${parts.join(', ')})`;
  return parts.join(joiner);
}

export function describeRule(rule) {
  const actions = (rule.then ?? []).map(describeAction).join(', potom ');
  return `AK ${describeGroup(rule.when)} → ${actions}`;
}

export function describeAction(action) {
  const label = ACTION_TYPES.find((a) => a.id === action.type)?.label ?? action.type;
  const size = action.value === undefined ? '' : ` ${action.value}`;
  const mode = action.sizeMode ? ` (${SIZING_MODES.find((s) => s.id === action.sizeMode)?.label ?? action.sizeMode})` : '';
  return `${label}${size}${mode}`;
}

/* --------------------------------------------------------------- validation */

/**
 * Validate a strategy. Returns { ok, errors: [{path,message}], warnings: [] }.
 * Never throws — callers decide what to do with the result.
 */
export function validateStrategy(strategy) {
  const errors = [];
  const warnings = [];
  if (!strategy || typeof strategy !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'Stratégia musí byť objekt.' }], warnings };
  }
  if (!strategy.name || !String(strategy.name).trim()) errors.push({ path: 'name', message: 'Chýba názov stratégie.' });
  if (!strategy.symbol) errors.push({ path: 'symbol', message: 'Chýba obchodný pár.' });
  if (!TIMEFRAMES.includes(strategy.timeframe)) errors.push({ path: 'timeframe', message: `Nepodporovaný timeframe: ${strategy.timeframe}` });
  if (!Array.isArray(strategy.rules) || strategy.rules.length === 0) {
    errors.push({ path: 'rules', message: 'Stratégia musí mať aspoň jedno pravidlo.' });
  }

  (strategy.rules ?? []).forEach((rule, ri) => {
    const p = `rules[${ri}]`;
    if (!rule.when) errors.push({ path: `${p}.when`, message: 'Pravidlo nemá podmienku.' });
    if (!Array.isArray(rule.then) || rule.then.length === 0) errors.push({ path: `${p}.then`, message: 'Pravidlo nemá akciu.' });
    validateGroup(rule.when, `${p}.when`, errors);
    (rule.then ?? []).forEach((a, ai) => {
      const ap = `${p}.then[${ai}]`;
      if (!ACTION_TYPES.some((t) => t.id === a.type)) errors.push({ path: ap, message: `Neznáma akcia: ${a.type}` });
      if (a.type === 'buy' || a.type === 'sell' || a.type === 'dca') {
        const allowed = a.type === 'sell' ? SIZING_MODES : ENTRY_SIZING_MODES;
        if (!allowed.some((s) => s.id === a.sizeMode)) errors.push({ path: ap, message: `Neznámy spôsob veľkosti: ${a.sizeMode}` });
        if (a.sizeMode !== 'all_cash' && a.sizeMode !== 'all' && !(Number(a.value) >= 0)) errors.push({ path: ap, message: 'Veľkosť príkazu musí byť nezáporné číslo.' });
        if ((a.sizeMode === 'percent_cash' || a.sizeMode === 'percent_equity') && Number(a.value) > 100) {
          warnings.push({ path: ap, message: 'Veľkosť nad 100 % kapitálu.' });
        }
      }
      if (['take_profit', 'stop_loss', 'trailing_stop'].includes(a.type) && !(Number(a.value) > 0)) {
        errors.push({ path: ap, message: `${a.type} musí byť > 0 %.` });
      }
    });
  });

  const r = strategy.risk ?? {};
  if (r.maxPositionPct !== undefined && (r.maxPositionPct <= 0 || r.maxPositionPct > 100)) {
    errors.push({ path: 'risk.maxPositionPct', message: 'Maximálna veľkosť pozície musí byť v rozsahu (0, 100].' });
  }
  if (r.leverage !== undefined && (r.leverage < 1 || r.leverage > 125)) {
    errors.push({ path: 'risk.leverage', message: 'Páka musí byť v rozsahu 1–125.' });
  }
  if (r.stopLossPct !== undefined && r.stopLossPct < 0) errors.push({ path: 'risk.stopLossPct', message: 'Stop-loss nemôže byť záporný.' });
  if (!strategy.rules?.some((rule) => (rule.then ?? []).some((a) => ['buy', 'dca'].includes(a.type)))) {
    warnings.push({ path: 'rules', message: 'Žiadne pravidlo neotvára pozíciu — stratégia nikdy nekúpi.' });
  }
  return { ok: errors.length === 0, errors, warnings };
}

function validateGroup(node, path, errors) {
  if (!node) return;
  if (node.kind !== 'group') {
    errors.push({ path, message: 'Očakávaná skupina podmienok (group).' });
    return;
  }
  if (!['AND', 'OR', 'NOT'].includes(node.logic)) errors.push({ path: `${path}.logic`, message: `Neznáma logika: ${node.logic}` });
  if (!Array.isArray(node.items) || node.items.length === 0) {
    errors.push({ path: `${path}.items`, message: 'Skupina nemá žiadne podmienky.' });
    return;
  }
  node.items.forEach((item, i) => {
    const ip = `${path}.items[${i}]`;
    if (item.kind === 'group') { validateGroup(item, ip, errors); return; }
    if (item.type === 'compare') {
      if (!OPERATOR_IDS.includes(item.op)) errors.push({ path: ip, message: `Neznámy operátor: ${item.op}` });
      for (const [side, operand] of [['left', item.left], ['right', item.right]]) {
        if (!operand) { errors.push({ path: `${ip}.${side}`, message: 'Chýba operand.' }); continue; }
        if (operand.kind === 'indicator' && !INDICATOR_REGISTRY.some((x) => x.id === operand.id)) {
          errors.push({ path: `${ip}.${side}`, message: `Neznámy indikátor: ${operand.id}` });
        }
      }
    } else if (!CONDITION_KINDS.some((k) => k.id === item.type)) {
      errors.push({ path: ip, message: `Neznámy typ podmienky: ${item.type}` });
    }
  });
}

/* --------------------------------------------------------------- evaluation */

/**
 * Collect every indicator reference used by a strategy so a caller can compute
 * all series once (important for backtest performance).
 * Returns [{ key, id, params }].
 */
export function collectIndicatorRefs(strategy) {
  const out = new Map();
  const add = (op) => {
    if (!op || op.kind !== 'indicator') return;
    const key = `${op.id}|${JSON.stringify(op.params ?? {})}`;
    if (!out.has(key)) out.set(key, { key, id: op.id, params: op.params ?? {} });
  };
  const walkGroup = (g) => {
    if (!g) return;
    if (g.kind !== 'group') {
      if (g.type === 'compare' || g.type === undefined) { add(g.left); add(g.right); }
      if (g.type === 'divergence') add(g.oscillator);
      return;
    }
    for (const item of g.items ?? []) walkGroup(item);
  };
  for (const rule of strategy.rules ?? []) walkGroup(rule.when);
  return [...out.values()];
}

/**
 * Build a resolver that returns a full-length series for an operand.
 * `cache` maps indicator key -> number[].
 */
export function makeOperandResolver(candles, cache) {
  return function resolve(operand) {
    if (!operand) return null;
    if (operand.kind === 'const') return null; // scalars handled separately
    if (operand.kind === 'price') {
      const field = operand.field ?? 'close';
      return candles.map((c) => (typeof c[field] === 'number' ? c[field] : null));
    }
    const key = `${operand.id}|${JSON.stringify(operand.params ?? {})}`;
    if (cache.has(key)) return cache.get(key);
    const series = computeIndicator(operand.id, candles, operand.params ?? {});
    cache.set(key, series);
    return series;
  };
}

function scalarOf(operand, resolver, index) {
  if (!operand) return null;
  if (operand.kind === 'const') return operand.value;
  const s = resolver(operand);
  return s ? s[index] : null;
}

function num(v) { return typeof v === 'number' && Number.isFinite(v); }

/** Evaluate a single comparison at a given bar index. */
export function evalCompare(cond, ctx) {
  const { index, resolver } = ctx;
  const offset = cond.offset ?? 0;
  const i = index - offset;
  if (i < 1) return false;

  if (cond.op === 'rising' || cond.op === 'falling') {
    const s = resolver(cond.left);
    if (!s) return false;
    const bars = Math.max(1, cond.risingBars ?? 3);
    for (let k = 0; k < bars; k += 1) {
      const a = s[i - k];
      const b = s[i - k - 1];
      if (!num(a) || !num(b)) return false;
      if (cond.op === 'rising' && a <= b) return false;
      if (cond.op === 'falling' && a >= b) return false;
    }
    return true;
  }

  const ls = cond.left?.kind === 'const' ? null : resolver(cond.left);
  const rs = cond.right?.kind === 'const' ? null : resolver(cond.right);
  const l = ls ? ls[i] : cond.left?.value;
  const r = rs ? rs[i] : cond.right?.value;
  if (!num(l) || !num(r)) return false;

  switch (cond.op) {
    case 'gt': return l > r;
    case 'gte': return l >= r;
    case 'lt': return l < r;
    case 'lte': return l <= r;
    case 'eq': return l === r;
    case 'neq': return l !== r;
    case 'between': {
      const lo = Math.min(r, cond.right2);
      const hi = Math.max(r, cond.right2);
      return l >= lo && l <= hi;
    }
    case 'pct_above': return l >= r * (1 + (cond.value ?? 0) / 100);
    case 'pct_below': return l <= r * (1 - (cond.value ?? 0) / 100);
    case 'crosses_above': {
      const lp = ls ? ls[i - 1] : l;
      const rp = rs ? rs[i - 1] : r;
      if (!num(lp) || !num(rp)) return false;
      return lp <= rp && l > r;
    }
    case 'crosses_below': {
      const lp = ls ? ls[i - 1] : l;
      const rp = rs ? rs[i - 1] : r;
      if (!num(lp) || !num(rp)) return false;
      return lp >= rp && l < r;
    }
    default:
      return false;
  }
}

/** Evaluate any condition node (single condition or group) at ctx.index. */
export function evaluateNode(node, ctx) {
  if (!node) return false;
  if (node.kind === 'group') {
    const items = node.items ?? [];
    if (!items.length) return false;
    if (node.logic === 'OR') return items.some((it) => evaluateNode(it, ctx));
    if (node.logic === 'NOT') return !items.some((it) => evaluateNode(it, ctx));
    return items.every((it) => evaluateNode(it, ctx));
  }
  return evaluateCondition(node, ctx);
}

export function evaluateCondition(cond, ctx) {
  const { index, candles, portfolio, position } = ctx;
  // `hold` = how many consecutive bars the condition must be true on.
  // (`bars` is reserved for lookback windows such as change_pct / pattern.)
  const bars = Math.max(1, cond.hold ?? 1);
  for (let k = 0; k < bars; k += 1) {
    const sub = { ...ctx, index: index - k };
    if (sub.index < 0) return false;
    if (!evaluateConditionOnce(cond, sub)) return false;
  }
  return true;

  function evaluateConditionOnce(c, c2) {
    switch (c.type) {
      case 'always':
        return true;
      case 'change_pct': {
        const bars2 = Math.max(1, c.bars ?? 1);
        const i = c2.index - (c.offset ?? 0);
        if (i - bars2 < 0) return false;
        const now = candles[i]?.close;
        const then = candles[i - bars2]?.close;
        if (!num(now) || !num(then) || then === 0) return false;
        const pct = ((now - then) / then) * 100;
        if (c.op === 'lt') return pct <= -Math.abs(c.value ?? 0);
        if (c.op === 'gt') return pct >= Math.abs(c.value ?? 0);
        if (c.op === 'between') return pct >= Math.min(c.value, c.right2) && pct <= Math.max(c.value, c.right2);
        return false;
      }
      case 'pattern': {
        // lazy import-free check: reuse candlePatterns through the cache holder
        const patterns = c2.patterns ?? [];
        return patterns.includes(c.pattern);
      }
      case 'divergence': {
        const osc = c2.resolver(c.oscillator);
        if (!osc) return false;
        const key = `div|${c.oscillator.id}|${JSON.stringify(c.oscillator.params ?? {})}|${c2.index}`;
        const cache = c2.divergenceCache;
        let found = cache?.get(key);
        if (found === undefined) {
          found = detectDivergenceLazy(c2.candles, osc, c2.index);
          cache?.set(key, found);
        }
        return found === c.divergenceType;
      }
      case 'position': {
        const state = c.state;
        const pos = position;
        switch (state) {
          case 'none': return !pos;
          case 'open': return !!pos;
          case 'pnl_above': return !!pos && pos.unrealizedPct(c2.price) > (c.value ?? 0);
          case 'pnl_below': return !!pos && pos.unrealizedPct(c2.price) < (c.value ?? 0);
          case 'profit_pct': return !!pos && pos.unrealizedPct(c2.price) >= Math.abs(c.value ?? 0);
          case 'loss_pct': return !!pos && pos.unrealizedPct(c2.price) <= -Math.abs(c.value ?? 0);
          case 'equity_above': return (portfolio?.equity(c2.price) ?? 0) > (c.value ?? 0);
          case 'cash_above': return (portfolio?.cash ?? 0) > (c.value ?? 0);
          case 'drawdown_above': return (portfolio?.drawdownPct?.(c2.price) ?? 0) >= (c.value ?? 0);
          default: return false;
        }
      }
      case 'time': {
        const t = c2.candles[c2.index]?.time;
        if (!num(t)) return false;
        const d = new Date(t);
        if (Array.isArray(c.days) && c.days.length && !c.days.includes(d.getUTCDay())) return false;
        if (Array.isArray(c.hours) && c.hours.length) {
          const lo = Math.min(...c.hours);
          const hi = Math.max(...c.hours);
          const h = d.getUTCHours();
          if (h < lo || h > hi) return false;
        }
        return true;
      }
      default:
        return evalCompare(c, c2);
    }
  }
}

/** Divergence between price pivots and an oscillator, restricted to bars <= index. */
function detectDivergenceLazy(candles, oscillator, index) {
  const left = 2;
  const right = 2;
  const slice = candles.slice(0, index + 1);
  if (slice.length < left + right + 2) return null;
  const highs = [];
  const lows = [];
  for (let i = slice.length - 1 - right; i >= left; i -= 1) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - left; k <= i + right; k += 1) {
      if (k === i) continue;
      if (slice[k].high >= slice[i].high) isHigh = false;
      if (slice[k].low <= slice[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: slice[i].high });
    if (isLow) lows.push({ index: i, price: slice[i].low });
    if (lows.length >= 2 && highs.length >= 2) break;
  }
  if (lows.length >= 2) {
    const [b, a] = lows; // newest first
    const oa = oscillator[a.index];
    const ob = oscillator[b.index];
    if (num(oa) && num(ob)) {
      if (b.price < a.price && ob > oa) return 'bullish';
      if (b.price > a.price && ob < oa) return 'hidden_bullish';
    }
  }
  if (highs.length >= 2) {
    const [b, a] = highs;
    const oa = oscillator[a.index];
    const ob = oscillator[b.index];
    if (num(oa) && num(ob)) {
      if (b.price > a.price && ob < oa) return 'bearish';
      if (b.price < a.price && ob > oa) return 'hidden_bearish';
    }
  }
  return null;
}

/* ------------------------------------------------------------------- codec */

export function strategyToJSON(strategy) {
  return JSON.stringify({ schema: SCHEMA_VERSION, strategy }, null, 2);
}

export function strategyFromJSON(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : text;
  const raw = parsed.strategy ?? parsed;
  const migrated = migrateStrategy(raw);
  const check = validateStrategy(migrated);
  if (!check.ok) {
    const err = new Error(`Neplatná stratégia: ${check.errors.map((e) => e.message).join('; ')}`);
    err.errors = check.errors;
    throw err;
  }
  return migrated;
}

/** Forward-migrate older documents to the current schema. */
export function migrateStrategy(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const s = JSON.parse(JSON.stringify(raw));
  const v = Number(s.schema ?? 1);
  if (v < 2) {
    // v1 stored a flat condition array; wrap it into an AND group.
    s.rules = (s.rules ?? []).map((r) => {
      if (Array.isArray(r.when)) return { ...r, when: { id: uid('grp'), kind: 'group', logic: 'AND', items: r.when } };
      if (r.when && r.when.kind !== 'group') return { ...r, when: { id: uid('grp'), kind: 'group', logic: 'AND', items: [r.when] } };
      return r;
    });
    s.schema = 2;
  }
  return s;
}
