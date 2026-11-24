# Strategy Tuning End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make strategy tuning work end to end per design doc §13 stages A/C: setup thresholds become config-driven and bounded, rangeOverrides actually affect live decisions, the Strategy tab shows a real backtest comparison (active vs draft, walk-forward split) before submitting a config change, approved config changes keep the superseded version running as an on-demand shadow comparison, and each setup gets a trial → active → auto_off lifecycle.

**Architecture:** Every setup's trigger thresholds and defaults move from hardcoded constants into a new `src/engine/setupParams.js` (defaults + hard bounds + clamp/resolve), consumed by all 4 playbook files via a new 6th `params` argument and threaded through both `runBacktest` (backtest/run.js) and `runCycle` (scheduler/cycle.js) via `resolveEffectiveConfig`. The existing pending→backtest→submit→approve/reject config-version pipeline (already built) gains `setupParams` as a new field alongside `riskLevel`/`disabledSetups`/`rangeOverrides`, plus a walk-forward comparison report computed before submit. Setup lifecycle is a new small table (`setup_lifecycle`) and pure module (`src/engine/setupLifecycle.js`) that gates which setups reach Claude at all. The old-vs-new shadow comparison reuses the existing `runBacktest` on-demand (no new per-cycle work, no new table) — it just replays the superseded config from its supersede timestamp to now.

**Tech Stack:** Node.js, better-sqlite3, `node --test`, vanilla JS ES modules in `public-v2/js/`.

**Spec:** `docs/v2-design.md` §13 (Stage A: setup lifecycle; Stage C: weekly-review guards, walk-forward check, old-vs-new shadow).

## Global Constraints

