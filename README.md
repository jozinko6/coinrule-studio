# CoinRule Studio

Pravidlový krypto trading bot inšpirovaný Coinrule — **celý v prehliadači**, bez inštalácie
balíkov, bez tretích strán, bez CDN a **bez API kľúčov**.

Obsahuje vizuálny editor pravidiel, knižnicu hotových stratégií, historický backtest
a virtuálne (paper) obchodovanie s reálnymi trhovými dátami z verejného API Binance.

```
node tools/serve.mjs      →  http://127.0.0.1:8787
node --test               →  277 testov
node tools/verify.mjs     →  plná verifikácia (lint + testy + runtime smoke)
```

---

## 1. Prečo bez API kľúčov

Toto je **zámerné obmedzenie, nie chýbajúca funkcia**:

* klient `js/data/binance.js` pozná iba verejné endpointy (`/api/v3/klines`, `/api/v3/ticker/*`,
  `/api/v3/exchangeInfo`, `/api/v3/depth`) a verejný WebSocket stream;
* `assertPublic()` **odmietne** akékoľvek volanie súkromného endpointu
  (`/api/v3/account`, `/api/v3/order`, …);
* `assertNoCredentials()` vyhodí výnimku, ak by niekto skúsil klientovi odovzdať `apiKey`,
  `secretKey`, `signature` alebo `token`;
* v HTTP požiadavkách sa nikdy neposiela autentifikačná hlavička — test to overuje
  (`tests/binance.test.js`).

Reálny obchod teda nie je technicky možný. Všetko obchodovanie je simulované lokálne.

## 2. Spustenie

**Windows – jedným kliknutím:** dvojklik na `SPUSTIT.bat`. Skript skontroluje Node.js,
spustí server a po ~2 sekundách otvorí aplikáciu v predvolenom prehliadači. Iný port:
`SPUSTIT.bat 8888`. Okno nechaj otvorené – zatvorením sa server ukončí.

| Príkaz | Čo robí |
|---|---|
| `node tools/serve.mjs` | spustí statický server (predvolene `127.0.0.1:8787`); `--port`, `--host` |
| `node --test` | celá testovacia sada |
| `node tools/verify.mjs` | lint + testy + runtime smoke, zapíše `.longrun/verification_report.json` |
| `node tools/lint.mjs` | iba statické kontroly |
| `node tools/symbol-audit.mjs` | overí kurátorovanú množinu párov proti Binance exchangeInfo (vyžaduje sieť) |

Vyžaduje sa iba Node ≥ 18. Žiadne `npm install` — `dependencies` aj `devDependencies` sú prázdne.

## 3. Architektúra

```
index.html              shell aplikácie (ES moduly, bez bundleru)
css/app.css             jediný stylesheet
js/core/                čistý engine — beží v prehliadači aj v node --test
  indicators.js         65 indikátorov, patterns, divergencie, support/resistance, volume profile
  rules.js              DSL pravidiel: továrne, validácia, vyhodnotenie, popis, JSON codec
  strategies.js         knižnica 128 šablón v 13 rodinách (vrátane 42 Coinrule šablón)
  risk.js               sizing pozície + RiskGuard (drawdown, denná strata)
  money.js              deterministické zaokrúhľovanie a formátovanie
  portfolio.js          hotovosť, pozície, ledger, PnL, drawdown
  paper.js              virtuálny broker: typy príkazov, poplatky, slippage, čiastočné plnenia
  metrics.js            výkonnostné metriky a mesačné výnosy
  engine.js             StrategyRuntime — spoločný pre backtest aj live
  backtest.js           event-driven backtester
  session.js            LivePaperEngine — živá virtuálna session
  scanner.js            viacpárový skener trhu (12 presetov, skóre)
  alerts.js             lokálne cenové a indikátorové upozornenia
js/data/                trhové dáta
  symbols.js            kurátorovaná USDT množina (28 hlavných + 37 volatilných)
  binance.js            verejné REST + WebSocket (bez autentifikácie)
  synthetic.js          deterministický simulátor trhu (GARCH-like volatilita)
  seed.js               zabudované deterministické datasety
  market.js             fasáda: auto | binance | synthetic
js/store/store.js       localStorage + migrácie + import/export
js/ui/                  DOM vrstva (10 views; moduly nesiahnu na `document` pri importe)
  dom.js charts.js state.js views/*
js/app.js               bootstrap a routing
tools/                  serve.mjs, lint.mjs, verify.mjs
tests/                  node:test sada (277 testov)
```

Kľúčové pravidlo: `js/core/**` a `js/data/**` **nesmú** siahať na DOM, takže celý engine je
testovateľný v Node bez prehliadača. To isté platí pre moduly `js/ui/**` — DOM používajú len
vo vnútri funkcií (overuje `tests/smoke.test.js`).

