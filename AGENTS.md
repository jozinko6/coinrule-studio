# AGENTS.md — CoinRule Studio (Web pokus)

Router file for agents working in this repository.

## Mission
CoinRule Studio is a self-contained, dependency-free web application that clones the
Coinrule rule-based crypto trading platform: a visual rule builder, a large strategy
template library, live Binance market data (public endpoints, **no API keys**), a
backtesting engine and a virtual (paper) trading engine.

## Hard constraints (do not violate)
1. **No API keys.** Only Binance *public* endpoints (`/api/v3/*`, `wss://stream.binance.com`).
2. **No third-party services / SDKs.** Zero runtime npm dependencies. No CDN, no analytics.
3. **No external programs required.** Must run from a static file server (`node tools/serve.mjs`).
4. **Offline capable.** Every live feature has a deterministic synthetic fallback.
5. Never weaken or delete a test to make a gate pass.

## Layout
```
index.html            app shell (ES modules, no bundler)
css/app.css           single stylesheet
js/core/              pure, environment-agnostic engine (unit tested)
  indicators.js       65 technical indicators + pattern/divergence detectors
  rules.js            rule DSL: parse, validate, evaluate
  strategies.js       strategy template library (128 templates, 13 families)
  scanner.js          multi-symbol market scanner (12 presets, ranked output)
  alerts.js           local price/indicator alerts (no push service)
  risk.js             position sizing + risk guards
  portfolio.js        cash/positions/ledger
  paper.js            virtual broker (market/limit/stop/oco, fees, slippage)
  metrics.js          performance statistics
  backtest.js         event-driven backtester
  engine.js           shared strategy runtime (used by live + backtest)
js/data/              market data layer
  binance.js          public REST + WebSocket client (rate limited, no auth)
  synthetic.js        deterministic offline market simulator
  seed.js             bundled candle seed
  market.js           facade: live | synthetic | replay
js/store/store.js     localStorage persistence + import/export + migrations
js/ui/                DOM layer, 10 views (no top-level DOM access at import time)
js/app.js             bootstrap
tools/serve.mjs       zero-dependency static server
tools/verify.mjs      full verification entry point
tests/*.test.js       node:test suites
```

## Commands
```
node tools/serve.mjs            # run the app  -> http://localhost:8787
node --test                     # unit + integration + UI tests
node tools/verify.mjs           # full gate (lint + tests + runtime smoke)
```

## Rules for edits
- `js/core/**` and `js/data/**` must stay DOM-free so they run under `node --test`.
- `js/ui/**` must not touch `document` at module top level (only inside exported fns).
- Any new strategy must be registered in `js/core/strategies.js` and covered by
  `tests/strategies.test.js` (registry invariants are asserted).
- Any new indicator must be covered by `tests/indicators.test.js`.
- Keep money math in floats but round through `js/core/money.js` helpers.
