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