## 4. Editor pravidiel

Stratégia = séria pravidiel `AK <podmienky> POTOM <akcie>`.

**Podmienky** (ľubovoľne vnorené skupiny `AND` / `OR` / `NOT`):

| Typ | Popis |
|---|---|
| Porovnanie hodnôt | indikátor / cena / konštanta + operátor `>`, `≥`, `<`, `≤`, `=`, `≠`, pretnutie nahor/nadol, rastie, klesá, medzi, % nad/pod |
| Zmena ceny za N sviečok | napr. „klesne o 5 % za 6 sviečok“ |
| Sviečkový pattern | doji, hammer, engulfing, morning star, three white soldiers, … |
| Divergencia | bullish / bearish / skrytá, na zvolenom oscilátore |
| Stav pozície / portfólia | žiadna pozícia, otvorená, zisk ≥ X %, strata ≥ X %, kapitál > X, drawdown ≥ X % |
| Časový filter | dni v týždni a hodiny (UTC) |
| Vždy | časovač — kombinuj s cooldownom |

Každá podmienka navyše podporuje `hold` (koľko sviečok v rade musí platiť) a `offset` (posun).

**Akcie**: kúpiť, dokúpiť (DCA), predať, zavrieť pozíciu, take-profit, stop-loss,
trailing stop, break-even, rebalancovať, zrušiť príkazy, nastaviť páku, pozastaviť,
obnoviť, notifikácia, zápis do denníka.

**Veľkosť príkazu**: fixná suma/množstvo, % hotovosti, % kapitálu, celá hotovosť,
riziko % kapitálu so stop-lossom, riziko podľa ATR.

Editor priebežne validuje dokument a zobrazuje ľudský náhľad, napr.:

```
AK RSI(14) < 30 A ZÁROVEŇ cena > SMA(200) → Kúpiť 25 (% z voľnej hotovosti), Nastaviť stop-loss 5, Nastaviť take-profit 8
```

## 5. Knižnica stratégií (128 šablón v 13 rodinách)

| Rodina | Počet | Príklady |
|---|---|---|
| Trendové | 15 | EMA crossover, golden cross, supertrend, Ichimoku, Donchian/Turtle, PSAR, MACD trend, KAMA, HMA, vortex, regresný kanál, VWAP trend |
| Mean reversion | 13 | RSI oversold, RSI(2), Bollinger bounce, Z-score, stochastická reverzia, CCI, Williams %R, MFI, %B, percentil, Keltner, VWAP, RSI divergencia |
| Breakout | 8 | Bollinger squeeze, range breakout, volatilná expanzia, objemový spike, ATH, Donchian+ADX, opening range, turtle |
| Momentum | 6 | ROC, MACD histogram, dual momentum, TRIX, KST, money flow |
| Scalping | 4 | EMA+RSI scalp, momentum burst, VWAP bounce, Stoch RSI |
| DCA / akumulácia | 7 | týždenný a denný DCA, DCA + dip boost, dip buyer, buy the fear, value averaging, akumulácia na supporte |
| Grid / range | 4 | grid, ATR grid, range scalper, sideways market maker |
| Martingale | 2 | limitovaný martingale, postupné priemerovanie |
| Risk manažment | 8 | trailing systém, TP ladder, break-even, chandelier exit, časový exit, drawdown guard, ATR sizing, Ulcer risk-off |
| Volatilita | 3 | ATR filter, squeeze akumulácia, bandwidth cycle |
| Hybridné | 10 | trend + pullback, breakout retest, MACD+RSI confluence, support bounce, Fibonacci pullback, spread reversion, adaptive multi-filter, spike fade, weekend effect, trend reversal catcher |
| Portfólio | 6 | rebalancing, risk-on/off, momentum rotácia, cash preservation, relatívna sila, buy & hold |
| Coinrule knižnica | 42 | ichimoku, RSI+SMA, DCA, grid, scalping, momentum, breakout, rebalancing |
| **Spolu** | **128** | |

Šablóny sa inštancujú ako samostatné editovateľné dokumenty — úpravou šablóny sa knižnica nemení.

## 6. Virtuálne obchodovanie

`PaperBroker` modeluje realistické podmienky:

* **typy príkazov**: market, limit, stop-market, stop-limit (aktivuje sa až po dosiahnutí
  stop ceny, potom sa stane bežným limitom), take-profit, trailing stop;