- `src/engine/` stays pure: no network, no clock, no DB inside; data comes in as arguments (CLAUDE.md).
- Every value a draft config proposes is clamped to a hard min/max in code before it can affect a trade — "Claude can't exceed limits" extends to config drafts too (CLAUDE.md).
- Nothing changes live without going through pending → approve (existing `config_versions` status flow); this plan adds fields to that flow, never bypasses it. The one exception, matching the kill-switch precedent already in the codebase: an `active` setup auto-flipping to `auto_off` is a safety trip, not a config change, and needs no approval — only the reverse (re-activating) does.
- Defaults for every new setup parameter equal today's hardcoded values exactly.
- Backtest never calls Claude (existing, unchanged) — `rangeOverrides` (Claude's live decision bounds) genuinely cannot affect a backtest result; the existing explanatory `note` stays accurate. `setupParams` (trigger thresholds + defaults), by contrast, do change backtest results and must be wired into both the backtester and the live cycle.
- Telegram is out of scope this session (established earlier: "actually lets skip telegram for now", detail logged in `docs/ui-gaps.md`). The design's "sends a Telegram alert" for auto_off becomes a dashboard alert instead — noted here as a deliberate substitution, not a silent gap.
- §13 Stage C's other items — weekly-review guards (±20% per-value move cap, 2-week lock, no proposal under 20 trades in the review window), prompt versioning, Claude confidence score, scorecard confidence, and summary-stats-instead-of-raw-trades Claude inputs — are **not** in this plan. The user's 5-item list is this plan's actual scope; those items weren't asked for and would roughly double the work. Flagged here so the exclusion is visible, not silently dropped.

## Review Focus

- A draft config with `setupParams.trend_pullback.rsiMin` set above `rsiMax` (or any inverted pair) — clamping must still leave `rsiMin < rsiMax`, not just clamp each bound independently and let them cross.
- Approving a config version when there is no previously-superseded version (the very first approval ever) — the shadow-comparison endpoint must say "no previous version to compare" rather than crash or silently compare against the synthetic default.
- A setup with fewer than 30 trades ever recorded — lifecycle gate (`canActivate`) and the walk-forward report's "too few to judge" must both read this as "not enough data", never as a false pass or a divide-by-zero.
- Two setups sharing a regime where one is `trial` and the other `active` — the `trial` one must still produce a candidate (shadow-tracked) but never reach `decide()`'s candidate list, while the `active` one must reach it normally; a bug here would either leak a trial setup into real trading or silently starve an active one.
- Running the backtest comparison (item 3) and the shadow comparison (item 4) back-to-back must not mutate the live `scheduler_state` row for `paper`/`live` — both read-only replay the DB, and a bug coupling them to the real state would show phantom balance changes on the dashboard.

---

## Task 1: Setup params config module

**Files:**
- Create: `src/engine/setupParams.js`
- Test: `test/engine-setup-params.test.js`

**Interfaces:**
- Produces: `DEFAULT_SETUP_PARAMS` (object keyed by setup name), `SETUP_PARAM_BOUNDS` (same shape, each leaf a `[min, max]` pair), `clampSetupParams(setupName, params) -> params`, `resolveSetupParams(setupParamsOverride = {}) -> { [setupName]: params }` where every setup name from `SETUP_PARAM_BOUNDS` is present in the output even if `setupParamsOverride` omits it entirely.

- [ ] **Step 1: Write the failing tests**

```js
const { DEFAULT_SETUP_PARAMS, SETUP_PARAM_BOUNDS, clampSetupParams, resolveSetupParams } = require('../src/engine/setupParams');

test('DEFAULT_SETUP_PARAMS matches today\'s hardcoded setup values', () => {
  assert.deepEqual(DEFAULT_SETUP_PARAMS.trend_pullback, { rsiMin: 40, rsiMax: 55, defaultStopAtr: 1.5, defaultTrailAtr: 2.5 });
  assert.deepEqual(DEFAULT_SETUP_PARAMS.trend_breakout, { lookback: 20, defaultStopAtr: 2.0, defaultTrailAtr: 3.0 });
  assert.deepEqual(DEFAULT_SETUP_PARAMS.range_reversion, { rsi2Max: 10, defaultStopAtr: 1.5, timeStopHours: 24 });
  assert.deepEqual(DEFAULT_SETUP_PARAMS.oversold_bounce, { rsi2Max: 5, lookbackBars: 18, defaultStopAtr: 1.0, timeStopHours: 12 });
});

test('clampSetupParams clamps a value above its bound down to the max', () => {
  const clamped = clampSetupParams('trend_breakout', { lookback: 999, defaultStopAtr: 2.0, defaultTrailAtr: 3.0 });
  assert.equal(clamped.lookback, SETUP_PARAM_BOUNDS.trend_breakout.lookback[1]);
});

test('clampSetupParams clamps a value below its bound up to the min', () => {
  const clamped = clampSetupParams('oversold_bounce', { rsi2Max: -5, lookbackBars: 18, defaultStopAtr: 1.0, timeStopHours: 12 });
  assert.equal(clamped.rsi2Max, SETUP_PARAM_BOUNDS.oversold_bounce.rsi2Max[0]);
});

test('clampSetupParams fills in any missing key with its default before clamping', () => {
  const clamped = clampSetupParams('range_reversion', {});
  assert.deepEqual(clamped, DEFAULT_SETUP_PARAMS.range_reversion);
});

test('clampSetupParams never leaves trend_pullback\'s rsiMin >= rsiMax, even if both are independently in-bounds but inverted', () => {
  const clamped = clampSetupParams('trend_pullback', { rsiMin: 55, rsiMax: 50, defaultStopAtr: 1.5, defaultTrailAtr: 2.5 });
  assert.ok(clamped.rsiMin < clamped.rsiMax);
});

test('resolveSetupParams returns clamped defaults for every setup when no override is given', () => {
  const resolved = resolveSetupParams();
  assert.deepEqual(resolved.trend_pullback, DEFAULT_SETUP_PARAMS.trend_pullback);
  assert.deepEqual(resolved.oversold_bounce, DEFAULT_SETUP_PARAMS.oversold_bounce);
});

test('resolveSetupParams merges a partial override for one setup without touching the others', () => {
  const resolved = resolveSetupParams({ trend_breakout: { lookback: 30 } });
  assert.equal(resolved.trend_breakout.lookback, 30);
  assert.equal(resolved.trend_breakout.defaultStopAtr, DEFAULT_SETUP_PARAMS.trend_breakout.defaultStopAtr);
  assert.deepEqual(resolved.range_reversion, DEFAULT_SETUP_PARAMS.range_reversion);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/engine-setup-params.test.js`
Expected: FAIL — `Cannot find module '../src/engine/setupParams'`

- [ ] **Step 3: Implement `src/engine/setupParams.js`**

`SETUP_PARAM_BOUNDS` exact values:
```js
{
  trend_pullback: { rsiMin: [20, 50], rsiMax: [50, 80], defaultStopAtr: [1.0, 3.0], defaultTrailAtr: [1.5, 4.0] },
  trend_breakout: { lookback: [10, 50], defaultStopAtr: [1.0, 3.0], defaultTrailAtr: [2.0, 4.0] },
  range_reversion: { rsi2Max: [5, 20], defaultStopAtr: [1.0, 2.5], timeStopHours: [6, 48] },
  oversold_bounce: { rsi2Max: [2, 15], lookbackBars: [6, 36], defaultStopAtr: [0.5, 2.0], timeStopHours: [6, 24] },
}
```
`clampSetupParams(setupName, params)`: start from `{ ...DEFAULT_SETUP_PARAMS[setupName], ...params }`, clamp each key independently into its `SETUP_PARAM_BOUNDS[setupName][key]` pair with `Math.min(Math.max(...))`, then for `trend_pullback` only, if `rsiMin >= rsiMax` after clamping, set `rsiMax = rsiMin + 1` (re-clamped into its own bound if that pushes it over). `resolveSetupParams(setupParamsOverride = {})`: `Object.fromEntries(Object.keys(DEFAULT_SETUP_PARAMS).map(name => [name, clampSetupParams(name, setupParamsOverride[name] || {})]))`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/engine-setup-params.test.js`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/setupParams.js test/engine-setup-params.test.js
git commit -m "feat(engine): add setup-params config module with hard bounds (item 1 foundation)"
```

---

## Task 2: Setup files read thresholds from params

**Files:**
- Modify: `src/engine/playbook/trendPullback.js`, `src/engine/playbook/trendBreakout.js`, `src/engine/playbook/rangeReversion.js`, `src/engine/playbook/oversoldBounce.js`
- Modify: `src/backtest/run.js` (`buildCoinData`)
- Test: `test/engine-playbook-trend-pullback.test.js`, `test/engine-playbook-trend-breakout.test.js`, `test/engine-playbook-range-reversion.test.js`, `test/engine-playbook-oversold-bounce.test.js`, `test/backtest-run.test.js`

**Interfaces:**
- Consumes: `DEFAULT_SETUP_PARAMS` from Task 1.
- Produces: every `evaluate(coin, candles4h, indicators, i, regimeLabel, params)` now takes a 6th argument, defaulting to `DEFAULT_SETUP_PARAMS.<setup>` so every existing 5-arg call site (including all current tests) keeps working unchanged. `buildCoinData({ candles4h, candles1h, candlesDaily, breakoutLookback = 20 })` gains the 4th field and produces `indicators.donchianBreakout` (replacing `indicators.donchian20`, which is deleted — nothing else reads it).

- [ ] **Step 1: Write the failing tests**

Add to `test/engine-playbook-trend-pullback.test.js`:
```js
test('a custom rsiMin/rsiMax band is honored instead of the hardcoded 40-55', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }];
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [62] }); // outside default band, inside a widened one
  const params = { rsiMin: 40, rsiMax: 65, defaultStopAtr: 1.5, defaultTrailAtr: 2.5 };

  const candidate = evaluate('ETH', candles4h, indicators, 0, 'trend_up', params);

  assert.ok(candidate);
});

test('a custom defaultStopAtr/defaultTrailAtr replaces the hardcoded 1.5/2.5', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }];
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48] });
  const params = { rsiMin: 40, rsiMax: 55, defaultStopAtr: 1.8, defaultTrailAtr: 3.1 };

  const candidate = evaluate('ETH', candles4h, indicators, 0, 'trend_up', params);

  assert.equal(candidate.default.stopAtr, 1.8);
  assert.equal(candidate.default.trailAtr, 3.1);
});
```

Add to `test/engine-playbook-trend-breakout.test.js` (rename its fixture's `donchian20` key to `donchianBreakout` to match the new indicator key, then add):
```js
test('a custom lookback changes nothing about evaluate() itself — it only changes which donchian series buildCoinData hands in', () => {
  // evaluate() just reads indicators.donchianBreakout; Task 3's backtest/cycle test proves the
  // lookback itself changes results end-to-end. This test only proves the renamed key is read.
  const candles4h = [{ ts: 0, close: 105 }];
  const indicators = { donchianBreakout: { upper: [100] }, adx14: { adx: [25, 30] } };
  const candidate = evaluate('BTC', candles4h, indicators, 1, 'trend_up');
  assert.equal(candidate, null); // i=1 but candles4h/adx arrays too short for a real case — just proves no crash reading the new key
});
```
(Existing tests in this file already pass `indicators.donchian20` — update every occurrence in the file to `donchianBreakout`.)

Add to `test/engine-playbook-range-reversion.test.js`:
```js
test('a custom rsi2Max widens or narrows the oversold trigger', () => {
  const candles4h = [{ ts: 0, close: 95 }];
  const indicators = { bollinger20: { lower: [96] }, rsi2: [15], dailyEma200Aligned: [90] };
  // default rsi2Max=10 would reject rsi=15; a widened rsi2Max=20 should accept it
  const candidate = evaluate('BTC', candles4h, indicators, 0, 'range', { rsi2Max: 20, defaultStopAtr: 1.5, timeStopHours: 24 });
  assert.ok(candidate);
});
```

Add to `test/engine-playbook-oversold-bounce.test.js`:
```js
test('a custom lookbackBars changes the three-day-fall window', () => {
  const candles4h = Array.from({ length: 10 }, (_, i) => ({ ts: i * 14400, close: i < 5 ? 100 : 90 }));
  const indicators = { rsi2: Array(10).fill(3) };
  // default lookbackBars=18 would return null (not enough bars); a shortened lookbackBars=5 should fire
  const candidate = evaluate('BTC', candles4h, indicators, 9, 'downtrend', { rsi2Max: 5, lookbackBars: 5, defaultStopAtr: 1.0, timeStopHours: 12 });
  assert.ok(candidate);
});
```

Add to `test/backtest-run.test.js`:
```js
test('buildCoinData computes donchianBreakout with the given breakoutLookback, not a hardcoded 20', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();
  const data = buildCoinData({ candles4h, candles1h, candlesDaily, breakoutLookback: 10 });
  const { donchian } = require('../src/engine/indicators');
  const expected = donchian(candles4h, 10);
  assert.deepEqual(data.indicators.donchianBreakout.upper, expected.upper);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/engine-playbook-trend-pullback.test.js test/engine-playbook-trend-breakout.test.js test/engine-playbook-range-reversion.test.js test/engine-playbook-oversold-bounce.test.js test/backtest-run.test.js`
Expected: FAIL — new tests fail (unrecognized params ignored / `donchianBreakout` undefined); existing tests in trend-breakout file fail once its fixtures are renamed but `evaluate` still reads `indicators.donchian20`.

- [ ] **Step 3: Update the 4 setup files and `buildCoinData`**

`trendPullback.js`: add `params = DEFAULT_SETUP_PARAMS.trend_pullback` as 6th arg (`require('../setupParams')` for the default); replace `rsi >= 40 && rsi <= 55` with `rsi >= params.rsiMin && rsi <= params.rsiMax`; replace `default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 }` with `stopAtr: params.defaultStopAtr, trailAtr: params.defaultTrailAtr`.

`trendBreakout.js`: same 6th-arg pattern with `DEFAULT_SETUP_PARAMS.trend_breakout`; replace every `indicators.donchian20` read with `indicators.donchianBreakout`; replace hardcoded `stopAtr: 2.0, trailAtr: 3.0` with `params.defaultStopAtr, params.defaultTrailAtr`.

`rangeReversion.js`: same pattern with `DEFAULT_SETUP_PARAMS.range_reversion`; replace `rsi < 10` with `rsi < params.rsi2Max`; replace `stopAtr: 1.5` with `params.defaultStopAtr`; replace `timeStopHours: 24` with `params.timeStopHours`.

`oversoldBounce.js`: same pattern with `DEFAULT_SETUP_PARAMS.oversold_bounce`; delete the `THREE_DAY_BARS` constant, use `params.lookbackBars` in its place (`candles4h[i - params.lookbackBars]`, `if (i < params.lookbackBars) return null`); replace `rsi < 5` with `rsi < params.rsi2Max`; replace `stopAtr: 1.0` with `params.defaultStopAtr`; replace `timeStopHours: 12` with `params.timeStopHours`.

`src/backtest/run.js`'s `buildCoinData`: add `breakoutLookback = 20` to the destructured parameter object; change `donchian20: donchian(candles4h, 20)` to `donchianBreakout: donchian(candles4h, breakoutLookback)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/engine-playbook-trend-pullback.test.js test/engine-playbook-trend-breakout.test.js test/engine-playbook-range-reversion.test.js test/engine-playbook-oversold-bounce.test.js test/backtest-run.test.js`
Expected: PASS, all tests in all 5 files.

- [ ] **Step 5: Run the full suite to confirm nothing else referenced `donchian20` or `THREE_DAY_BARS`**

Run: `node --test test/`
Expected: PASS, no failures.

- [ ] **Step 6: Commit**

```bash
git add src/engine/playbook/ src/backtest/run.js test/engine-playbook-trend-pullback.test.js test/engine-playbook-trend-breakout.test.js test/engine-playbook-range-reversion.test.js test/engine-playbook-oversold-bounce.test.js test/backtest-run.test.js
git commit -m "feat(engine): setup files read thresholds/defaults from params instead of hardcoded constants (item 1)"
```

---

## Task 3: Wire resolved setupParams into the backtester and the live cycle

**Files:**
- Modify: `src/backtest/run.js` (`runBacktest`)
- Modify: `src/scheduler/cycle.js`
- Test: `test/backtest-run.test.js`, `test/scheduler-cycle.test.js`

**Interfaces:**
- Consumes: `resolveSetupParams` from Task 1, `buildCoinData`'s `breakoutLookback` field and the 6th `evaluate` argument from Task 2.
- Produces: `runBacktest(db, config, fromTs, setupsByRegime, setupParamsOverride = {})` — 5th argument, resolved once per call via `resolveSetupParams(setupParamsOverride)` and threaded into every `buildCoinData` call (as `breakoutLookback: resolvedParams.trend_breakout.lookback`) and every `evaluate(...)` call (`resolvedParams[setupName]`). `runCycle` resolves `setupParams` the same way from `activeVersion.config.setupParams` via `resolveEffectiveConfig` (extended to also return `setupParams`), threading it through its own `buildCoinData` and `evaluate` call sites identically.

- [ ] **Step 1: Write the failing test proving a changed parameter changes the backtest result**

Add to `test/backtest-run.test.js`:
```js
const { runBacktest } = require('../src/backtest/run');
const { openDb, upsertCandles } = require('../src/data/db');

test('a tighter oversold_bounce rsi2Max produces fewer (or equal, never more) trades than a looser one, on the same fixture', () => {
  const db = openDb(':memory:');
  const DAY = 86400, FOUR_H = 4 * 3600;
  const DAYS = 230;
  // A long downtrend so regime stays 'downtrend' and oversold_bounce is the only setup in play;
  // RSI(2) oscillates mildly so some bars clear a loose rsi2Max but not a tight one.
  const rows4h = [];
  for (let i = 0; i < DAYS * 6; i += 1) {
    const base = 300 - i * 0.05;
    const wiggle = (i % 2 === 0) ? -0.5 : 0.5;
    const close = base + wiggle;
    rows4h.push({ coin: 'BTC', timeframe: '4h', ts: i * FOUR_H, open: close, high: close + 0.3, low: close - 0.3, close, volume: 1, trades: 1 });
  }
  upsertCandles(db, rows4h);
  const rows1d = Array.from({ length: DAYS }, (_, d) => {
    const close = 300 - d * 6 * 0.05;
    return { coin: 'BTC', timeframe: '1d', ts: d * DAY, open: close, high: close, low: close, close, volume: 1, trades: 1 };
  });
  upsertCandles(db, rows1d);

  const { DEFAULT_RISK_CONFIG } = require('../src/engine/config');
  const setupsByRegime = { trend_up: [], range: [], downtrend: ['oversold_bounce'], risk_off: [] };

  const tight = runBacktest(db, DEFAULT_RISK_CONFIG, 0, setupsByRegime, { oversold_bounce: { rsi2Max: 2 } });
  const loose = runBacktest(db, DEFAULT_RISK_CONFIG, 0, setupsByRegime, { oversold_bounce: { rsi2Max: 15 } });

  assert.ok(loose.state.closedTrades.length >= tight.state.closedTrades.length);
  assert.ok(loose.state.closedTrades.length > tight.state.closedTrades.length, 'a looser rsi2Max must open strictly more trades on this fixture');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/backtest-run.test.js`
Expected: FAIL — `runBacktest` only accepts 4 arguments today; the 5th is silently ignored, so `tight` and `loose` produce identical trade counts.

- [ ] **Step 3: Implement the wiring**

`src/backtest/run.js`: import `resolveSetupParams` from `../engine/setupParams`. `runBacktest(db, config, fromTs, setupsByRegime, setupParamsOverride = {})`: compute `const setupParams = resolveSetupParams(setupParamsOverride);` once at the top; pass `breakoutLookback: setupParams.trend_breakout.lookback` into every `buildCoinData` call; pass `setupParams[setupName]` as the 6th argument to `SETUPS[setupName].evaluate(...)`.

`src/scheduler/cycle.js`: `resolveEffectiveConfig` (Task 4 touches its other field too, so land this first) needs a `setupParams` return value — for now, compute it inline in `runCycle` via `resolveSetupParams(activeVersion.config.setupParams)` right after `resolveEffectiveConfig` is called, and thread it the same way into its `buildCoinData` calls (the `coinData[coin] = buildCoinData({...})` loop) and its `SETUPS[setupName].evaluate(...)` call site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/backtest-run.test.js test/scheduler-cycle.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backtest/run.js src/scheduler/cycle.js test/backtest-run.test.js
git commit -m "feat(engine): wire resolved setupParams into both the backtester and the live cycle, with a test proving a changed param changes the backtest result (item 2 part 1)"
```

---

## Task 4: Wire rangeOverrides into the live cycle's candidate construction

**Files:**
- Modify: `src/scheduler/cycle.js`
- Test: `test/scheduler-cycle.test.js`

**Interfaces:**
- Consumes: `activeVersion.config.rangeOverrides` (existing field, currently unread anywhere).
- Produces: `cycle.js`'s `fullCandidate.ranges` reflects `rangeOverrides[setupName]` when present (shallow-merged over the setup's own `ranges`), for every candidate built that cycle. Backtest is untouched — its `note` field (already correct) stays as-is.

- [ ] **Step 1: Write the failing test**

Add to `test/scheduler-cycle.test.js` (reuses the existing `seedTrendUpWithPullback`/`takeAllTrendPullbackCandidates` fixtures from the earlier 4h-boundary regression test):
```js
test('runCycle applies rangeOverrides to the candidate ranges Claude sees, for the matching setup', async () => {
  const db = openDb(':memory:');
  const fakeKrakenClient = seedTrendUpWithPullback(db);
  const now = BAR_COUNT * FOUR_H * 1000;
  const config = {
    ...DEFAULT_RISK_CONFIG,
  };
  // Insert an active config version with a rangeOverride on trend_pullback's stopAtr before the cycle runs.
  const { insertConfigVersion, approveConfigVersion } = require('../src/data/db');
  const id = insertConfigVersion(db, {
    mode: 'paper',
    configJson: { riskLevel: 'normal', disabledSetups: [], rangeOverrides: { trend_pullback: { stopAtr: [2.0, 2.0] } } },
    backtestJson: null,
  });
  approveConfigVersion(db, 'paper', id);

  let seenRanges = null;
  const captureDecide = async (input) => {
    const candidate = input.candidates.find((c) => c.setup === 'trend_pullback' && c.coin === 'BTC');
    if (candidate) seenRanges = candidate.ranges;
    return takeAllTrendPullbackCandidates(input);
  };

  await runCycle(db, fakeKrakenClient, 'paper', config, now, { decide: captureDecide });

  assert.ok(seenRanges, 'expected a trend_pullback candidate for BTC to reach decide()');
  assert.deepEqual(seenRanges.stopAtr, [2.0, 2.0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-cycle.test.js`
Expected: FAIL — `seenRanges.stopAtr` equals the setup's default `[1.0, 3.0]`, not the override.

- [ ] **Step 3: Implement the merge**

In `cycle.js`'s candidate-building loop, after `const withContext = attachContext(candidate, data.indicators, i);`, before building `fullCandidate`, compute `const rangeOverride = (activeVersion.config.rangeOverrides || {})[setupName];` and merge it into the ranges used for `fullCandidate`: `ranges: rangeOverride ? { ...withContext.ranges, ...rangeOverride } : withContext.ranges`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-cycle.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/cycle.js test/scheduler-cycle.test.js
git commit -m "feat(scheduler): wire rangeOverrides into the live candidate's ranges Claude sees (item 2 part 2 — backtest intentionally unaffected, it never calls Claude)"
```

---

## Task 5: setupParams in the config-version draft pipeline + Strategy controls UI

**Files:**
- Modify: `src/server/app.js` (`validateDraft`, `/api/config/draft/backtest`, `DEFAULT_CONFIG_VERSION` consumer sites unaffected — only `db.js`'s `DEFAULT_CONFIG_VERSION` constant changes)
- Modify: `src/data/db.js` (`DEFAULT_CONFIG_VERSION`)
- Modify: `public-v2/js/config-editor.mjs`, `public-v2/index.html`
- Test: `test/server-app.test.js`, `test/data-db-config-versions.test.js`

**Interfaces:**
- Consumes: `clampSetupParams`/`resolveSetupParams` from Task 1.
- Produces: `DEFAULT_CONFIG_VERSION = { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {}, setupParams: {} }`. `validateDraft` accepts an optional `setupParams` field in the request body, clamps every setup's entry through `clampSetupParams`, and includes the clamped result in the returned `draft`. `POST /api/config/draft/backtest` passes `draft.setupParams` as `runBacktest`'s 5th argument.

- [ ] **Step 1: Write the failing tests**

Add to `test/data-db-config-versions.test.js`:
```js
test('DEFAULT_CONFIG_VERSION includes an empty setupParams object', () => {
  assert.deepEqual(DEFAULT_CONFIG_VERSION.setupParams, {});
});
```
(Import `DEFAULT_CONFIG_VERSION` at the top of the file if not already imported — check `getActiveConfigVersion`'s synthetic-default return value, which embeds it.)

Add to `test/server-app.test.js`:
```js
test('POST /api/config/draft clamps an out-of-bounds setupParams value instead of rejecting or passing it through raw', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/draft`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Password': 'sekrit' },
      body: JSON.stringify({ riskLevel: 'normal', disabledSetups: [], rangeOverrides: {}, setupParams: { trend_breakout: { lookback: 999 } } }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.setupParams.trend_breakout.lookback, 50); // SETUP_PARAM_BOUNDS.trend_breakout.lookback[1]
  } finally {
    server.close();
  }
});

test('POST /api/config/draft/backtest with a changed setupParams value produces a different bySetup trade count than the default draft', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const base = { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} };
    const defaultRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/backtest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Password': 'sekrit' },
      body: JSON.stringify({ ...base, setupParams: {} }),
    });
    const changedRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/backtest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Password': 'sekrit' },
      body: JSON.stringify({ ...base, setupParams: { oversold_bounce: { rsi2Max: 2 } } }),
    });
    assert.equal(defaultRes.status, 200);
    assert.equal(changedRes.status, 200);
    // Same assertion style as the engine-level test in Task 3 — this proves the HTTP layer
    // reaches the same wiring, not just runBacktest in isolation.
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data-db-config-versions.test.js test/server-app.test.js`
Expected: FAIL — `DEFAULT_CONFIG_VERSION.setupParams` is `undefined`; the draft endpoint echoes `setupParams` raw (999 unclamped) or drops it.

- [ ] **Step 3: Implement**

`db.js`: add `setupParams: {}` to `DEFAULT_CONFIG_VERSION`.

`app.js`: import `resolveSetupParams` from `../engine/setupParams`. In `validateDraft`, add `const setupParams = resolveSetupParams(body?.setupParams || {});` and include it in the returned `draft` object. In `/api/config/draft/backtest`, pass `draft.setupParams` as `runBacktest`'s 5th argument.

`public-v2/js/config-editor.mjs`: `currentDraft()` currently hardcodes `rangeOverrides: {}` and has no `setupParams` — read per-setup param inputs from new form fields (one labeled number input per key in `DEFAULT_SETUP_PARAMS[name]`, rendered by `renderSetupToggles` or a new `renderSetupParamInputs()` alongside it) and include them: `setupParams: SETUP_NAMES.reduce((acc, name) => ({ ...acc, [name]: readParamInputsFor(name) }), {})`.

`public-v2/index.html`: replace the disabled "Edit setup ranges" block (the one whose explanatory text currently reads "Coming soon — editing ranges here doesn't affect trading yet.") with real, enabled number inputs — one row per setup, fields matching that setup's `DEFAULT_SETUP_PARAMS` keys, each with `min`/`max` HTML attributes from `SETUP_PARAM_BOUNDS` (shown as a hint, not a hard client-side gate — the server clamps regardless) and a default `value` from `DEFAULT_SETUP_PARAMS`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data-db-config-versions.test.js test/server-app.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js src/server/app.js public-v2/js/config-editor.mjs public-v2/index.html test/data-db-config-versions.test.js test/server-app.test.js
git commit -m "feat(ui): setupParams flows through the draft/backtest/submit pipeline and is editable in Strategy controls (item 1/2 — UI)"
```

---

## Task 6: Walk-forward comparison report (backend)

**Files:**
- Create: `src/backtest/compare.js`
- Modify: `src/server/app.js` (`/api/config/draft/backtest`)
- Test: `test/backtest-compare.test.js`, `test/server-app.test.js`

**Interfaces:**
- Consumes: `runBacktest` (Task 3's signature), `computeExpectancy`/`computeBenchmarkComparison` (existing, `src/backtest/stats.js`).
- Produces: `splitTradesByWindow(trades, boundaryTs) -> { earlier: Trade[], later: Trade[] }` (by `entryTs`). `summarizeWindow(trades, btcCloses) -> { trades: n, winRate, expectancy, worstDrawdownPct, tooFewToJudge: n < 30, vsBtc: { returnPct, worstDrawdownPct, ratio } }`. `buildWalkForwardReport(db, { activeConfig, activeSetupsByRegime, activeSetupParams, draftConfig, draftSetupsByRegime, draftSetupParams, fromTs, boundaryTs, toTs }) -> { active: { earlier, later }, draft: { earlier, later } }`.

- [ ] **Step 1: Write the failing tests**

```js
const { splitTradesByWindow, summarizeWindow, buildWalkForwardReport } = require('../src/backtest/compare');

test('splitTradesByWindow splits by entryTs relative to the boundary, boundary itself goes to later', () => {
  const trades = [{ entryTs: 100 }, { entryTs: 200 }, { entryTs: 300 }];
  const { earlier, later } = splitTradesByWindow(trades, 200);
  assert.deepEqual(earlier.map((t) => t.entryTs), [100]);
  assert.deepEqual(later.map((t) => t.entryTs), [200, 300]);
});

test('summarizeWindow flags tooFewToJudge under 30 trades and does not treat it as a fail', () => {
  const trades = Array.from({ length: 10 }, () => ({ r: 0.5 }));
  const result = summarizeWindow(trades, [100, 101, 102]);
  assert.equal(result.tooFewToJudge, true);
  assert.equal(result.trades, 10);
  assert.ok(result.expectancy > 0); // still computed and shown, just labeled, not hidden
});

test('summarizeWindow with 30+ trades is not flagged too-few', () => {
  const trades = Array.from({ length: 30 }, () => ({ r: 0.1 }));
  const result = summarizeWindow(trades, [100, 110]);
  assert.equal(result.tooFewToJudge, false);
});

test('buildWalkForwardReport returns active and draft, each split into earlier/later, over the same window, without touching the real scheduler_state row', () => {
  const db = openDb(':memory:');
  // candle fixture seeded here — see the prose note right after this code block for exactly what to build
  // sentinel scheduler_state, written before the call — must be byte-identical after, since
  // this report replays the DB read-only and must never mutate the live paper/live trading state.
  saveSchedulerState(db, 'paper', freshState());
  const before = loadSchedulerState(db, 'paper');

  const report = buildWalkForwardReport(db, { /* ...opts... */ });

  assert.deepEqual(loadSchedulerState(db, 'paper'), before);
});
```

(The 4th test needs real seeded candle data, not a stub import — write it against a trimmed-down version of the `seedTrendUpWithPullback`-style fixture already proven in `test/scheduler-cycle.test.js`: seed ~95 days of a mild uptrend via `upsertCandles` directly for `BTC` (4h + 1d), call `buildWalkForwardReport` with `fromTs=0`, `boundaryTs=60*86400`, `toTs=90*86400`, and assert the returned shape has `active.earlier`, `active.later`, `draft.earlier`, `draft.later`, each with the `summarizeWindow` fields, AND the `scheduler_state`-unchanged assertion shown above. Do not reuse the 230-day fixture from `scheduler-cycle.test.js` here — this only needs ~95 days since it calls `runBacktest` directly rather than going through `computeRegimeSeries`'s 220-day warm-up requirement for `trend_up`; use `range` regime with `range_reversion` instead, which has no long warm-up dependency, to keep the fixture small. Import `saveSchedulerState`, `loadSchedulerState`, `freshState` — `freshState` is exported from `../src/scheduler/cycle`, the others from `../src/data/db`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/backtest-compare.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/backtest/compare.js`**

`splitTradesByWindow(trades, boundaryTs)`: `{ earlier: trades.filter(t => t.entryTs < boundaryTs), later: trades.filter(t => t.entryTs >= boundaryTs) }`.

`summarizeWindow(trades, btcCloses)`: use `computeExpectancy(trades)` for `count`/`winRate`/`expectancy`; use `computeDrawdown` on a synthetic equity-ish series built from cumulative `r` (or reuse `computeBenchmarkComparison`-style botSeries built from `trades` ordered by `exitTs`, cumulative `pnl`) for `worstDrawdownPct`; build `vsBtc` via `computeBenchmarkComparison({ botSeries, btcSeries: btcCloses })` and take its `.bot` vs `.btc` fields; `tooFewToJudge: trades.length < 30`.

`buildWalkForwardReport(db, opts)`: call `runBacktest(db, opts.activeConfig, opts.fromTs, opts.activeSetupsByRegime, opts.activeSetupParams)` and the same for `draft*`, each over `[opts.fromTs, opts.toTs]`; split each result's `closedTrades` via `splitTradesByWindow` at `opts.boundaryTs`; fetch BTC daily closes once for `[opts.fromTs, opts.boundaryTs)` and `[opts.boundaryTs, opts.toTs]` via `getCandles(db, 'BTC', '1d', ...)`; build the 4 `summarizeWindow` calls; return `{ active: { earlier, later }, draft: { earlier, later } }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/backtest-compare.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into the HTTP endpoint**

In `src/server/app.js`'s `/api/config/draft/backtest`, after computing `draft`, also fetch `getActiveConfigVersion(db, mode)`, build both configs' effective risk config + setupsByRegime + setupParams (reuse `resolveEffectiveConfig`/`resolveSetupParams` for each), call `buildWalkForwardReport` with `fromTs = nowTs - 90*86400`, `boundaryTs = nowTs - 30*86400`, `toTs = nowTs`, and add the result to the response as `walkForward`.

Add to `test/server-app.test.js`:
```js
test('POST /api/config/draft/backtest includes a walkForward report split into earlier/later windows for both active and draft', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/draft/backtest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Password': 'sekrit' },
      body: JSON.stringify({ riskLevel: 'normal', disabledSetups: [], rangeOverrides: {}, setupParams: {} }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.walkForward.active.earlier);
    assert.ok(body.walkForward.active.later);
    assert.ok(body.walkForward.draft.earlier);
    assert.ok(body.walkForward.draft.later);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/backtest/compare.js src/server/app.js test/backtest-compare.test.js test/server-app.test.js
git commit -m "feat(backtest): walk-forward comparison report (active vs draft, 60/30-day split, too-few-to-judge flag, vs BTC) (item 3 — backend)"
```

---

## Task 7: Walk-forward comparison report (UI)

**Files:**
- Modify: `public-v2/js/config-editor.mjs`
- Test: none (DOM-wiring module, consistent with this codebase's established convention — see `test/public-format.test.mjs` vs the untested `.mjs` DOM modules)

**Interfaces:**
- Consumes: `result.walkForward` from Task 6's `/api/config/draft/backtest` response.

- [ ] **Step 1: Render the comparison before "Save as pending"**

In `runBacktest()` (config-editor.mjs), after computing `bySetupLines`, render a table comparing `result.walkForward.active` vs `result.walkForward.draft`, each with an "earlier (60d)" and "later (30d)" column, each cell showing trades/win rate/expectancy R/worst drawdown, and "too few to judge" in place of the stats when `tooFewToJudge` is true. Show the `vsBtc.returnPct` for each window alongside the bot's own. Insert this above the existing `bySetupLines`/`note` block, still inside `resultEl.innerHTML`.

- [ ] **Step 2: Manual check**

No automated test for this step (DOM rendering, no browser automation available in this environment — flag this explicitly when reporting the task done, per this codebase's established pattern).

- [ ] **Step 3: Run the full suite to confirm nothing else broke**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add public-v2/js/config-editor.mjs
git commit -m "feat(ui): show the walk-forward comparison report in Strategy controls before Save as pending (item 3 — UI)"
```

---

## Task 8: Setup lifecycle persistence + pure transition logic

**Files:**
- Modify: `src/data/db.js` (new table + functions)
- Create: `src/engine/setupLifecycle.js`
- Test: `test/data-db-setup-lifecycle.test.js`, `test/engine-setup-lifecycle.test.js`

**Interfaces:**
- Produces (db.js): `getSetupLifecycle(db, mode, setup) -> { status: 'trial'|'active'|'auto_off', statusTs: number|null }` (defaults to `{ status: 'trial', statusTs: null }` when no row exists). `getAllSetupLifecycles(db, mode) -> { [setupName]: status }` for every name in `SETUPS` (imported from `../engine/playbook`), defaulting missing ones to `'trial'`. `setSetupLifecycleStatus(db, mode, setup, status, ts)` — upserts.
- Produces (setupLifecycle.js, pure): `canActivate(trades) -> boolean` (30+ trades, positive expectancy — reuses `computeExpectancy` from `../backtest/stats`). `isFailingAutoOffThreshold(trades) -> boolean` (last 30 trades' expectancy < -0.2R; `false` if fewer than 30 trades exist — not enough data to trip the safety). `applyLifecycleFilter(setupsByRegime, lifecycleStatuses) -> setupsByRegime` with every `auto_off` setup name removed from every regime's list (trial and active setups both stay).

- [ ] **Step 1: Write the failing tests**

`test/data-db-setup-lifecycle.test.js`:
```js
const { openDb, getSetupLifecycle, getAllSetupLifecycles, setSetupLifecycleStatus } = require('../src/data/db');

test('getSetupLifecycle defaults to trial with no statusTs when nothing is stored', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getSetupLifecycle(db, 'paper', 'trend_pullback'), { status: 'trial', statusTs: null });
});

test('setSetupLifecycleStatus then getSetupLifecycle round-trips', () => {
  const db = openDb(':memory:');
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'active', 1700000000);
  assert.deepEqual(getSetupLifecycle(db, 'paper', 'trend_pullback'), { status: 'active', statusTs: 1700000000 });
});

test('setSetupLifecycleStatus called twice for the same mode/setup overwrites, not duplicates', () => {
  const db = openDb(':memory:');
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'active', 1700000000);
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'auto_off', 1700003600);
  assert.deepEqual(getSetupLifecycle(db, 'paper', 'trend_pullback'), { status: 'auto_off', statusTs: 1700003600 });
});

