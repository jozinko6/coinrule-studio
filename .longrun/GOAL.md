# GOAL — CoinRule Studio

Build, inside `Web pokus`, the most detailed possible clone of Coinrule:
a rule-based crypto trading platform with a full strategy library, live Binance
market data and virtual trading, with **no API keys, no third parties and no
external programs**.

## Acceptance criteria
| # | Criterion | Evidence required |
|---|-----------|-------------------|
| AC1 | Project exists in `Web pokus` and runs locally with no install step and no runtime dependencies | `node tools/serve.mjs` serves `index.html` + all assets with HTTP 200 |
| AC2 | Rule builder: IF/AND/OR/NOT conditions + actions, multiple rules per strategy, nesting, validation errors | `tests/rules.test.js` green; UI round-trip test |
| AC3 | Strategy library covering all major families (DCA, grid, martingale, trend, mean-reversion, breakout, momentum, scalping, range, volatility, trailing, rebalancing, ...) | `tests/strategies.test.js` asserts registry size + invariants; UI lists them |
| AC4 | Binance connection over **public** endpoints only, no API key anywhere | `tests/binance.test.js` asserts URL/auth shape + no key handling; grep shows zero `apiKey` usage |
| AC5 | Virtual trading engine: market/limit/stop/trailing orders, fees, slippage, partial fills, portfolio ledger, PnL | `tests/paper.test.js` green with exact expected numbers |
| AC6 | Backtesting engine producing full performance report (return, CAGR, max DD, Sharpe, Sortino, win rate, profit factor, expectancy, trade log, monthly returns) | `tests/backtest.test.js` green; deterministic metrics |
| AC7 | 50+ indicators with reference-value tests | `tests/indicators.test.js` green |
| AC8 | Offline mode: deterministic synthetic market data, no network needed | `tests/synthetic.test.js` green; app boots with network disabled |
| AC9 | Persistence: strategies/trades/settings survive reload; import/export JSON | `tests/store.test.js` green |
| AC10 | Full verification entry point green | `node tools/verify.mjs` exit code 0 |
| AC11 | Independent verifier review PASS | long-run-verifier report |

## Explicit non-goals
- No real order placement (no API keys by design).
- No server-side database; state lives in `localStorage` + JSON export.

---

# Milestone 2 (user request 2026-09-18)

Continue in `Web pokus` and make the project as functional as possible; publish
to GitHub. React was *allowed* but not required; the zero-dependency stack is
kept deliberately because AC1 requires "no install step and no runtime
dependencies" and the existing architecture already implements the full UI.

## Additional acceptance criteria
| # | Criterion | Evidence required |
|---|-----------|-------------------|
| AC12 | Market scanner: multi-symbol scan with named presets, ranked results, click-through to chart | `tests/scanner.test.js` green; UI view renders and runs offline |
| AC13 | Price/indicator alerts: CRUD, local persistence (schema v4), evaluation against candles, trigger log, optional browser notifications | `tests/alerts.test.js` + `tests/store.test.js` green; UI view adds/checks alerts |
| AC14 | Published to GitHub with a clean repository (no secrets, `.gitignore`, README) | `gh repo view` returns the repo; `git log` shows the release commit |

## Constraints carried forward
- No API keys, no third parties, no CDN, no runtime npm dependencies.
- Never weaken or delete an existing test.
- Existing AC1-AC11 must stay green.

## Milestone 2 — delivery evidence (2026-09-18)

- AC12 Scanner: `js/core/scanner.js` + `js/ui/views/scanner.js`, 14 reference tests.
- AC13 Alerts: `js/core/alerts.js` + `js/ui/views/alerts.js`, store schema v4, 17 + 6 tests.
- Coinrule strategy coverage: 42 public Coinrule templates implemented in a new
  `coinrule` family (128 templates total), all validated and backtested by
  `tests/strategies.test.js`.
- AC14 GitHub: https://github.com/jozinko6/coinrule-studio (public), commit 700662e pushed to main.

Gate: `node tools/verify.mjs` → lint 55 files / 247 tests / 34 assets, verdict PASS.

---

# Long-run upgrade mission (user spec, 2026-09-18)

Turn the prototype into a robust local trading platform with three separated
modes: BACKTEST, PAPER TRADING, BINANCE ONLINE. Local-first Windows app,
simple launch, local SQLite DB, real Binance OHLCV for paper mode, private
Binance API via a local backend, TESTNET and separately unlocked LIVE modes,
API secrets never in the frontend, append-only audit, kill switch + risk
limits, all existing features/tests preserved.

