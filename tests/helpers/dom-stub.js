/**
 * dom-stub.js — a tiny, dependency-free DOM implementation for tests.
 *
 * It is deliberately small but implements everything the app touches: element
 * creation, appending, attributes, class names, events, canvas 2D contexts,
 * localStorage and the handful of document/window globals. That lets the real
 * UI modules run end-to-end under `node --test` without a browser.
 */

function makeContext2D(canvas) {
  const target = {
    canvas,
    font: '11px monospace',
    textBaseline: 'middle',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    calls: [],
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (...args) => {
        t.calls.push(String(prop));
        if (prop === 'createLinearGradient') return { addColorStop() {} };
        if (prop === 'measureText') return { width: 10 };
        return undefined;
      };
    },
    set(t, prop, value) { t[prop] = value; return true; },
  });
}

export class StubNode {
  constructor(tagName = 'div', nodeType = 1) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this._text = '';
    this._html = '';
    this.value = '';
    this.checked = false;
    this.selected = false;
    this.files = [];
    this.hidden = false;
    this.disabled = false;
    this.clientWidth = 800;
    this.offsetWidth = 800;
    this.scrollTop = 0;
  }

  get className() { return this.attributes.get('class') ?? ''; }
  set className(v) { this.attributes.set('class', String(v)); }

  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (...names) => self.className = [...new Set([...list(), ...names])].join(' '),
      remove: (...names) => self.className = list().filter((c) => !names.includes(c)).join(' '),
      contains: (name) => list().includes(name),
      toggle: (name, force) => {
        const has = list().includes(name);
        const want = force === undefined ? !has : force;
        if (want) self.className = [...new Set([...list(), name])].join(' ');
        else self.className = list().filter((c) => c !== name).join(' ');
        return want;
      },
    };
  }

  get firstChild() { return this.childNodes[0] ?? null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(v) {
    if (this.nodeType === 3) { this._text = String(v); return; }
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) {
      const t = new StubNode('#text', 3);
      t._text = String(v);
      t.parentNode = this;
      this.childNodes.push(t);
    }
  }

  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.childNodes = [];
    // Minimal parsing so error paths that inject "<p></p>" still work.
    const re = /<(\w+)[^>]*>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const el = new StubNode(m[1]);
      el.textContent = m[2];
      this.append(el);
    }
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? (() => { const t = new StubNode('#text', 3); t._text = node; return t; })() : node;
      if (!child) continue;
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  appendChild(node) { this.append(node); return node; }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; }
    return node;
  }

  remove() { this.parentNode?.removeChild(this); }

  setAttribute(name, value) {
    const v = String(value);
    this.attributes.set(name, v);
    if (name === 'id') registry.set(v, this);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = v;
    }
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }

  /** Fire an event (tests only). */
  dispatch(type, event = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    const inline = this.listeners.get(`on${type}`);
    if (inline) for (const fn of inline) fn(ev);
    return ev;
  }

  /** Convenience for tests: click a button. */
  click() { this.dispatch('click'); }

  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}

  getContext() {
    if (!this._ctx) this._ctx = makeContext2D(this);
    return this._ctx;
  }

  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: 300, right: this.clientWidth, bottom: 300 }; }

  matches(selector) {
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const registry = new Map();

export const document = {
  body: new StubNode('body'),
  documentElement: new StubNode('html'),
  title: '',
  createElement: (tag) => new StubNode(tag),
  createTextNode: (text) => { const t = new StubNode('#text', 3); t._text = String(text); return t; },
  querySelector(selector) {
    if (selector.startsWith('#')) return registry.get(selector.slice(1)) ?? document.body.querySelector(selector);
    return document.body.querySelector(selector);
  },
  querySelectorAll(selector) {
    if (selector.startsWith('#')) {
      const el = registry.get(selector.slice(1));
      return el ? [el] : [];
    }
    return document.body.querySelectorAll(selector);
  },
  getElementById: (id) => registry.get(id) ?? null,
  addEventListener() {},
  removeEventListener() {},
};

export function createStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _map: map,
  };
}

/**
 * Install the stub as the global DOM.
 * @param {{settings?:object}} [opts] seed localStorage with a settings document
 */
export function installDom(opts = {}) {
  const seed = {};
  if (opts.settings) {
    seed['coinrule-studio/v1'] = JSON.stringify({ schema: 3, settings: opts.settings, strategies: opts.strategies ?? [] });
  }
  const localStorage = createStorage(seed);
  const location = { hash: opts.hash ?? '#/dashboard', href: 'http://localhost/' };
  const window = {
    location,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    localStorage,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = location;
  globalThis.localStorage = localStorage;
  globalThis.devicePixelRatio = 1;
  // dom.js checks `child instanceof Node` before appending.
  globalThis.Node = StubNode;
  if (!globalThis.Blob) {
    globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  }
  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
  }
  return { document, window, localStorage, registry };
}

/** Build the parts of index.html that app.js expects to find. */
export function installShell() {
  const ids = [
    'symbol-select', 'timeframe-select', 'source-select', 'reload-data',
    'market-status', 'price-ticker', 'view', 'toasts', 'modal-root',
  ];
  const created = {};
  for (const id of ids) {
    const tag = id === 'view' ? 'main' : id.includes('select') ? 'select' : 'div';
    const el = new StubNode(tag);
    el.setAttribute('id', id);
    document.body.append(el);
    created[id] = el;
  }
  const nav = new StubNode('nav');
  for (const view of ['dashboard', 'strategies', 'editor', 'scanner', 'alerts', 'backtest', 'paper', 'trades', 'indicators', 'settings']) {
    const btn = new StubNode('button');
    btn.setAttribute('data-view', view);
    btn.className = 'nav-btn';
    nav.append(btn);
  }
  document.body.append(nav);
  return created;
}

export function uninstallDom() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.localStorage;
}
