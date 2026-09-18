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
- AC14 GitHub: pending the release commit (recorded in state.md after push).

Gate: `node tools/verify.mjs` → lint 55 files / 247 tests / 34 assets, verdict PASS.