* **time-in-force**: GTC, IOC, FOK;
* **poplatky**: taker aj maker (predvolene 0,1 % ako Binance spot), strhávajú sa z každého plnenia;
* **slippage**: percentuálny posun proti obchodu;
* **čiastočné plnenia**: objem príkazu je limitovaný `participationRate` × objem sviečky;
* **OCO**: naplnenie jednej nohy ruší druhú — aj keď sa obe úrovne pretnú v tej istej sviečke;
* **gapy**: stop sa pri prechode cez úroveň plní na open, nie na stop cene;
* **intrabar poradie**: stop-loss sa spracuje pred take-profitom (konzervatívne);
* **atribúcia**: ochranné príkazy si pamätajú pravidlo, ktoré pozíciu otvorilo, takže
  trade log vie priradiť výstup k vstupnému pravidlu.

Bez look-ahead: v backteste sa signál vyhodnotí na close sviečky a trhový príkaz sa
naplní na **open nasledujúcej** sviečky. V live režime sa plní okamžite za poslednú cenu.

## 7. Backtest a metriky

Report obsahuje: čistý zisk, celkový výnos, CAGR, Sharpe, Sortino, Calmar, volatilitu,
maximálny drawdown (+ jeho trvanie), expozíciu, počet obchodov, úspešnosť, profit factor,
payoff ratio, expectancy, maximálne série ziskov/strát, priemerné trvanie obchodu,
zaplatené poplatky, mesačné výnosy a porovnanie s buy & hold (alfa).

Naviac: porovnanie všetkých stratégií naraz (`compareStrategies`) a parametrický sweep
(`paramSweep`) pre ladenie jedného parametra.

## 8. Dáta

| Režim | Zdroj | Kedy sa použije |
|---|---|---|
| `binance` | verejné REST + WS | keď je sieť dostupná |
| `synthetic` | deterministický simulátor | offline režim, testy, demo |
| `auto` | Binance → simulátor | predvolené; pri výpadku sa plynule prepne |

Simulátor generuje sviečky modelom s GARCH-like zhlukovaním volatility a režimovými
zmenami trendu. Je plne deterministický (seed), takže testy majú presné očakávané hodnoty.
V UI je vždy jasne označené, ktorý zdroj je aktívny.

### Obchodované páry

* **Hlavné páry (28):** BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK, LTC, TRX,
  ATOM, NEAR, APT, ARB, OP, SUI, UNI, HBAR, BCH, ETC, FIL, ICP, ALGO, VET, STX, IMX.
* **Volatilné páry (37):** PEPE, SHIB, WIF, BONK, FLOKI, DOGS, PNUT, BOME, ORDI, 1000SATS,
  TRUMP, MEME, NEIRO a high-beta alty (INJ, SEI, TIA, JUP, PYTH, WLD, CRV, LDO, ENS, FET,
  RENDER, PENDLE, ENA, ETHFI, W, ZK, STRK, BLUR, GMX, DYDX, ARKM, MANTA, ALT, AEVO).
* Ponuka páru v hornej lište je rozdelená na kategórie; skener má tlačidlá
  „Hlavné (28)“ a „Volatilné (37)“.
* Volatilné páry majú výrazne širšie sviečky — menšia veľkosť pozície a stop-loss podľa
  ATR sú rozumný základ. Binance občas pár delistuje alebo pozastaví; neznámy pár sa vtedy
  ticho prepne na determinovanú simuláciu, takže aplikácia funguje ďalej. Aktuálny stav
  overíš cez `node tools/symbol-audit.mjs` (naposledy 65/65 TRADING).

## 13. Lokálna databáza (SQLite)

Dátová vrstva beží na vstavanom module `node:sqlite` (Node ≥ 22.5) — žiadne npm
závislosti a žiadny natívny build, takže zostáva v platnosti „bez inštalácie“.

| Čo | Kde / ako |
|---|---|
| Súbor databázy | `data/coinrule-studio.db` (adresár sa vytvorí automaticky; je v `.gitignore`) |
| Migrácie | `server/db/migrations.mjs` — forward-only, každá v transakcii, zapísaná v `schema_migrations` |
| Prístupová vrstva | `server/db/repositories.mjs` (stratégie + verzie, backtesty, paper session, audit, riziká, účty) |
| Import starých dát | `server/db/legacy.mjs` — jednorazový a idempotentný import z localStorage |

Schéma obsahuje tabuľky `strategies`, `strategy_versions`, `backtest_runs`, `backtest_trades`,
`backtest_equity`, `paper_sessions`, `paper_orders`, `paper_trades`, `paper_equity`,
`live_sessions`, `live_orders`, `live_fills`, `live_trades`, `exchange_accounts`,
`app_settings`, `audit_log`, `risk_events`.

