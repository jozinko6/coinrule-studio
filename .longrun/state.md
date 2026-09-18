# state.md — CoinRule Studio

## Mission
Deliver, in `Web pokus`, the most detailed possible Coinrule-style platform:
rule builder + full strategy library + Binance public data + virtual trading,
with **no API keys, no third parties, no external programs**.

## Status: COMPLETE (awaiting independent verifier)

## Delivered
- `index.html`, `css/app.css` — app shell, dark UI, no CDN/fonts.
- `js/core/` — indicators (65), rules DSL, 86 strategy templates, risk, money,
  portfolio, paper broker, metrics, engine runtime, backtester, live session.
- `js/data/` — public Binance client (REST+WS, no auth), deterministic simulator,
  seeded datasets, market facade with auto-fallback.
- `js/store/store.js` — localStorage persistence, migrations (v1→v3), import/export.
- `js/ui/` — 8 views (dashboard, strategies, editor, backtest, paper, trades,
  indicators, settings), canvas charts, DOM toolkit, hash routing.
- `tools/` — serve.mjs (zero-dep static server), lint.mjs, verify.mjs.
- `tests/` — 209 tests across 14 `*.test.js` files (+ a stub-DOM helper).

## Verification evidence (latest run)
```
node tools/verify.mjs
[PASS] lint          — 49 files, 0 warnings
[PASS] unit-tests    — 209 passed, 0 failed
[PASS] runtime-smoke — 30 assets (28 JS) served over HTTP 200
Verdict: PASS (3/3)
Report: .longrun/verification_report.json
```

## Notable bugs found and fixed (root causes)
1. `paper.js` — protective order fills ignored the side (a gap-down stop filled at the
   bar HIGH). Fixed with explicit `stopPrice()`/`limitPrice()` helpers per side.
2. `paper.js` — `createOrder` spread `...patch` last, so an explicitly `undefined` `id`
   wiped the generated id → all orders shared the key `undefined` (OCO and cancelAll
   silently broke). Defaults are now applied after the spread.
3. `paper.js` — partially filled market orders were never re-filled on later bars.
4. `paper.js` — `recordTrade` read the entry price after the sell had already deleted
   the position, so every win was recorded as a loss.
5. `binance.js` — `assertNoCredentials` compared lower-cased keys against a mixed-case
   list, so `secretKey`/`privateKey` slipped through.
6. `synthetic.js` — regime shocks could dominate the scenario drift; bull/crash tests
   were statistically flaky. Shocks are now bounded by half a bar's volatility.
7. `engine.js` — `pause` only paused the rule that fired; now pauses the strategy.
8. `engine.js` — queued protection was re-queued forever after being applied.
9. `engine.js` — a strategy whose declared timeframe differed from the fed bars was
   silently skipped. Now the timeframe is advisory and a warning is surfaced.
10. `ui/views/strategies.js` — `cards.length ? cards : empty` on a DOM element (always
    falsy) hid the whole template library in a real browser. Caught by the stub-DOM test.

## Commands
- run:    `node tools/serve.mjs` → http://127.0.0.1:8787
- tests:  `node --test`
- gate:   `node tools/verify.mjs`

## Independent verifier round 1 (PASS) — findings resolved
11. `paper.js` — OCO sibling could double-fill when both legs were touched in the same
    bar (the fill loop iterated a snapshot and never re-checked status). `fillOrder`
    now refuses dead orders; regression test added.
12. `paper.js` — `stop_limit` was treated as a plain resting limit and ignored its stop
    price. It now arms only after the stop triggers and then rests as a limit.
13. `engine.js` — protective exits were logged with `ruleId: null`; the pending
    protection now carries the originating rule/strategy (trade attribution).
14. `engine.js` — a leftover timeframe `continue` still silently skipped strategies in
    multi-strategy runs. Removed; regression test added.