Priority order (user-specified): CORRECTNESS → SAFETY → DATABASE → RELIABILITY
→ ONLINE TRADING → UX → new features.

## Phase status (updated as work lands)
| Phase | Status | Evidence |
|-------|--------|----------|
| 1 Engine correctness (6 issues) | **DONE** | tests/execution.test.js 12/12, full suite 267/267 |
| 2 Binance kline WS + reconnect/stale | pending | — |
| 3 SQLite DB + migrations | **DONE (core)** | server/db/*, tests/db.test.js 10/10; UI wiring pending |
| 4 History UI | pending | — |
| 5 localStorage → SQLite migration | **DONE (core)** | importLegacyState, idempotent, tested |
| 6 Local backend (127.0.0.1 only) | **DONE** | server/app.mjs (loopback guard, /api/health, CORS, static allowlist), tests/server-app.test.js 8/8 |
| 7 BinancePrivate (signed API) | **DONE (core)** | server/exchange/{signing,binance-private}.mjs; tests/exchange.test.js 9/9 + tests/binance-private.test.js 14/14 |
| 8 Trading modes state machine | **DONE (core)** | server/services/mode.mjs (offline/paper/testnet/live, testnet-first, typed confirm for live), tests/mode.test.js 9/9 |
| 9 Exchange filters | **DONE (core)** | server/exchange/filters.mjs (tick/step/notional/status), 9/9 tests |
| 10 Live risk engine + kill switch | **DONE (core)** | server/services/live-risk.mjs, tests/live-risk.test.js 9/9 (kill switch default ON) |
| 11 Idempotency | **DONE (core)** | server/services/idempotency.mjs + live-repository; deterministic intent hash ids, never resend after timeout (-2010/timeout -> UNKNOWN), tests/idempotency.test.js 8/8 |
| 12 Reconciliation | **DONE (core)** | server/services/reconciliation.mjs (UNKNOWN/PENDING resolution, external-order import + mismatch, idempotent fills, never-accepted -> REJECTED), tests/reconciliation.test.js 7/7 |
| 13 User data stream | **DONE (core)** | server/services/user-stream.mjs polling fallback (backoff, cancellable timer), stale -> kill switch ONCE, recovery never disarms; /api/stream{,/start,/stop}; tests/user-stream.test.js 7/7 |
| 14 ExecutionBroker interface | **DONE (core)** | server/services/execution-broker.mjs: mode -> reconciliation -> risk -> filters -> idempotency, cancels allowed under kill switch, tests 8/8 |
| 15 Action handler completeness | **DONE (core)** | server/app.mjs API: token auth, /api/{status,mode,risk,credentials,sessions,orders,cancel,reconcile}; server/services/trading-context.mjs; tests/api.test.js 5/5 end-to-end |
| 16 Backtest assumptions + net benchmark | **DONE** | assumptions in result, net buy&hold fee model |
| 23 Tests (full list) | in progress | 365 tests; +7 user stream, +5 HTTP API end-to-end |
| 17 Multi-strategy accounting | pending | — |
| 18 Append-only DB write model | pending | — |
| 19 Settings UI (Binance) | pending | — |
| 20 Dashboard modes | pending | — |
| 21 Windows launcher + /api/health | **DONE** | SPUSTIT.bat + tools/open-when-ready.mjs (waits for health, then opens browser), 3/3 tests + live check |
| 22 Clean shutdown | **DONE** | SIGINT/SIGTERM handler, app.close({force}) closes server + DB, idempotent, tested |

| 24 Binance mock server | **DONE** | server/exchange/mock.mjs (signature/recvWindow checks, 401/403/429/418/500, timeout-after-accept, partial fill, duplicate id) |
| 25 Testnet opt-in integration | pending | — |
| 26 CI | **DONE but BLOCKED** | .github/workflows/verify.yml active; GitHub refuses to start the job: "account is locked due to a billing issue" (external, not code) |

## Non-negotiables carried forward
- No API keys/secrets in localStorage, frontend state, logs, URLs, exports or git.
- Default mode after start: PAPER/OFFLINE. Never auto-enable live trading.
- Backend binds 127.0.0.1 by default; CORS restricted to the local frontend.
- No withdrawal endpoints, ever (hard block).
- Never weaken or delete a test.