**Backup:** skopíruj `data/coinrule-studio.db` (a `-wal`/`-shm`, ak existujú) alebo použi
`sqlite3 data/coinrule-studio.db .dump > backup.sql`. V databáze nie sú žiadne API secrety —
účty držia iba maskovaný kľúč (`api_key_masked`).

**Reset aplikácie:** zatvor server a zmaž adresár `data/` — pri ďalšom štarte sa databáza
vytvorí nanovo a migrácie sa spustia od začiatku. Stratégie v prehliadači (localStorage)
zostávajú nedotknuté, kým ich znova neimportuješ.

**Stav integrácie:** databázová vrstva je hotová a testovaná (`tests/db.test.js`), ale
napojenie UI (História výsledkov) a lokálny backend s privátnym Binance API sú ďalšie kroky
long-run plánu — pozri `.longrun/GOAL.md`.

## 9. Testy a verifikácia

```
tests/indicators.test.js   hodnoty počítané ručne + invarianty + celý register indikátorov
tests/rules.test.js        DSL: validácia, vyhodnotenie, popis, migrácia, JSON codec
tests/strategies.test.js   invarianty knižnice + backtest všetkých 128 stratégií
tests/paper.test.js        broker: plnenia, poplatky, slippage, OCO, FOK, čiastočné plnenia
tests/portfolio.test.js    účtovníctvo, priemerovanie, drawdown, ledger
tests/metrics.test.js      metriky na ručne overených krivkách
tests/backtest.test.js     determinizmus, absencia look-ahead, kill switch, sweep
tests/engine.test.js       runtime: cooldowny, pyramiding, ochranné príkazy, dry-run, atribúcia
tests/synthetic.test.js    determinizmus simulátora, čistota datasetov
tests/binance.test.js      žiadne kľúče, len verejné endpointy, retry, rate limit
tests/store.test.js        perzistencia, migrácie, import/export
tests/integration.test.js  celý kritický tok od dát po obchody
tests/smoke.test.js        server + všetky assety + import všetkých UI modulov
tests/ui.test.js           reálne UI proti stub DOM: boot, všetky views, editor, backtest
tests/scanner.test.js      skener: referenčné hodnoty presetov, ranking, determinizmus
tests/alerts.test.js       upozornenia: typy, vyhodnotenie, cooldown, história spustení
tests/symbols.test.js      množina párov: formát, kategórie, re-exporty binance/market
```

Spolu 17 testovacích súborov (`tests/*.test.js`) plus pomocný stub DOM.

`node tools/verify.mjs` je jediný deterministický vstupný bod a zapisuje strojový report.

## 10. Obmedzenia (úprimne)

* Iba **long** pozície — spotová sémantika, žiadne shorty ani marža.
* Backtest je deterministický, ale zjednodušený: žiadna kniha objednávok, žiadne
  funding rate ani požičiavanie; likvidita sa modeluje cez `participationRate`.
* Simulované datasety **nie sú reálne historické ceny** — slúžia na demo a testy.
  Pre reálne dáta prepni zdroj na `binance`.
* Stav sa ukladá do `localStorage` prehliadača (nie je to serverová databáza).

## 11. Bezpečnosť

* Žiadne tajomstvá, žiadne kľúče, žiadne odchádzajúce dáta okrem verejných požiadaviek na Binance.
* Statický server chráni proti path traversal a posiela `X-Content-Type-Options: nosniff`.
* Lint zakazuje CDN odkazy, `eval`, `new Function` a prácu s prihlasovacími údajmi.

---

## 12. Skener trhu a upozornenia (milestone 2)

* **Skener trhu** — `js/core/scanner.js` + view `scanner`. Prejde naraz až 24 párov cez
  12 presetov (RSI, trend, breakout, objem, squeeze, momentum…), zoradí výsledky podľa
  skóre a kliknutím prenesie pár do grafu. Funguje aj úplne offline.
* **Upozornenia** — `js/core/alerts.js` + view `alerts`. 12 typov podmienok (cena, % zmena,
  RSI, objem, breakout, EMA cross, ATR), perzistencia v `localStorage` (schéma 4), história
  spustení a voliteľné systémové notifikácie. Všetko sa vyhodnocuje lokálne.
* **Coinrule knižnica** — nová rodina `coinrule` so 42 šablónami podľa verejného zoznamu
  Coinrule (help.coinrule.com). Ide o nezávislú implementáciu rovnakých pravidiel v našom
  DSL, nie o kopírovanie textov či kódu; short šablóny sú adaptované na long-only spot.
  Poznámka: `bb_squeeze` je detekcia začiatku squeezu (onset) — počas dlhej tichej fázy
  signál zmizne, keď sa tiché sviečky stanú referenčnou vzorkou.
  Projekt nie je nijako spojený s Coinrule ani ňou sponzorovaný.