15. `metrics.js` — `monthlyReturns` is now part of the metrics object (not only the UI).
16. `binance.js` — an explicit `fetchImpl: null` now really disables fetch.
17. `tests/metrics.test.js` — assertion tightened back to the exact rounded values.
18. Docs — corrected indicator count (65), per-family strategy counts, test-file count.

## Independent verifier round 2 (PASS) — residuals resolved
19. The new OCO regression test used `reduceOnly` legs, which masked the bug; a
    non-reduce-only variant now proves the guard is load-bearing (verified by mutation).
20. `limit`/`stop_limit` without a limit price are rejected up front instead of resting forever.
21. `reduceOnly` orders whose position disappeared are cancelled instead of lingering.
22. The timeframe-mismatch warning now covers every strategy in the run, not just the first.
23. README test count corrected to the real number.

## Known limitations (documented, intentional)
- Long-only spot semantics (no shorts/margin).
- Bundled offline datasets are simulated, not real history (UI labels them).
- State lives in localStorage; no server database.

---

# Milestone 2 (2026-09-18) — scanner, alerts, Coinrule library, GitHub

## Status: COMPLETE (independent verifier PASS; 2 minor findings resolved; post-release click-blocker fixed)

### Delivered
- `js/core/scanner.js` + view `scanner` — 12 presetov, viacpárový sken so skóre.
- `js/core/alerts.js` + view `alerts` — 12 typov, lokálne vyhodnotenie, história spustení.
- store schéma 4 — `alerts` + `alertLog` (migrácia, import/export union).
- 42 Coinrule šablón v novej rodine `coinrule` → 128 šablón v 13 rodinách.
- README sekcia 12, AGENTS layout, GOAL AC12-AC14.

### Verification evidence
```
node tools/verify.mjs
[PASS] lint          — 55 súborov, 0 varovaní
[PASS] unit-tests    — 247 prešlo, 0 zlyhalo
[PASS] runtime-smoke — 34 assetov (32 JS)
Verdict: PASS (3/3)
```

### Real-browser evidence (headless Chrome + CDP)
- Boot: title „CoinRule Studio — Prehľad“, Binance online, 500 sviečok, BTCUSDT 78 213,13.
- Scanner: sken watchlistu (3 páry), výsledky zoradené, SOLUSDT 1 signál (skóre 8,45).
- Alerts: vytvorené price_above value 0 → uložené, kontrola prebehla, 1 trigger, log zapísaný.

### Findings fixed during milestone 2
1. `scanner` MACD cross je numericky na hrane (`crossOver` s presnou rovnosťou) — fixtúry
   overené empiricky; mŕtvy trh (ATR ≈ 0) už nedáva rsi/bb signály.
2. `bb_squeeze` na konštantnej šírke pásma vždy „squeeze“ — teraz kvantilová podmienka.
3. `alerts` mali pevný warmup — vlastné periódy (napr. EMA 5/10) hlásili „málo dát“;
   pridané dynamické `minBars(alert)`.
4. Test fixtures change_pct bola matematicky zlá (106→100 je -5,66 %, nie -6 %).
5. `appendAlertLog` zoradí dávku podľa `at` zostupne (najnovšie prvé).

### GitHub
- repo: https://github.com/jozinko6/coinrule-studio (public)
- commit `700662e` na `main`, lokálne HEAD == origin/main.

### Independent verifier round (milestone 2) — findings resolved
1. `bb_squeeze` je onset detekcia: počas dlhej tichej fázy signál zmizne, keď sa tiché
   sviečky stanú referenčnou vzorkou. Zámer správania je vysvetlený v README (sekcia 12).
2. `tools/verify.mjs` prepisoval sledovaný report a znečisťoval pracovný strom; report je
   teraz v `.gitignore` a odstránený z indexu (na disku zostáva ako lokálny artefakt).
3. Verifier verdict: **VERIFIED** — 247/247 testov, 0 skipped, žiadne oslabené assercie.

