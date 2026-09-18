/**
 * dom.js — tiny DOM toolkit.
 *
 * Rules: no DOM access at module top level (everything is inside functions) so
 * that the whole UI layer can be imported under `node --test` with a stub.
 */

export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'text') el.textContent = value;
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export function on(node, event, handler, opts) {
  node.addEventListener(event, handler, opts);
  return () => node.removeEventListener(event, handler, opts);
}

/* ------------------------------------------------------------- formatting */

export const fmtNum = (v, d = 2) => (Number.isFinite(v) ? v.toLocaleString('sk-SK', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

export const fmtMoney = (v, d = 2) => (Number.isFinite(v) ? `${fmtNum(v, d)}` : '—');

export const fmtPct = (v, d = 2) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)} %` : '—');

export const fmtQty = (v, d = 6) => (Number.isFinite(v) ? v.toFixed(d).replace(/\.?0+$/, '') || '0' : '—');

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const min = ms / 60000;
  if (min < 60) return `${min.toFixed(0)} min`;
  const hours = min / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  const days = hours / 24;
  return `${days.toFixed(1)} dní`;
}

export function fmtDate(ts, withTime = true) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('sk-SK');
  if (!withTime) return date;
  return `${date} ${d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Class name for a signed number. */
export const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted');

/* ------------------------------------------------------------------ pieces */

export function stat(label, value, sub = null, cls = '') {
  return h('div', { class: 'stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${cls}` }, value),
    sub ? h('div', { class: 'sub' }, sub) : null);
}

export function pill(text, kind = 'idle') {
  return h('span', { class: `pill pill-${kind}` }, text);
}

export function field(label, control) {
  return h('label', { class: 'field' }, h('span', null, label), control);
}

export function select(options, value, onChange, attrs = {}) {
  const el = h('select', { ...attrs, onchange: (e) => onChange?.(e.target.value) });
  for (const opt of options) {
    const o = h('option', { value: opt.value }, opt.label);
    if (String(opt.value) === String(value)) o.selected = true;
    el.append(o);
  }
  return el;
}

export function numberInput(value, onChange, attrs = {}) {
  return h('input', {
    type: 'number',
    value: value ?? 0,
    ...attrs,
    onchange: (e) => onChange?.(Number(e.target.value)),
  });
}

export function textInput(value, onChange, attrs = {}) {
  return h('input', { type: 'text', value: value ?? '', ...attrs, oninput: (e) => onChange?.(e.target.value) });
}

export function button(label, onClick, cls = 'btn', attrs = {}) {
  return h('button', { type: 'button', class: cls, onclick: onClick, ...attrs }, label);
}

export function table(headers, rows, { empty = 'Žiadne dáta' } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  const thead = h('thead', null, h('tr', null, headers.map((hd) => h('th', { class: hd.num ? 'num' : '' }, hd.label ?? hd))));
  const tbody = h('tbody', null, rows.map((row) => h('tr', null, row.map((cell, i) => {
    const hd = headers[i] ?? {};
    if (cell instanceof Node) return h('td', { class: hd.num ? 'num' : '' }, cell);
    return h('td', { class: hd.num ? 'num' : '' }, cell === null || cell === undefined ? '—' : String(cell));
  }))));
  return h('div', { class: 'table-wrap' }, h('table', null, thead, tbody));
}

export function bar(pct, label = null) {
  const clamped = Math.max(0, Math.min(100, pct ?? 0));
  return h('div', null,
    label ? h('div', { class: 'small muted' }, label) : null,
    h('div', { class: 'bar' }, h('i', { style: { width: `${clamped}%` } })));
}

/* ------------------------------------------------------------------ toasts */

export function toast(message, kind = 'info', ttl = 4200) {
  const root = qs('#toasts');
  if (!root) return;
  const el = h('div', { class: `toast ${kind}` }, message);
  root.append(el);
  setTimeout(() => el.remove(), ttl);
}

/* ------------------------------------------------------------------- modal */

export function modal({ title, body, actions = [], onClose = null, wide = false }) {
  const root = qs('#modal-root');
  if (!root) return null;
  const close = () => {
    clear(root);
    root.hidden = true;
    onClose?.();
  };
  const box = h('div', { class: 'modal', style: wide ? { width: 'min(980px, 100%)' } : null },
    h('h3', null, title),
    body,
    h('div', { class: 'modal-actions' },
      ...actions.map((a) => button(a.label, () => { const keep = a.onClick?.(); if (!keep) close(); }, a.class ?? 'btn'))));
  mount(root, box);
  root.hidden = false;
  root.onclick = (e) => { if (e.target === root) close(); };
  return { close, box };
}

export function confirmDialog(message, { title = 'Potvrdenie', confirmLabel = 'Potvrdiť', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    modal({
      title,
      body: h('p', null, message),
      actions: [
        { label: 'Zrušiť', onClick: () => finish(false) },
        { label: confirmLabel, class: danger ? 'btn danger' : 'btn primary', onClick: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '' }) {
  return new Promise((resolve) => {
    let input;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    modal({
      title,
      body: h('div', null,
        h('label', { class: 'field' }, h('span', null, label),
          input = h('input', { type: 'text', value, placeholder }))),
      actions: [
        { label: 'Zrušiť', onClick: () => finish(null) },
        { label: 'OK', class: 'btn primary', onClick: () => finish(input.value) },
      ],
      onClose: () => finish(null),
    });
    setTimeout(() => input?.focus(), 30);
  });
}

/* ------------------------------------------------------------------ download */

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept = '.json') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); input.remove(); return; }
      const reader = new FileReader();
      reader.onload = () => { resolve({ name: file.name, text: String(reader.result) }); input.remove(); };
      reader.onerror = () => { resolve(null); input.remove(); };
      reader.readAsText(file);
    });
    document.body.append(input);
    input.click();
  });
}
