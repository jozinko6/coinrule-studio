/** settings.js — configuration, data sources, import/export and storage. */

import { h, table, pill, toast, confirmDialog, download, pickFile, fmtNum } from '../dom.js';
import { state, store, emit, setSource, loadCandles, resetEngine } from '../state.js';
import { POPULAR_SYMBOLS, SOURCE } from '../../data/market.js';
import { TIMEFRAMES } from '../../core/rules.js';
import { STRATEGY_COUNT } from '../../core/strategies.js';
import { INDICATOR_REGISTRY } from '../../core/indicators.js';
import { DEFAULT_BACKEND_URL, createBackendClient, defaultBackendUrl } from '../../data/backend.js';

/* ------------------------------------------------------- local backend panel */

let backend = null;
let backendPanel = null;
const backendInfo = {
  url: defaultBackendUrl(),
  token: '',
  status: null,
  risk: null,
  stream: null,
  sessions: [],
  error: null,
  note: '',
};

async function backendAction(fn, note = '') {
  backendInfo.error = null;
  backendInfo.note = note;
  try {
    await fn();
  } catch (err) {
    backendInfo.error = err?.message ?? String(err);
  }
  rerenderBackendPanel();
}

function rerenderBackendPanel() {
  if (!backendPanel || !backendPanel.isConnected) return;
  const next = renderBackendPanel();
  backendPanel.replaceWith(next);
}

async function connectBackend() {
  backend = createBackendClient({ baseUrl: backendInfo.url, token: backendInfo.token });
  await backendAction(async () => {
    await backend.health();
    await refreshBackendState();
    backendInfo.note = 'Pripojené.';
  });
}

async function refreshBackendState() {
  if (!backend) return;
  backendInfo.status = await backend.status();
  backendInfo.risk = await backend.risk();
  backendInfo.sessions = (await backend.sessions()).sessions ?? [];
  try { backendInfo.stream = (await backend.streamStatus()).stream; } catch { backendInfo.stream = null; }
}