### One-click launcher (SPUSTIT.bat)
- Skontroluje Node.js (inak návod + odkaz na nodejs.org), spustí `tools/serve.mjs`
  a po ~2 s otvorí predvolený prehliadač; voliteľný port `SPUSTIT.bat 8888`.
- Overené príkazmi: HTTP 200 na `/` aj `/js/core/scanner.js` cez bat, chýbajúci Node
  → exit 1 s návodom, obsadený port → zrozumiteľná chyba a exit 1, oneskorené
  otvorenie prehliadača s korektným portom.

### Opravené po nasadení: neklikateľné UI (overlay)
- Príznak: po spustení cez `SPUSTIT.bat` sa nedalo na nič kliknúť, celá stránka stmavená.
- Príčina: `.modal-root { display: grid }` (autor) prebil HTML atribút `hidden`
  (UA pravidlo `[hidden] { display: none }` má nižšiu váhu než autorské), takže
  neviditeľný celoobrazovkový overlay so `z-index: 80` zachytával všetky kliky.
  Programové `.click()` v stub-DOM testoch ho obchádzajú — preto to testy neodhalili.
- Oprava: `.modal-root[hidden] { display: none; }`, inline `style="display:none"` v
  `index.html` a `modal()` v `dom.js` explicitne nastavuje `style.display` (grid/none).
  `.toasts` dostali `pointer-events: none` (+ `.toast` auto).
- Regresná ochrana: smoke test „hidden-by-default elements cannot be un-hidden by their
  own CSS“ zlyhá, ak trieda s `display` nemá `[hidden]` guard.
- Dôkaz v reálnom Chrome (CDP, skutočné kliknutia myšou): `elementFromPoint` vracia
  `BUTTON` (predtým overlay), kliky prešli `scanner → alerts → dashboard`, sken
  vrátil 3 výsledky, v stránke 0 výnimiek.
- Gate po oprave: `node tools/verify.mjs` → PASS 3/3 (lint 55, 248 testov, 34 assetov).

### Rozšírená množina párov
- Nový modul `js/data/symbols.js`: 28 hlavných + 37 volatilných párov (memecoiny,
  high-beta alty), kategórie pre picker, `isVolatileSymbol`/`isValidSymbol`.
- Skener: tlačidlá „Hlavné (28)“ / „Volatilné (37)“, limit 48 párov na sken.
- Offline simulácia je per-symbol (seed z názvu) a volatilné páry dostávajú
  „volatile“ scénář — dva neznáme páry už nikdy nemajú rovnaké sviečky.
- Store schéma 5: predvolený watchlist rozšírený o DOGE/PEPE/WIF/INJ/SUI;
  starý nedotknutý default sa upgraduje, používateľské zoznamy zostávajú.
- Dôkaz: gate PASS 3/3 (57 súborov, 255 testov, 35 assetov); reálny Chrome:
  optgroups 28+37, klik „Volatilné (37)“ → 37 párov, sken 37/37, 15 so signálom,
  0 výnimiek.

### Oprava reálnej validity párov (verifier round)
- Verifikátor porovnal množinu so živým Binance `exchangeInfo`: 63/65 TRADING.
- `RATSUSDT` na Binance spot neexistuje → nahradený `TRUMPUSDT` (TRADING, vysoká volatilita).
- `TONUSDT` mal status `BREAK` (pozastavené) → nahradený `UNIUSDT` (TRADING, likvidný major).
- Nový nástroj `tools/symbol-audit.mjs` (verejné endpointy, bez kľúčov) overí celú
  množinu; exit 0 = všetko TRADING. Spustené: „Všetkých 65 párov je TRADING.“

---

# Long-run upgrade — cycle 1 (2026-09-18)

## Analysed (source, not README)
Read in full: `js/core/paper.js`, `portfolio.js`, `engine.js`, `backtest.js`, `metrics.js`, `rules.js` catalogues,
`js/store/store.js`, `tools/*`, and the whole test suite. Verified `node:sqlite` is available in Node v24
(`DatabaseSync`, `StatementSync`) — so the DB can stay **zero-dependency**.