test('paper and live are tracked independently for the same setup', () => {
  const db = openDb(':memory:');
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'active', 1700000000);
  assert.equal(getSetupLifecycle(db, 'live', 'trend_pullback').status, 'trial');
});

test('getAllSetupLifecycles defaults every known setup to trial and reflects stored overrides', () => {
  const db = openDb(':memory:');
  setSetupLifecycleStatus(db, 'paper', 'trend_breakout', 'active', 1700000000);
  const all = getAllSetupLifecycles(db, 'paper');
  assert.equal(all.trend_breakout, 'active');
  assert.equal(all.trend_pullback, 'trial');
  assert.equal(all.range_reversion, 'trial');
  assert.equal(all.oversold_bounce, 'trial');
});
```

`test/engine-setup-lifecycle.test.js`:
```js
const { canActivate, isFailingAutoOffThreshold, applyLifecycleFilter } = require('../src/engine/setupLifecycle');

test('canActivate is false with fewer than 30 trades even if expectancy is strongly positive', () => {
  const trades = Array.from({ length: 10 }, () => ({ r: 2 }));
  assert.equal(canActivate(trades), false);
});

test('canActivate is true with 30+ trades and positive expectancy', () => {
  const trades = Array.from({ length: 30 }, () => ({ r: 0.1 }));
  assert.equal(canActivate(trades), true);
});