function renderBackendPanel() {
  const card = h('div', { class: 'card' });

  card.append(h('div', { class: 'card-head' },
    h('h3', null, 'Lokálny backend (TESTNET / LIVE)'),
    backendInfo.status
      ? pill('backend: ' + backendInfo.status.mode.mode, backendInfo.status.mode.mode === 'live' ? 'warn' : 'ok')
      : pill('nepripojené', 'warn')));

  card.append(h('p', { class: 'muted small' },
    'Backend beží na 127.0.0.1 a drží kľúče len v pamäti. Admin token nájdeš v konzole, kde si spustil SPUSTIT.bat. '
    + 'Token ani kľúče sa neukladajú do prehliadača.'));

  const urlInput = h('input', { type: 'text', value: backendInfo.url, placeholder: DEFAULT_BACKEND_URL });
  const tokenInput = h('input', { type: 'password', value: backendInfo.token, placeholder: 'admin token z konzoly' });
  card.append(h('div', { class: 'grid cols-3' },
    h('label', { class: 'field' }, h('span', null, 'Adresa backendu'), urlInput),
    h('label', { class: 'field' }, h('span', null, 'Admin token'), tokenInput),
    h('label', { class: 'field' }, h('span', null, ' '),
      h('div', { class: 'split' },
        h('button', {
          class: 'btn primary', type: 'button',
          onclick: () => {
            backendInfo.url = urlInput.value.trim() || DEFAULT_BACKEND_URL;
            backendInfo.token = tokenInput.value;
            void connectBackend();
          },
        }, 'Pripojiť'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => {
            backend = null; backendInfo.status = null; backendInfo.risk = null;
            backendInfo.sessions = []; backendInfo.stream = null; backendInfo.error = null;
            rerenderBackendPanel();
          },
        }, 'Odpojiť')))));

  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(backendInfo.url)) {
    card.append(h('p', { class: 'neg' }, 'Pozor: adresa backendu nie je loopback — kľúče by mohli odísť mimo tento počítač.'));
  }
  if (backendInfo.error) card.append(h('p', { class: 'neg' }, backendInfo.error));
  if (backendInfo.note && !backendInfo.error) card.append(h('p', { class: 'muted small' }, backendInfo.note));

  if (backendInfo.status) {
    const status = backendInfo.status;
    card.append(h('div', { class: 'grid cols-4' },
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Mód'), h('div', { class: 'value' }, status.mode.mode)),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Live'), h('div', { class: 'value' }, status.mode.liveEnabled ? 'ON' : 'off')),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Databáza'), h('div', { class: 'value' }, status.db?.ok ? 'ok' : 'chyba')),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Kľúče'), h('div', { class: 'value' }, status.credentials?.configured ? status.credentials.keyMasked : '—'))));

    const risk = backendInfo.risk;
    card.append(h('div', { class: 'split', style: { marginTop: '.6rem' } },
      pill(risk?.killSwitchEngaged ? 'kill switch ZAPNUTÝ' : 'kill switch vypnutý', risk?.killSwitchEngaged ? 'warn' : 'ok'),
      h('button', {
        class: 'btn small', type: 'button',
        onclick: () => { void backendAction(async () => { await backend.setKillSwitch(!risk?.killSwitchEngaged); await refreshBackendState(); }); },
      }, risk?.killSwitchEngaged ? 'Vypnúť kill switch' : 'Zapnúť kill switch')));

    const modeBtn = (action, label, cls = 'btn small') => h('button', {
      class: cls, type: 'button',
      onclick: () => {
        if (action === 'live') {
          void (async () => {
            const yes = await confirmDialog('Zapnúť LIVE? Príkazy pôjdu na burzu s reálnymi peniazmi. Najprv otestuj TESTNET.', { danger: true, confirmLabel: 'Zapnúť LIVE' });
            if (!yes) return;
            void backendAction(async () => { await backend.setMode('live', { confirm: 'LIVE', acknowledgeRisk: true }); await refreshBackendState(); });
          })();
          return;
        }
        void backendAction(async () => { await backend.setMode(action); await refreshBackendState(); });
      },
    }, label);

    card.append(h('div', { class: 'split', style: { marginTop: '.5rem' } },
      modeBtn('paper', 'PAPER'), modeBtn('offline', 'OFFLINE'), modeBtn('testnet', 'TESTNET'),
      modeBtn('live', 'LIVE', 'btn small danger'), modeBtn('disable', 'Vypnúť live/testnet')));

    const keyInput = h('input', { type: 'password', placeholder: 'API key' });
    const secretInput = h('input', { type: 'password', placeholder: 'API secret' });
    card.append(h('div', { class: 'grid cols-3', style: { marginTop: '.6rem' } },
      h('label', { class: 'field' }, h('span', null, 'Binance key'), keyInput),
      h('label', { class: 'field' }, h('span', null, 'Binance secret'), secretInput),
      h('label', { class: 'field' }, h('span', null, ' '),
        h('div', { class: 'split' },
          h('button', {
            class: 'btn small', type: 'button',
            onclick: () => { void backendAction(async () => {
              await backend.saveCredentials(keyInput.value, secretInput.value);
              keyInput.value = ''; secretInput.value = '';
              await refreshBackendState();
            }, 'Kľúče uložené v pamäti backendu.'); },
          }, 'Uložiť kľúče'),
          h('button', { class: 'btn small', type: 'button', onclick: () => { void backendAction(async () => { await backend.clearCredentials(); await refreshBackendState(); }); } }, 'Vymazať kľúče')))));

    const sessionSelect = h('select', null);
    for (const session of backendInfo.sessions) {
      const o = h('option', { value: session.id }, session.environment + ' · ' + (session.symbol ?? '—') + ' · ' + session.reconciliation_state);
      if (backendInfo.stream?.sessionId === session.id) o.selected = true;
      sessionSelect.append(o);
    }
    card.append(h('div', { class: 'grid cols-3', style: { marginTop: '.6rem' } },
      h('label', { class: 'field' }, h('span', null, 'Live session'), sessionSelect),
      h('label', { class: 'field' }, h('span', null, ' '),
        h('div', { class: 'split' },
          h('button', { class: 'btn small', type: 'button', onclick: () => { void backendAction(async () => { await backend.createSession(status.mode.mode === 'live' ? 'live' : 'testnet', null); await refreshBackendState(); }); } }, 'Nová session'),
          h('button', { class: 'btn small', type: 'button', onclick: () => { void backendAction(async () => { await backend.reconcile(sessionSelect.value); await refreshBackendState(); }); } }, 'Reconciliation'))),
      h('label', { class: 'field' }, h('span', null, 'Stream'),
        h('div', { class: 'split' },
          h('button', { class: 'btn small', type: 'button', onclick: () => { void backendAction(async () => { await backend.streamStart(sessionSelect.value); await refreshBackendState(); }); } }, 'Štart'),
          h('button', { class: 'btn small', type: 'button', onclick: () => { void backendAction(async () => { await backend.streamStop(); await refreshBackendState(); }); } }, 'Stop'),
          h('span', { class: 'muted small' }, backendInfo.stream?.running ? ('beží (' + (backendInfo.stream.ticks ?? 0) + ' tickov)') : 'stopped')))));
  }

  backendPanel = card;
  return card;
}
export function render() {
  const wrap = h('div');
  const s = store.settings;

  wrap.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h2', null, 'Nastavenia'),
      h('p', { class: 'muted small' }, 'Všetko sa ukladá lokálne v prehliadači (localStorage). Nič sa neposiela na server.'))));

  wrap.append(renderBackendPanel());

  /* ------------------------------------------------------------ data source */
  const sourceSelect = h('select', { onchange: (e) => { setSource(e.target.value).then(() => emit()); } });
  for (const [value, label] of [
    [SOURCE.AUTO, 'Auto — Binance, pri výpadku simulácia'],
    [SOURCE.BINANCE, 'Binance — len verejné API (bez kľúčov)'],
    [SOURCE.SYNTHETIC, 'Simulované dáta — plne offline'],
  ]) {
    const o = h('option', { value }, label);
    if (state.source === value) o.selected = true;
    sourceSelect.append(o);
  }

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Zdroj dát')),
    h('div', { class: 'grid cols-3' },
      h('label', { class: 'field' }, h('span', null, 'Režim'), sourceSelect),
      h('label', { class: 'field' }, h('span', null, 'Pár'),
        (() => {
          const el = h('select', { onchange: (e) => { state.symbol = e.target.value; store.updateSettings({ symbol: e.target.value }); loadCandles({ symbol: e.target.value }).then(emit); } });
          const known = [...new Set([...POPULAR_SYMBOLS, ...(store.state.watchlist ?? []), state.symbol])];
          for (const sym of known) {
            const o = h('option', { value: sym }, sym);
            if (sym === state.symbol) o.selected = true;
            el.append(o);
          }
          return el;
        })()),
      h('label', { class: 'field' }, h('span', null, 'Timeframe'),
        (() => {
          const el = h('select', { onchange: (e) => { state.timeframe = e.target.value; store.updateSettings({ timeframe: e.target.value }); loadCandles({ timeframe: e.target.value }).then(emit); } });
          for (const tf of TIMEFRAMES) {
            const o = h('option', { value: tf }, tf);
            if (tf === state.timeframe) o.selected = true;
            el.append(o);
          }
          return el;
        })()),
      h('label', { class: 'field' }, h('span', null, 'Počet sviečok'),
        h('input', {
          type: 'number', value: state.candleLimit, min: 100, max: 5000, step: 100,
          onchange: (e) => { state.candleLimit = Number(e.target.value); store.updateSettings({ candleLimit: state.candleLimit }); loadCandles().then(emit); },
        }))),
    h('p', { class: 'muted small' },
      `Stav: ${state.dataInfo.message} · zdroj: ${state.dataInfo.source} · načítaných sviečok: ${state.candles.length}`),
    h('details', { class: 'help', style: { marginTop: '.5rem' } },
      h('summary', null, 'Ako funguje pripojenie na Binance bez API kľúčov'),
      h('p', { class: 'small muted' },
        'Aplikácia používa výhradne verejné endpointy (klines, ticker, exchangeInfo) a verejný WebSocket stream. '
        + 'Súkromné endpointy ako /api/v3/account alebo /api/v3/order sú v klientovi technicky zakázané — '
        + 'klient odmietne akýkoľvek pokus o ich volanie a nikdy neposiela autentifikačné hlavičky. '
        + 'Preto nie je možné (a ani žiadúce) zadať API kľúč: obchodovanie je vždy len virtuálne.'))));

  /* --------------------------------------------------------- trading default */
  const num = (label, key, attrs = {}) => h('label', { class: 'field' }, h('span', null, label),
    h('input', {
      type: 'number', value: s[key], step: attrs.step ?? 'any', min: attrs.min,
      onchange: (e) => { store.updateSettings({ [key]: Number(e.target.value) }); toast('Uložené', 'ok'); },
    }));

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Predvolené parametre obchodovania')),
    h('div', { class: 'grid cols-4' },
      num('Počiatočný kapitál (USDT)', 'startingCash', { step: 100, min: 0 }),
      num('Poplatok % (taker aj maker)', 'feePct', { step: 0.01, min: 0 }),
      num('Slippage %', 'slippagePct', { step: 0.01, min: 0 }),
      num('Participácia objemu (%)', 'participationRate', { step: 0.05, min: 0 }),
      num('Max. drawdown % (0 = vypnuté)', 'maxDrawdownPct', { min: 0 }),
      num('Max. denná strata % (0 = vypnuté)', 'maxDailyLossPct', { min: 0 }),
      num('Cooldown (sviečky)', 'cooldownBars', { min: 0, step: 1 }),
      h('label', { class: 'field' }, h('span', null, 'Dokupovanie (pyramiding)'),
        (() => {
          const el = h('select', { onchange: (e) => { store.updateSettings({ allowPyramiding: e.target.value === 'yes' }); toast('Uložené', 'ok'); } });
          el.append(h('option', { value: 'no' }, 'vypnuté'));
          const yes = h('option', { value: 'yes' }, 'zapnuté');
          if (s.allowPyramiding) yes.selected = true;
          el.append(yes);
          return el;
        })()))));

  /* ---------------------------------------------------------------- watchlist */
  const watchInput = h('input', { type: 'text', placeholder: 'napr. LINKUSDT', style: { width: '160px' } });
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, 'Sledované páry'),
      h('div', { class: 'split' }, watchInput,
        h('button', {
          class: 'btn small primary', type: 'button',
          onclick: () => {
            const sym = watchInput.value.trim().toUpperCase();
            if (!sym) return;
            store.state.watchlist = [...new Set([...(store.state.watchlist ?? []), sym])];
            store.save();
            watchInput.value = '';
            toast(`${sym} pridaný`, 'ok');
            emit();
          },
        }, 'Pridať'))),
    h('div', { class: 'split' }, (store.state.watchlist ?? []).map((sym) => h('span', { class: 'pill' },
      sym, ' ',
      h('button', {
        class: 'icon-btn', type: 'button', style: { width: '20px', height: '20px' },
        onclick: () => {
          store.state.watchlist = store.state.watchlist.filter((x) => x !== sym);
          store.save();
          emit();
        },
      }, '✕'))))));

  /* ------------------------------------------------------------------ storage */
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Dáta a zálohovanie')),
    h('div', { class: 'grid cols-4' },
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Uložených stratégií'), h('div', { class: 'value' }, String(store.strategies.length))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Backtestov v archíve'), h('div', { class: 'value' }, String(store.state.backtests.length))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Veľkosť úložiska'), h('div', { class: 'value' }, `${fmtNum(store.size() / 1024, 1)} kB`)),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Schéma'), h('div', { class: 'value' }, String(store.state.schema)))),
    h('div', { class: 'split', style: { marginTop: '.75rem' } },
      h('button', { class: 'btn', type: 'button', onclick: () => { download('coinrule-studio-export.json', store.exportJSON()); toast('Export hotový', 'ok'); } }, 'Export všetkých dát'),
      h('button', { class: 'btn', type: 'button', onclick: importAll }, 'Import dát'),
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          if (await confirmDialog('Naozaj vymazať všetky stratégie, nastavenia a históriu?', { danger: true, confirmLabel: 'Vymazať všetko' })) {
            store.reset();
            resetEngine();
            toast('Dáta vymazané', 'ok');
            emit();
          }
        },
      }, 'Vymazať všetko'))));

  /* -------------------------------------------------------------------- about */
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'O aplikácii'), pill('bez API kľúčov', 'ok')),
    table([{ label: 'Vlastnosť' }, { label: 'Hodnota' }], [
      ['Šablóny stratégií', `${STRATEGY_COUNT} v 12 rodinách`],
      ['Indikátory', `${INDICATOR_REGISTRY.length}`],
      ['Zdroj trhových dát', 'Verejné API/WS Binance alebo deterministický simulátor'],
      ['Obchodovanie', 'Virtuálne (paper) lokálne; TESTNET/LIVE iba cez lokálny backend s kľúčmi v RAM'],
      ['Závislosti', 'Žiadne — čistý JavaScript (ES moduly), bez CDN a balíkov'],
      ['Ukladanie', 'localStorage + JSON export/import; kľúče a admin token sa neukladajú nikdy'],
      ['Backtest engine', 'Event-driven, bez look-ahead (signál na close, plnenie na ďalšom open)'],
      ['Poplatky', `${s.feePct} % taker aj maker (štandard Binance spot)`],
    ])));

  return wrap;
}

async function importAll() {
  const file = await pickFile('.json');
  if (!file) return;
  try {
    store.importJSON(file.text, { merge: true });
    toast('Dáta importované', 'ok');
    emit();
  } catch (err) {
    toast(`Import zlyhal: ${err.message}`, 'err');
  }
}