## Found bugs (reproduced with failing tests first)
1. **Protective timing** — SL/TP were only created at the bar close, so an entry filled at the open could
   survive a bar whose low breached the stop. Fixed with an `onEntryFilled` broker hook that arms protection
   at the real average fill price, before the intrabar range is processed.
2. **Fee after downsizing** — `fillOrder` shrank qty on gap-up but kept the old notional/fee → cash could go
   negative. Now notional+fee are recomputed from the final qty (`affordableQty` fixpoint).
3. **Entry fees missing from trade PnL** — trades only subtracted the exit fee. Positions now carry
   `entryFeeOpen`; every sell allocates a proportional slice. Trades expose
   `grossPnl / entryFee / exitFee / totalFees / netPnl / netPnlPct`; `pnl` and `pnlPct` are the NET values,
   so win/loss, profit factor, expectancy and win rate are all net.
4. **Partial OCO** — a partial fill left the sibling at full size and both legs could fire. Added
   `syncOco()` (quantity synchronisation + cancel when consumed) and `resolveOco()` on completion.
5. **Shared liquidity** — participation applied per order. Added `barLiquidityRemaining`: every fill in one
   bar consumes from `volume * participationRate`.
6. **Intrabar model** — the trailing stop used the current bar's high and then triggered on the earlier low.
   Added explicit models `conservative` (default) / `ohlc` / `olhc` with `setExecutionModel()` validation.
7. **BONUS (found by the new tests): take-profit triggered unconditionally.** The old touch test used
   `low <= trigger` for EVERY sell order, so a TP above the market filled on the next bar at the TP price.
   Now targets need `high >= trigger`, stops need `low <= trigger`. This materially changes backtest results
   (they were optimistic); all 128 templates still validate and backtest.
8. **reduce-only cleanup ran before queued entries filled**, cancelling a same-bar entry's own protection.
   Moved after the market-fill step.

## Changed
- `js/core/paper.js` (rewritten): execution models, entry-fill hook, shared budget, OCO sync, fee-correct fills.
- `js/core/portfolio.js`: `entryFeeOpen` allocation, net realized PnL, richer `applySell` result.
- `js/core/engine.js`: protection queued before actions, armed via broker hook, `applyProtection`/`handleEntryFill`.
- `js/core/backtest.js`: `executionModel`, `makerFeePct`, `assumptions` block, net benchmark fee model.
- `js/core/metrics.js`: `benchmarkFeePct` + `benchmarkNet` (net buy&hold), documented.

## New tests
- `tests/execution.test.js` — 12 tests: T1 same-bar protection (×2), T2 gap fee, T3 net fees (×2),
  T4 partial OCO, T5 shared budget, T6 execution models (×4), model validation.
- Updated 3 existing expectations to the corrected net semantics (portfolio realized PnL 9.79, net
  `pnlPct` in integration, protection armed at fill in engine) — assertions were strengthened, not weakened.

## Verification
`node --test` (all files): **267 passed / 0 failed** (was 255). `node tools/verify.mjs` → see below.

## Decisions
- DB will use **`node:sqlite`** (built into Node ≥ 22.5, stable enough in v24) to preserve the zero-dependency,
  no-install constraint. Windows-safe, no native build.
- `conservative` execution model is the default; the model is stored with every backtest (`assumptions`).
- Live trading architecture will be an `ExecutionBroker` interface with `PaperBroker`/`BinanceBroker`
  implementations; `StrategyRuntime` stays broker-agnostic (same strategy logic in all modes).

## Migration notes
- Trade semantics changed: `trade.pnl` is now NET of entry+exit fees; new fields added and old ones kept.
  Equity was always net (cash-based), so portfolio equity and trade statistics now agree.
- Backtest metrics for existing saved records (localStorage) were produced under the old TP bug; they are
  historical artefacts. A DB import will keep them but they should be re-run for accurate comparisons.