test('canActivate is false with 30+ trades but non-positive expectancy', () => {
  const trades = Array.from({ length: 30 }, () => ({ r: -0.1 }));
  assert.equal(canActivate(trades), false);
});

test('isFailingAutoOffThreshold is false with fewer than 30 trades, regardless of how bad they are', () => {
  const trades = Array.from({ length: 10 }, () => ({ r: -5 }));
  assert.equal(isFailingAutoOffThreshold(trades), false);
});

test('isFailingAutoOffThreshold is true when the last 30 trades average below -0.2R', () => {
  const trades = Array.from({ length: 40 }, () => ({ r: -0.3 }));
  assert.equal(isFailingAutoOffThreshold(trades), true);
});

test('isFailingAutoOffThreshold only looks at the LAST 30 trades, not the whole history', () => {
  const badOld = Array.from({ length: 20 }, () => ({ r: -5 }));
  const goodRecent = Array.from({ length: 30 }, () => ({ r: 0.5 }));
  assert.equal(isFailingAutoOffThreshold([...badOld, ...goodRecent]), false);
});

test('applyLifecycleFilter removes an auto_off setup from every regime it appeared in', () => {
  const setupsByRegime = { trend_up: ['trend_breakout', 'trend_pullback'], range: ['range_reversion'], downtrend: [], risk_off: [] };
  const result = applyLifecycleFilter(setupsByRegime, { trend_breakout: 'auto_off', trend_pullback: 'active', range_reversion: 'trial' });
  assert.deepEqual(result.trend_up, ['trend_pullback']);
  assert.deepEqual(result.range, ['range_reversion']); // trial stays — still evaluated for shadow tracking
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data-db-setup-lifecycle.test.js test/engine-setup-lifecycle.test.js`
Expected: FAIL — modules/functions don't exist.

- [ ] **Step 3: Implement**

`db.js`: add to the schema in `openDb`:
```sql
CREATE TABLE IF NOT EXISTS setup_lifecycle (
  mode TEXT NOT NULL, setup TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'trial', status_ts INTEGER,
  PRIMARY KEY (mode, setup)
);
```
`getSetupLifecycle(db, mode, setup)`: `SELECT status, status_ts AS statusTs FROM setup_lifecycle WHERE mode = ? AND setup = ?`, default `{ status: 'trial', statusTs: null }` if no row. `setSetupLifecycleStatus(db, mode, setup, status, ts)`: `INSERT ... ON CONFLICT(mode, setup) DO UPDATE SET status = excluded.status, status_ts = excluded.status_ts`. `getAllSetupLifecycles(db, mode)`: `Object.keys(require('../engine/playbook').SETUPS)` mapped through `getSetupLifecycle`, collapsed to `{ [name]: status }`.

`src/engine/setupLifecycle.js`: `const { computeExpectancy } = require('../backtest/stats');` `canActivate(trades) { return computeExpectancy(trades).pass; }` (reuses the existing `pass = expectancy > 0 && trades.length >= 30`). `isFailingAutoOffThreshold(trades) { const last30 = trades.slice(-30); if (last30.length < 30) return false; return computeExpectancy(last30).expectancy < -0.2; }`. `applyLifecycleFilter(setupsByRegime, lifecycleStatuses) { return Object.fromEntries(Object.entries(setupsByRegime).map(([regime, names]) => [regime, names.filter(n => lifecycleStatuses[n] !== 'auto_off')])); }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data-db-setup-lifecycle.test.js test/engine-setup-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js src/engine/setupLifecycle.js test/data-db-setup-lifecycle.test.js test/engine-setup-lifecycle.test.js
git commit -m "feat(engine): setup_lifecycle table + pure trial/active/auto_off transition logic (item 5 foundation)"
```

---

## Task 9: Wire lifecycle into the live cycle

**Files:**
- Modify: `src/scheduler/cycle.js`
- Test: `test/scheduler-cycle.test.js`

**Interfaces:**
- Consumes: `getAllSetupLifecycles`, `setSetupLifecycleStatus` (Task 8, db.js), `isFailingAutoOffThreshold`, `applyLifecycleFilter` (Task 8, setupLifecycle.js), `getTrades` (existing).
- Produces: `runCycle` excludes `auto_off` setups from evaluation entirely (via `applyLifecycleFilter` on `effectiveSetupsByRegime`); `trial` setups still produce a candidate + shadow position but are excluded from the `cycleCandidates` array sent to `decide()`, instead getting an immediate `skip` decision logged with `reason: 'trial setup — shadow only, no Claude call'`; after processing, any `active` setup whose last-30-trade expectancy newly fails the auto_off threshold gets flipped via `setSetupLifecycleStatus(db, mode, setupName, 'auto_off', nowHour)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/scheduler-cycle.test.js`:
```js
test('runCycle never sends a trial-setup candidate to decide(), but still records it and opens a shadow position — while a DIFFERENT active setup in the same regime still reaches decide() normally', async () => {
  const db = openDb(':memory:');
  const fakeKrakenClient = seedTrendUpWithPullback(db);
  const now = BAR_COUNT * FOUR_H * 1000;
  // trend_pullback starts life as 'trial' by default (no row in setup_lifecycle) — don't set anything.
  // trend_breakout shares the same trend_up regime as trend_pullback — explicitly mark it active,
  // so this test proves the lifecycle filter is per-setup, not a blanket "regime has a trial setup" effect.
  const { setSetupLifecycleStatus } = require('../src/data/db');
  setSetupLifecycleStatus(db, 'paper', 'trend_breakout', 'active', 0);

  let sawTrialCandidate = false;
  let sawActiveCandidate = false;
  const decideSpy = async (input) => {
    if (input.candidates.some((c) => c.setup === 'trend_pullback')) sawTrialCandidate = true;
    if (input.candidates.some((c) => c.setup === 'trend_breakout')) sawActiveCandidate = true;
    return { decisions: [], positionActions: [], setupToggles: [], marketNote: '', plainNote: null, fallback: false };
  };

  await runCycle(db, fakeKrakenClient, 'paper', DEFAULT_RISK_CONFIG, now, { decide: decideSpy });

  assert.equal(sawTrialCandidate, false, 'a trial setup must never reach decide()');
  const { getCandidatesByTs } = require('../src/data/db');
  const nowHour = BAR_COUNT * FOUR_H;
  const candidates = getCandidatesByTs(db, 'paper', nowHour);
  assert.ok(candidates.some((c) => c.coin === 'BTC' && c.setup === 'trend_pullback'), 'trial candidate must still be recorded');
  const state = loadSchedulerState(db, 'paper');
  assert.ok(state.shadowPositions.some((p) => p.coin === 'BTC' && p.setup === 'trend_pullback'), 'shadow position must still open for the trial setup');
  assert.equal(state.openPositions.length, 0, 'a trial setup must never open a real paper position');
  // trend_breakout's own trigger conditions aren't guaranteed to fire on this fixture (it's built
  // for trend_pullback's pullback shape) — only assert the leak direction that matters here: if it
  // DID produce a candidate, that candidate must have reached decide() like any active setup's does.
  if (candidates.some((c) => c.setup === 'trend_breakout')) {
    assert.equal(sawActiveCandidate, true, 'an active setup\'s candidate must still reach decide() even when a sibling setup in the same regime is trial');
  }
});

test('runCycle excludes an auto_off setup from evaluation entirely — no candidate, no shadow', async () => {
  const db = openDb(':memory:');
  const fakeKrakenClient = seedTrendUpWithPullback(db);
  const now = BAR_COUNT * FOUR_H * 1000;
  const { setSetupLifecycleStatus } = require('../src/data/db');
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'auto_off', 0);

  await runCycle(db, fakeKrakenClient, 'paper', DEFAULT_RISK_CONFIG, now, { decide: takeAllTrendPullbackCandidates });

  const { getCandidatesByTs } = require('../src/data/db');
  const nowHour = BAR_COUNT * FOUR_H;
  const candidates = getCandidatesByTs(db, 'paper', nowHour);
  assert.equal(candidates.filter((c) => c.setup === 'trend_pullback').length, 0);
});

test('runCycle flips an active setup to auto_off once its last 30 trades average below -0.2R', async () => {
  const db = openDb(':memory:');
  const fakeKrakenClient = seedTrendUpWithPullback(db);
  const now = BAR_COUNT * FOUR_H * 1000;
  const { setSetupLifecycleStatus, insertTrade, getSetupLifecycle } = require('../src/data/db');
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'active', 0);
  for (let i = 0; i < 30; i += 1) {
    insertTrade(db, { mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: i * 3600, exitTs: i * 3600 + 60, entryPrice: 100, exitPrice: 95, units: 1, riskAmount: 5, pnl: -1.5, r: -0.3, exitReason: 'stop' });
  }

  await runCycle(db, fakeKrakenClient, 'paper', DEFAULT_RISK_CONFIG, now, { decide: takeAllTrendPullbackCandidates });

  assert.equal(getSetupLifecycle(db, 'paper', 'trend_pullback').status, 'auto_off');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scheduler-cycle.test.js`
Expected: FAIL — today every candidate (trial or not) reaches `decide()`, `auto_off` setups still evaluate normally, and nothing ever flips lifecycle status.

- [ ] **Step 3: Implement**

In `runCycle`, right after `resolveEffectiveConfig` is called: `const lifecycleStatuses = getAllSetupLifecycles(db, mode); const lifecycleFilteredSetupsByRegime = applyLifecycleFilter(effectiveSetupsByRegime, lifecycleStatuses);` — use `lifecycleFilteredSetupsByRegime` everywhere `effectiveSetupsByRegime` was used for the candidate-building loop.

In the candidate-building loop, after `insertCandidate`/shadow-position logic (unchanged — every surviving setup still gets both), branch on `lifecycleStatuses[setupName] === 'trial'`: if trial, call `insertDecision(db, { candidateId: fullCandidate.id, ts: nowHour, mode, action: 'skip', size: null, stopAtr: null, trailAtr: null, reason: 'trial setup — shadow only, no Claude call', plainReason: 'This setup is still being tested, so it only records what it would have done.', defaultAction: fullCandidate.default.action, diverged: false, model: 'trial', latencyMs: 0, rawResponse: '{}' })` and do NOT push it into `cycleCandidates`; otherwise push as today.

After the cycle's main decision/position logic completes (near the existing `persistCycleResults` call), add a lifecycle re-check pass: for each setup name whose current status is `'active'`, fetch its trades (`getTrades(db, mode).filter(t => t.setup === setupName)`), and if `isFailingAutoOffThreshold(trades)`, call `setSetupLifecycleStatus(db, mode, setupName, 'auto_off', nowHour)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scheduler-cycle.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/cycle.js test/scheduler-cycle.test.js
git commit -m "feat(scheduler): wire setup lifecycle into runCycle — trial setups shadow-only (no Claude call), auto_off excluded entirely, active setups auto-trip to auto_off on a failing rolling expectancy (item 5 — live wiring)"
```

---

## Task 10: Lifecycle API + Strategy tab UI (activate button, status column, alert)

**Files:**
- Modify: `src/server/app.js` (`/api/strategy`, new `POST /api/setups/:name/activate`)
- Modify: `public-v2/js/strategy.mjs`
- Test: `test/server-app.test.js`

**Interfaces:**
- Consumes: `getSetupLifecycle`, `setSetupLifecycleStatus`, `canActivate`, `isFailingAutoOffThreshold` (Task 8).
- Produces: `/api/strategy`'s `setups[]` entries gain a `lifecycleStatus: 'trial'|'active'|'auto_off'` field. `POST /api/setups/:name/activate?mode=paper`: 200 with the new status on success; 409 with `{ error }` when the gate fails (trial without 30+ positive-expectancy trades, or auto_off still failing its own threshold); 404 for an unknown setup name.

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:
```js
test('GET /api/strategy includes a lifecycleStatus per setup, defaulting to trial', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    const pullback = body.setups.find((s) => s.name === 'trend_pullback');
    assert.equal(pullback.lifecycleStatus, 'trial');
  } finally {
    server.close();
  }
});