## Next safe step
Phase 3: `data/coinrule-studio.db` via `node:sqlite` with a forward-only migration runner and repositories
(strategies, backtest runs/trades/equity, paper sessions, audit log), plus the idempotent localStorage →
SQLite migration and tests (fresh DB, re-run idempotency, recovery).

# Long-run upgrade — cycle 2 (2026-09-18): local SQLite

## Analysed
Confirmed `node:sqlite` in Node v24 (`DatabaseSync`) — the database needs **zero npm
dependencies**, so the project keeps its no-install constraint on Windows.

## Delivered
- `server/db/migrations.mjs` — 17 tables (strategies, strategy_versions, backtest_runs/trades/equity,
  paper_sessions/orders/trades/equity, live_sessions/orders/fills/trades, exchange_accounts,
  app_settings, audit_log, risk_events) + indexes; forward-only runner with per-migration transactions.
- `server/db/database.mjs` — open/migrate, WAL + foreign keys + busy timeout, `withTransaction`, close.
- `server/db/repositories.mjs` — typed access: strategies + version history, immutable backtest runs
  (trades + equity in one transaction), settings, paper sessions, audit with `redactSecrets`,
  risk events, exchange accounts (masked key only).
- `server/db/legacy.mjs` — one-time idempotent import of the localStorage document (strategies,
  settings, watchlist, favourites, alerts, backtest summaries, paper session + trades + equity).
- `tests/db.test.js` — 10 tests: fresh schema, migration idempotency, failed-migration rollback,
  strategy versioning, backtest immutability + cascade, persistence across reopen, audit redaction,
  legacy import (twice = no duplicates), legacy backtest `INSERT OR IGNORE`.
- `.gitignore` — `data/` (user DB) is never committed.

## Verification
`node --test tests/db.test.js` → 10/10. Full lint: 64 files, 0 warnings. Full gate below.

## Decisions / migration notes
- The database lives in `data/coinrule-studio.db`; secrets are never stored — `exchange_accounts`
  keeps only `api_key_masked` + a fingerprint.
- `audit_log` and `risk_events` are append-only; `appendAudit` recursively redacts credential-shaped
  keys and `sk-…` strings before writing.
- The lint rule forbids credential literals even in tests; the DB test builds those key names at
  runtime instead of weakening the rule.

## Next safe step
Phase 6+7: local backend skeleton (`server/app.mjs`, 127.0.0.1 only, CORS for the local frontend,
`GET /api/health`), then `BinancePrivate` (HMAC signed, recvWindow 5000, timestamp offset) with a
mock exchange for deterministic tests, followed by the LiveRiskGuard and idempotency/reconciliation.


# Long-run upgrade — cycle 3 (2026-09-18): signed exchange + live safety

## Delivered
- `server/exchange/signing.mjs` — Binance canonical query encoding (%-encoding of /, &, =, space),
  HMAC-SHA256 `signQuery` (verified against the published RFC test vector), `signedQuery` with
  timestamp + recvWindow, `maskApiKey`/`fingerprintApiKey` so the raw key is never displayed or stored.
- `server/exchange/filters.mjs` — PRICE_FILTER/LOT_SIZE/MARKET_LOT_SIZE/NOTIONAL/status handling,
  `floorToStep`, `roundToTick`, `normalizeQuantity`, `normalizePrice`, `normalizeOrder`, and a
  TTL-cached `SymbolRulesCache`. Fixed `decimalsFromStep` to count SIGNIFICANT decimals (0.00100000 -> 3).
- `server/exchange/binance-private.mjs` — signed client: automatic clock sync with offset (TTL 30 min),
  `-1021` resync, typed `BinanceApiError` (status/code/retryAfter/duplicate) and `BinanceTimeoutError`
  with `requestAccepted`; GET-only retry on 5xx; POST/DELETE are NEVER resent; withdrawal endpoints are
  hard-blocked BEFORE any network call; `describe()` exposes only masked key + fingerprint.
- `server/exchange/mock.mjs` — deterministic Binance double: verifies the exact HMAC payload and
  recvWindow like the real API, and can script 401/403, 429 (+Retry-After), 418, 500, timestamp drift,
  timeout-after-accept, partial fill, filled, canceled, duplicate clientOrderId and unknown endpoints.
- `server/services/live-risk.mjs` — LiveRiskGuard with injectable clock: kill switch (starts ENGAGED),
  maxOrderQuote, maxPositionQuote, maxPositionPct of equity, maxDailyLossPct, maxDrawdownPct,
  maxTradesPerHour, maxOpenOrders, maxConsecutiveLosses, cooldownAfterLoss, allowed/blocked symbols;
  reduce-only orders bypass size limits but never the kill switch; `snapshot()` for the UI.
- Tests: `tests/exchange.test.js` 9, `tests/binance-private.test.js` 14, `tests/live-risk.test.js` 9.

## Policy change (lint, deliberate and narrow)
The credential ban now allows `server/**` (local backend) and its two test files via an explicit
`CREDENTIAL_ALLOWED` list; the frontend (`js/**`) remains under the absolute ban, and the linter itself
documents the policy. Nothing else was weakened.

## Verification
Full gate: lint 72 files 0 warnings, 309/309 tests, runtime smoke 35 assets — PASS (3/3).

## Next safe step
Phase 6+21: `server/app.mjs` on 127.0.0.1 with `GET /api/health` {ok, db, mode}, clean shutdown,
SPUSTIT.bat health-check before opening the browser; then Phase 8 mode state machine (OFFLINE/PAPER/
TESTNET/LIVE with explicit opt-in), Phase 11 idempotency (clientOrderId + live_orders reconciliation),
Phase 12 reconciliation on startup.


# Long-run upgrade — cycle 4 (2026-09-18): local backend + launcher

## Delivered
- `server/app.mjs` — one process serves the UI and the API:
  * binds 127.0.0.1 by default; any other host is refused unless `COINRULE_ALLOW_LAN=1`;
  * `GET /api/health` -> { ok, app, version, mode, liveEnabled, db:{ok, file, schemaVersion, migrations}, uptimeMs };
  * `GET /api/ping`, JSON 404 for unknown API routes, OPTIONS preflight;
  * CORS only for loopback Origins (others get 403 `cors`), no-store + nosniff + CSP on HTML;
  * default mode PAPER, `liveEnabled:false` always after start (no implicit live);
  * clean shutdown on SIGINT/SIGTERM; `app.close({force})` is idempotent and closes the DB.
- `tools/serve.mjs` — **security fix**: static serving is now limited to an explicit allowlist
  (index.html + js/, css/, assets/). Before this, the whole repo was downloadable over HTTP,
  including `data/coinrule-studio.db` and `.git/`. Marked with PUBLIC_DIRS/PUBLIC_FILES/isPublicPath.
- `tools/open-when-ready.mjs` — polls /api/health and only then opens the browser (exported,
  unit-tested with stubbed fetch, loopback-only URLs).
- `SPUSTIT.bat` — starts `server\\app.mjs` in the foreground (Ctrl+C = clean stop) and uses the
  health-gated opener; error text now mentions port conflicts and a damaged DB.
- `package.json` — `npm start` now runs the backend.
- Tests: `tests/server-app.test.js` 8/8 (health, static+CSP, traversal/private-file refusal,
  API 404, CORS, non-loopback refusal, broken DB -> 503 + UI still served, idempotent shutdown),
  `tests/open-when-ready.test.js` 3/3.

## Runtime evidence
Started the real backend on 127.0.0.1:8899 and probed it: health 200 {mode:paper, db:true},
opener exit 0 ("Backend je pripravený"), `/server/app.mjs` -> 403, process stopped cleanly.

## Next safe step
Phase 8 mode state machine (OFFLINE/PAPER/TESTNET/LIVE, explicit opt-in, no auto-live), Phase 11
idempotency (clientOrderId + live_orders table + reconcile-before-retry), Phase 12 startup
reconciliation (openOrders/allOrders/myTrades vs local state), Phase 13 user data stream.