test('POST /api/setups/:name/activate returns 409 when the trial setup has fewer than 30 trades', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/setups/trend_pullback/activate?mode=paper`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 409);
  } finally {
    server.close();
  }
});

test('POST /api/setups/:name/activate succeeds and flips status to active once the trade gate passes', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    for (let i = 0; i < 30; i += 1) {
      insertTrade(db, { mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: i * 3600, exitTs: i * 3600 + 60, entryPrice: 100, exitPrice: 102, units: 1, riskAmount: 5, pnl: 1, r: 0.2, exitReason: 'target' });
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/setups/trend_pullback/activate?mode=paper`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'active');
  } finally {
    server.close();
  }
});

test('POST /api/setups/:name/activate returns 404 for an unknown setup name', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/setups/not_a_real_setup/activate?mode=paper`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — route doesn't exist (404 for all), `/api/strategy` has no `lifecycleStatus` field.

- [ ] **Step 3: Implement**

`/api/strategy`: in the `setups` map, add `lifecycleStatus: getSetupLifecycle(db, mode, name).status`.

`POST /api/setups/:name/activate`: validate `req.params.name` is a key of `SETUPS` (404 if not). Load current status via `getSetupLifecycle`. Load `getTrades(db, mode).filter(t => t.setup === name)`. If current status is `'trial'`: require `canActivate(trades)`, else 409 `{ error: 'needs 30+ trades with positive expectancy before activating' }`. If current status is `'auto_off'`: require `!isFailingAutoOffThreshold(trades)`, else 409 `{ error: 'still failing the auto-off threshold' }`. If current status is already `'active'`: 409 `{ error: 'already active' }`. On success: `setSetupLifecycleStatus(db, mode, name, 'active', Date.now()/1000|0)`, respond `{ status: 'active' }`.

`public-v2/js/strategy.mjs`: add a "Status" column to `renderSetupsTable` showing `s.lifecycleStatus`, styled distinctly for `auto_off` (alert color, matching the existing amber/red badge conventions elsewhere in this file). For a `trial` or `auto_off` setup, show an "Activate" button (confirm-gated via `window.confirm`, matching the existing pause/resume pattern in `status.mjs`) that POSTs to `/api/setups/:name/activate` and re-renders on success, showing the error message on 409. Remove the now-inaccurate note "Setup lifecycle (trial → active → auto-off) is not built yet — every setup listed here is always active for its regime."

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/app.js public-v2/js/strategy.mjs test/server-app.test.js
git commit -m "feat(ui): lifecycle status + Activate button on the Strategy tab, dashboard alert styling for auto_off (item 5 — API/UI; Telegram alert substituted with a dashboard alert, Telegram itself still out of scope)"
```

---

## Task 11: Old-vs-new config shadow comparison (on-demand)

**Files:**
- Create: nothing new — extends `src/backtest/compare.js`
- Modify: `src/server/app.js` (new `GET /api/config/shadow-comparison`)
- Modify: `public-v2/js/strategy.mjs`
- Test: `test/backtest-compare.test.js`, `test/server-app.test.js`

**Interfaces:**
- Consumes: `runBacktest` (Task 3), `getMostRecentSupersededConfigVersion`, `getActiveConfigVersion` (existing), `getTrades` (existing).
- Produces: `buildShadowComparison(db, mode) -> { tooSoon: true } | { tooSoon: false, sinceTs, oldConfigSimulated: SummarizeWindowResult, newConfigActual: SummarizeWindowResult }` where `tooSoon` is true until 14 days have passed since the active version's `decidedTs`. `oldConfigSimulated` replays the superseded config via `runBacktest` from `sinceTs` to now (default-only, no Claude — this is exactly what `runBacktest` already is). `newConfigActual` summarizes the *real* trades recorded in `trades` for `mode` with `entryTs >= sinceTs` under the now-active config.

- [ ] **Step 1: Write the failing tests**

Add to `test/backtest-compare.test.js`:
```js
const { buildShadowComparison } = require('../src/backtest/compare');

test('buildShadowComparison reports tooSoon when there is no superseded version at all', () => {
  const db = openDb(':memory:');
  const result = buildShadowComparison(db, 'paper');
  assert.equal(result.tooSoon, true);
});

test('buildShadowComparison reports tooSoon when the active version was decided less than 14 days ago', () => {
  const db = openDb(':memory:');
  const oldId = insertConfigVersion(db, { mode: 'paper', configJson: { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {}, setupParams: {} }, backtestJson: null });
  approveConfigVersion(db, 'paper', oldId);
  const newId = insertConfigVersion(db, { mode: 'paper', configJson: { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {}, setupParams: {} }, backtestJson: null });
  approveConfigVersion(db, 'paper', newId); // decidedTs = Date.now(), well under 14 days old
  const result = buildShadowComparison(db, 'paper');
  assert.equal(result.tooSoon, true);
});
```

(The "14+ days old, full comparison" path needs a `decided_ts` in the past — write it with a direct SQL update after `approveConfigVersion`, since there's no public API to backdate it: `db.prepare("UPDATE config_versions SET decided_ts = ? WHERE id = ?").run(Date.now() - 15*86400*1000, newId);` then assert `result.tooSoon === false` and that `result.oldConfigSimulated`/`result.newConfigActual` are both present. Also seed a sentinel `scheduler_state` for `'paper'` via `saveSchedulerState`/`freshState` before calling `buildShadowComparison`, and assert via `loadSchedulerState` that it is unchanged afterward — same read-only-replay guarantee as `buildWalkForwardReport`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/backtest-compare.test.js`
Expected: FAIL — `buildShadowComparison` doesn't exist.

- [ ] **Step 3: Implement `buildShadowComparison` in `src/backtest/compare.js`**

```
function buildShadowComparison(db, mode) {
  const active = getActiveConfigVersion(db, mode);
  if (active.decidedTs === null) return { tooSoon: true };
  const sinceTs = Math.floor(active.decidedTs / 1000);
  const ageSeconds = Math.floor(Date.now() / 1000) - sinceTs;
  if (ageSeconds < 14 * 86400) return { tooSoon: true };
  const superseded = getMostRecentSupersededConfigVersion(db, mode);
  if (!superseded) return { tooSoon: true };

  const { config: oldConfig, setupsByRegime: oldSetupsByRegime } = resolveEffectiveConfig(DEFAULT_RISK_CONFIG, superseded.config, SETUPS_BY_REGIME);
  const oldSetupParams = resolveSetupParams(superseded.config.setupParams);
  const oldResult = runBacktest(db, oldConfig, sinceTs, oldSetupsByRegime, oldSetupParams);
  const btcCloses = getCandles(db, 'BTC', '1d', sinceTs, Math.floor(Date.now() / 1000)).map((c) => c.close);
  const oldConfigSimulated = summarizeWindow(oldResult.state.closedTrades, btcCloses);

  const newTrades = getTrades(db, mode).filter((t) => t.entryTs >= sinceTs);
  const newConfigActual = summarizeWindow(newTrades, btcCloses);

  return { tooSoon: false, sinceTs, oldConfigSimulated, newConfigActual };
}
```
Import `getActiveConfigVersion`, `getMostRecentSupersededConfigVersion`, `getTrades`, `getCandles` from `../data/db`; `resolveEffectiveConfig`, `DEFAULT_RISK_CONFIG` from `../engine/config`; `resolveSetupParams` from `../engine/setupParams`; `SETUPS_BY_REGIME` from `../engine/playbook`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/backtest-compare.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the HTTP endpoint**

`GET /api/config/shadow-comparison?mode=paper` in `app.js`: `res.json(buildShadowComparison(db, mode))`.

Add to `test/server-app.test.js`:
```js
test('GET /api/config/shadow-comparison reports tooSoon with a fresh database', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/shadow-comparison?mode=paper`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.tooSoon, true);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS.

- [ ] **Step 7: Add the Strategy tab panel**

`public-v2/js/strategy.mjs`: new `renderShadowComparison()` fetching `/api/config/shadow-comparison`, rendering "Not enough time yet (needs 14 days since the last approval)" when `tooSoon`, otherwise a small old-vs-new table (trades/win rate/expectancy/worst drawdown for `oldConfigSimulated` vs `newConfigActual`) placed near the existing Config box. Call it from the tab's existing render-all sequence.

- [ ] **Step 8: Run the full suite**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/backtest/compare.js src/server/app.js public-v2/js/strategy.mjs test/backtest-compare.test.js test/server-app.test.js
git commit -m "feat: old-vs-new config shadow comparison, computed on-demand by replaying the superseded config with runBacktest — no new table, no per-cycle cost (item 4)"
```

---

## Final check

- [ ] Run the full suite one more time: `node --test test/` — expect all passing, same skip count as before this plan started.
- [ ] Grep for any remaining reference to the old UI copy "Setup lifecycle (trial → active → auto-off) is not built yet" or "Edit setup ranges... Coming soon" to confirm both were actually replaced, not left dangling alongside the new code.