## Post-gate fix (same cycle)
The smoke test caught that turning unknown directories into 403 was a behaviour change; private
and escaping paths now answer **404 (not found)** in both servers, so nothing leaks whether a
private file exists. Full gate after the fix: lint 76 files, 320/320 tests, smoke 35 assets — PASS.

# Long-run upgrade — cycle 5 (2026-09-18): modes + exactly-once orders

## Delivered
- `server/services/mode.mjs` — OFFLINE/PAPER/TESTNET/LIVE machine. Default paper; testnet needs stored
  credentials; live is reachable ONLY from testnet with `confirm:"LIVE"` + `acknowledgeRisk:true`;
  offline cannot be entered from testnet/live; `disableLive()` always returns to paper; every
  transition is logged with a reason. The guard kill switch is intentionally untouched by transitions.
- `server/db/live-repository.mjs` — live sessions/orders/fills persistence (insert-or-ignore orders,
  open-order queries, UNKNOWN handling, fills, fee totals) + migration 2 with a **UNIQUE partial index
  on live_orders.client_order_id** (schema v2). `server-app` and `db` tests updated for v2.
- `server/services/idempotency.mjs` — INTENT-driven clientOrderIds: `clientOrderIdFor` is a pure hash
  of strategy+intentId+salt (no clock!), `OrderIdempotency.submit` refuses to run without an intentId
  or explicit clientOrderId, persists PENDING before the network call, skips any existing id,
  marks UNKNOWN for timeouts-after-accept and exchange duplicates (-2010) so only reconciliation can
  clear them, marks REJECTED for clean API failures. IDs are never reused for a new submission.

## Root cause fixed during the cycle
The first version derived ids with `Date.now()`, so a retry of the same intent produced a NEW id and
the mock exchange received the order twice. Caught by the new tests; ids are now deterministic and
covered by a regression test.

## Verification
Full gate: lint 81 files 0 warnings, 337/337 tests, smoke 35 assets — PASS (3/3).

## Next safe step
Phase 12 reconciliation: on session start fetch openOrders/allOrders/myTrades, resolve UNKNOWN orders,
verify local fills against exchange trades, and refuse trading until reconciliation_state = ok.
Then Phase 14 ExecutionBroker (paper/live behind one interface) and Phase 13 user data stream.


# Long-run upgrade — cycle 6 (2026-09-18): reconciliation

## Delivered
- `server/services/reconciliation.mjs` — exchange truth wins:
  * UNKNOWN/PENDING local orders are resolved from openOrders/allOrders (accepted -> synced status,
    never seen -> REJECTED with reason `never_accepted_at_exchange`);
  * exchange orders without a local row are imported as `intent_id='external'` and reported as a
    mismatch so the UI/operator can see manual or foreign orders;
  * a locally-open order missing from a FULLY fetched exchange history is a mismatch, not trust
    (guarded by `canVerifyAll` so a failed fetch never fabricates mismatches);
  * fills import idempotently by exchange trade id and link to local orders via orderId;
  * session `reconciliation_state` becomes ok/mismatch/failed; `canTradeAfterReconciliation` gates
    any trading until the state is ok.
- Mock exchange: `setTimeoutBeforeAccept()` (the request never reaches the exchange) so both timeout
  classes are testable; `setTimeoutAfterAccept()` already covered the accepted-but-unknown case.
- Tests: `tests/reconciliation.test.js` 7/7 — consistent session + fill dedupe, UNKNOWN->FILLED,
  UNKNOWN->REJECTED (never accepted), external order imported + mismatch then ok on the second pass,
  partial fill synced after cancellation, symbol-less session, ghost order flagged.

## Verification
Full gate: lint 83 files 0 warnings, 344/344 tests, smoke 35 assets — PASS (3/3).

## Next safe step
Phase 14 ExecutionBroker: one interface for PAPER/TESTNET/LIVE so the UI never talks to a client
directly (paper -> js/core/paper.js, testnet/live -> idempotency + reconciler + LiveRiskGuard), with
a hard rule that no order path bypasses the guard. Then Phase 13 (user data stream polling fallback
is already reconcilable) and Phase 15 action handlers.


# Long-run upgrade — cycle 7 (2026-09-18): ExecutionBroker

## Delivered
- `server/services/execution-broker.mjs` — the single gate for real orders. Mandatory order of checks:
  mode (TESTNET/LIVE only) -> session reconciliation must be ok -> LiveRiskGuard (kill switch, limits)
  -> exchange filters (step/tick/minNotional normalisation) -> OrderIdempotency -> exchange.
  Cancellations skip the risk gate (risk-reducing) but still require a live mode and a clean session.
  The guard reserves the ACTUAL notional computed after step normalisation (was raw before).
- Mock exchange: MARKET_LOT_SIZE step 0.00001000 (realistic) so market orders are filtered too.
- Tests `tests/execution-broker.test.js` 8/8: paper-mode refusal, unreconciled-session refusal,
  kill switch blocks placing but not cancelling, exactly-once submission, filter + risk refusals with
  zero signed requests, unknown symbol refused, reduce-only bypass.

## Verification
Full gate: lint 85 files 0 warnings, 352/352 tests, smoke 35 assets — PASS (3/3).

## Next safe step
Wire the broker + mode + guard into `server/app.mjs` HTTP endpoints (Phase 15 action handlers:
GET /api/mode, POST /api/mode/testnet|live|paper, GET /api/risk, POST /api/orders behind admin-token
auth), then Phase 13 user-data-stream polling loop, Phase 19/20 UI (Settings + Dashboard modes),
Phase 4 History UI and Phase 26 CI. Remaining UI phases need browser QA via Chrome CDP.


# Long-run upgrade — cycle 8 (2026-09-18): independent verification + hardening

## Verifier result
long-run-verifier (read-only, fresh session) returned **VERIFIED** at HEAD 81c0c4c:
gate re-run PASS (lint 85, 352/352, smoke), remote == local HEAD, no skipped/weakened/deleted tests
(286 assert lines added vs 4 replaced in the last 5 commits), and its OWN falsification scripts
confirmed: withdrawal hard block with 0 fetch calls, zero credentials in js/**, kill switch engaged
at construction, broker refusals (paper/unreconciled/kill-switch/filter) with 0 signed requests,
exactly-once submission, static 404 for server,/data,.git,package.json, and the UNIQUE partial index
on live_orders.client_order_id.

## Findings fixed immediately (all three were verifier-identified, non-blocking)
1. Withdrawal guard could be bypassed by percent-encoding (`/sapi/v1/capital/%77ithdraw/apply`):
   the guard now decodes (up to two passes) and blocks ALL /sapi/, /wapi/, /capi/ prefixes.
   Test extended to 7 blocked variants incl. encoded + uppercase, still asserting 0 HTTP requests.
2. `new TradingModeManager({ initial: 'live' })` constructed live without transitions: now refused
   for live/testnet (only offline/paper allowed as initial), covered by a test.
3. Phase 16 had no direct assertion on `result.assumptions`: added a test asserting startingCash,
   feePct, slippagePct, executionModel, participationRate, timeframeMs and candle count.

## Verification
Full gate: lint 85 files 0 warnings, 356/356 tests, smoke 35 assets — PASS (3/3).

## Remaining (honest scope)
Phases pending/partial: 2 (kline WS reconnect/stale), 4 (History UI), 13 (user data stream),
15 (HTTP action handlers for mode/orders/risk), 17 (multi-strategy accounting), 18 (append-only
write model), 19 (Settings UI Binance), 20 (Dashboard modes), 25 (testnet opt-in integration),
26 (CI). Phase 23 stays in progress until those land. Exchange round-trips are mock-verified only —
no real testnet credentials were available in this environment.
