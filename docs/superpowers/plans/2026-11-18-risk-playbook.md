# Risk Guardrails + Playbook Setups (Milestone 4, Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/engine/risk.js` (sizing, guardrails, fee check, daily-loss/kill-switch predicates) and the four `src/engine/playbook/*.js` setups (candidate generation), all pure. This is Part A of milestone 4 — the backtest/broker that actually runs these through history is Part B, a separate plan, because playbook+risk and broker+backtest are independently testable subsystems.

**Architecture:** Each playbook setup exports `evaluate(coin, candles4h, indicators, i, regimeLabel)` → a candidate object or `null`, checked at one index at a time against precomputed indicator arrays (same O(n)-once pattern as milestone 3's `computeRegimeSeries` — indicators are computed once over a whole series, setups just read values at index `i`). `risk.js` exports small, independent pure functions (sizing, fee check, guardrail gate, daily-loss/kill-switch predicates) that Part B's backtest loop composes — `risk.js` itself holds no state; the caller threads portfolio state through explicit arguments and return values.

**Tech Stack:** Node.js 20, `node --test`. No new dependencies.

**Spec:** `docs/v2-design.md` §§5.2 (playbook table), 5.4 (guardrails), 6 (fees); `CLAUDE.md`'s `src/engine/` purity rule.

## Global Constraints

- `src/engine/` is pure: no network, no clock, no DB; data comes in as arguments.
- Risk per trade: 0.5% of balance (paper) by default; stake = risk ÷ stop distance.
- Max open positions: 3. Total open risk cap: 1.5% of balance. Max exposure per coin: 20%. Max total exposure: 60%.
- Daily loss limit: 3% of balance (new entries blocked until UTC midnight). Weekly drawdown kill switch: 8% (blocks everything until manually restarted — for a one-off backtest run this means "for the remainder of the run," since there's no human to restart it mid-replay).
- Cooldown after a stop on a coin: 6h.
- Fee check: skip a coin if its ATR (as % of price, on the setup's timeframe) is below 4× the round-trip fee.
- Setup table (design §5.2), copied verbatim:

| Setup | Allowed in | Entry idea | Default stop | Default exit |
|---|---|---|---|---|
| `trend_breakout` | `trend_up` | 4h close above the 20-bar high, ADX rising | 2×ATR | Trailing stop at 3×ATR below the high; no fixed target |
| `trend_pullback` | `trend_up` | Pullback to the 4h EMA20/50 that holds, RSI(14) 40–55 | 1.5×ATR | Trailing stop at 2.5×ATR |
| `range_reversion` | `range` | Close below the lower Bollinger band, RSI(2) < 10, price above daily EMA200 | 1.5×ATR | Bollinger middle band, or 24h time stop |
| `oversold_bounce` | `downtrend` (half size max) | RSI(2) < 5 on 4h after a 3-day fall | 1×ATR | First 4h close above the EMA20, or 12h |

## Interpretation decisions (the spec is loose here; documented so Part B and any reviewer know the exact rule being tested)

- **"20-bar high"** = the prior 20 bars' Donchian upper band, **excluding the current bar** (`donchian20.upper[i-1]`), so breakout is checked against history, not itself.
- **"ADX rising"** = `adx14[i] > adx14[i-1]` (single-bar comparison — the simplest literal reading).
- **"Pullback to the 4h EMA20/50 that holds"** = the bar's low touched-or-crossed EMA20 or EMA50 (`low[i] <= ema20[i] || low[i] <= ema50[i]`) and the close is back above the lower of the two touched EMAs (`close[i] > min(ema20[i], ema50[i])`) — i.e. it dipped to the average and bounced, didn't close through it.
- **"3-day fall"** = `close[i] < close[i-18]` (18 4h-bars = 3 days).
- **"Trailing stop... until the trail activates"**: no separate activation threshold is specified, so the trailing stop is active from entry — it naturally starts at-or-below the fixed initial stop and only overtakes it once price has moved favorably enough that `highestHigh - trailAtr*ATR` exceeds the initial `entry - stopAtr*ATR`. Stops only ratchet up, consistent with "tighten only." (Part B implements the actual ratchet; this plan just fixes each setup's `stopAtr`/`trailAtr` values.)
- **Entry price** for every setup = `candles4h[i].close` (the signal fires on the close that triggered it; Part B's paper broker decides the actual fill mechanics).

## Review Focus

- `trend_breakout`'s Donchian lookback must exclude the current bar — using `donchian20.upper[i]` (which already includes the breakout bar's own high) would make a breakout check against itself, always "true" the moment price makes a new high.
- `oversold_bounce`'s `maxSize: 0.5` cap must be visible on the candidate (design says "half size max" for `downtrend`) — a caller that ignores it would size this setup identically to the others.
- Every setup must return `null` (not a candidate with a falsy field) when the regime doesn't allow it, and must return `null` before index `i` has enough warm-up data for its own indicators (e.g. `trend_breakout` needs `donchian20.upper[i-1]` to exist, not just `[i]`).
- `risk.js`'s guardrail checks are independent gates — a candidate failing on, say, max-open-positions must report *that* reason, not silently fall through to a different (wrong) rejection reason, since the live dashboard will eventually show this reason to a human.
- The weekly kill switch and daily loss limit are **state the caller must persist across calls** — `risk.js` must not pretend to "remember" anything itself (that would violate the purity rule and silently diverge between backtest and live); it must take the current state as an explicit argument every time.

---

## Task 1: Extract `alignDailyIndices` from `regime.js` (shared, reusable alignment)

**Files:**
- Modify: `src/engine/regime.js`
- Test: `test/engine-regime.test.js` (append)

**Interfaces:**
- Produces: `alignDailyIndices(dailySeries, fourHourSeries)` → `number[]` (same length as `fourHourSeries`; each entry is the index into `dailySeries` of the most recently **closed** daily candle at that bar's `ts`, using the close-time rule — `null` if none has closed yet). Exported from `src/engine/regime.js`.
- Consumes: nothing new — this extracts logic already inside `computeRegimeSeries` (the look-ahead fix from milestone 3's final review) into a standalone, directly-testable, reusable function. `computeRegimeSeries` is refactored to call it instead of its own inline pointer loop; **all existing regime tests must still pass unchanged** — this is a pure refactor, not a behavior change.
- Consumed by: Task 7 (`range_reversion`, which needs the *per-coin* daily EMA200 aligned to each coin's own 4h bars, not just BTC's).

- [ ] **Step 1: Write the failing test**

Append to `test/engine-regime.test.js`:

```js
const { alignDailyIndices } = require('../src/engine/regime');

test('alignDailyIndices picks the most recently CLOSED daily candle, never one still open', () => {
  const DAY = 24 * 3600;
  const dailySeries = [{ ts: 0 * DAY }, { ts: 1 * DAY }, { ts: 2 * DAY }];
  const fourHourSeries = [
    { ts: 2 * DAY + 4 * 3600 }, // 4h into day 2 — day 2 hasn't closed yet (closes at 3*DAY)
  ];

  const result = alignDailyIndices(dailySeries, fourHourSeries);

  assert.equal(result[0], 1); // day 1 is the most recently closed (closes at 2*DAY <= bar.ts)
});

test('alignDailyIndices returns null before any daily candle has closed', () => {
  const DAY = 24 * 3600;
  const dailySeries = [{ ts: 5 * DAY }];
  const fourHourSeries = [{ ts: 1 * DAY }];

  const result = alignDailyIndices(dailySeries, fourHourSeries);

  assert.equal(result[0], null);
});

test('alignDailyIndices advances forward monotonically across a whole series', () => {
  const DAY = 24 * 3600, FOUR_H = 4 * 3600;
  const dailySeries = Array.from({ length: 10 }, (_, i) => ({ ts: i * DAY }));
  const fourHourSeries = Array.from({ length: 60 }, (_, i) => ({ ts: i * FOUR_H }));

  const result = alignDailyIndices(dailySeries, fourHourSeries);

  // By bar index 30 (= day 5, at 00:00), days 0-4 have closed (day 4 closes at 5*DAY = bar 30's ts).
  assert.equal(result[30], 4);
  // One bar later, still day 4 is the latest closed (day 5 closes at 6*DAY, bar index 36).
  assert.equal(result[31], 4);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/engine-regime.test.js`
Expected: FAIL — `alignDailyIndices is not a function` (or not exported)

- [ ] **Step 3: Implement the extraction + refactor**

In `src/engine/regime.js`, add the new function and use it inside `computeRegimeSeries`:

```js
function alignDailyIndices(dailySeries, fourHourSeries) {
  const result = new Array(fourHourSeries.length).fill(null);
  if (dailySeries.length === 0) return result;
  let dailyPointer = 0;
  for (let i = 0; i < fourHourSeries.length; i += 1) {
    const bar = fourHourSeries[i];
    while (dailyPointer + 1 < dailySeries.length && dailySeries[dailyPointer + 1].ts + DAY_SECONDS <= bar.ts) {
      dailyPointer += 1;
    }
    result[i] = dailySeries[dailyPointer].ts + DAY_SECONDS <= bar.ts ? dailyPointer : null;
  }
  return result;
}
```

Then replace `computeRegimeSeries`'s inline daily-pointer loop body. Change:

```js
  let dailyPointer = 0; // advances forward only — btc4h and btcDaily are both ts-ascending
  const results = [];

  for (let i = 0; i < btc4h.length; i += 1) {
    const bar = btc4h[i];

    // Use the daily candle's CLOSE time (ts + a full day), never its open time —
    // a bar partway through "today" must not see today's not-yet-closed EMA200.
    while (dailyPointer + 1 < btcDaily.length && btcDaily[dailyPointer + 1].ts + DAY_SECONDS <= bar.ts) {
      dailyPointer += 1;
    }
    if (btcDaily[dailyPointer].ts + DAY_SECONDS > bar.ts) continue; // no completed daily candle yet at all
    const ema200Now = dailyEma200[dailyPointer];
```

to:

```js
  const dailyIdx = alignDailyIndices(btcDaily, btc4h);
  const results = [];

  for (let i = 0; i < btc4h.length; i += 1) {
    const bar = btc4h[i];
    const dailyPointer = dailyIdx[i];
    if (dailyPointer === null) continue; // no completed daily candle yet at all
    const ema200Now = dailyEma200[dailyPointer];
```

And update the final export line:

```js
module.exports = { labelRegime, computeRegimeSeries, alignDailyIndices };
```

- [ ] **Step 4: Run to verify the new tests pass AND no regression**

Run: `node --test test/engine-regime.test.js`
Expected: PASS (all tests — the 3 new ones plus every existing `computeRegimeSeries`/`labelRegime` test unchanged, including the look-ahead regression test from milestone 3)

- [ ] **Step 5: Commit**

```bash
git add src/engine/regime.js test/engine-regime.test.js
git commit -m "refactor(engine): extract alignDailyIndices for reuse by playbook setups"
```

---

## Task 2: `risk.js` — position sizing + fee viability

**Files:**
- Create: `src/engine/risk.js`
- Test: `test/engine-risk.test.js`

**Interfaces:**
- Produces: `sizePosition({ balance, riskPct, entryPrice, stopPrice })` → `{ units, stakeValue, riskAmount }` (`units` = position size in base currency, `stakeValue = units * entryPrice`, `riskAmount = balance * riskPct`). `checkFeeViability({ atrPct, roundTripFeePct, minMultiple = 4 })` → `boolean` (true if viable, i.e. `atrPct >= minMultiple * roundTripFeePct`).
- Consumed by: Part B's backtest loop (sizing every candidate before placing it; skipping a coin whose ATR% fails the fee check, per design §5.4).

- [ ] **Step 1: Write the failing tests**

Create `test/engine-risk.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sizePosition, checkFeeViability } = require('../src/engine/risk');

test('sizePosition risks exactly riskPct of balance, sized by stop distance', () => {
  // balance=10000, risk 0.5% = 50. entry=100, stop=98 (2% stop distance = 2 per unit).
  // units = riskAmount / stopDistancePerUnit = 50 / 2 = 25. stakeValue = 25*100 = 2500.
  const result = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 98 });

  assert.equal(result.riskAmount, 50);
  assert.equal(result.units, 25);
  assert.equal(result.stakeValue, 2500);
});

test('sizePosition scales down for a wider stop (more distance, fewer units for the same risk)', () => {
  const tight = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 98 });
  const wide = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 90 });

  assert.ok(wide.units < tight.units, `expected a wider stop to produce fewer units: ${wide.units} vs ${tight.units}`);
  assert.equal(wide.riskAmount, tight.riskAmount); // same £ risked either way
});

test('checkFeeViability passes when ATR% is at least 4x the round-trip fee', () => {
  assert.equal(checkFeeViability({ atrPct: 2.6, roundTripFeePct: 0.65 }), true); // 2.6 = 4*0.65 exactly
  assert.equal(checkFeeViability({ atrPct: 3, roundTripFeePct: 0.65 }), true);
});

test('checkFeeViability fails when ATR% is below 4x the round-trip fee', () => {
  assert.equal(checkFeeViability({ atrPct: 2, roundTripFeePct: 0.65 }), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-risk.test.js`
Expected: FAIL — `Cannot find module '../src/engine/risk'`

- [ ] **Step 3: Implement**

Create `src/engine/risk.js`:

```js
'use strict';

function sizePosition({ balance, riskPct, entryPrice, stopPrice }) {
  const riskAmount = balance * riskPct;
  const stopDistancePerUnit = Math.abs(entryPrice - stopPrice);
  const units = riskAmount / stopDistancePerUnit;
  const stakeValue = units * entryPrice;
  return { units, stakeValue, riskAmount };
}

function checkFeeViability({ atrPct, roundTripFeePct, minMultiple = 4 }) {
  return atrPct >= minMultiple * roundTripFeePct;
}

module.exports = { sizePosition, checkFeeViability };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-risk.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/risk.js test/engine-risk.test.js
git commit -m "feat(engine): add risk-based position sizing and fee-viability check"
```

---

## Task 3: `risk.js` — portfolio guardrail gate

**Files:**
- Modify: `src/engine/risk.js`
- Test: `test/engine-risk.test.js` (append)

**Interfaces:**
- Produces: `checkGuardrails(state, candidate, config)` → `{ allowed: boolean, reason: string | null }`. `state = { openPositions: [{ coin, riskPct, exposurePct }], cooldowns: { [coin]: cooldownUntilTs } }`. `candidate = { coin, riskPct, exposurePct, ts }`. `config = { maxOpenPositions, maxTotalRiskPct, maxCoinExposurePct, maxTotalExposurePct, cooldownHours }`. Checks run in this fixed order, first failure wins: max open positions → total open risk → per-coin exposure → total exposure → cooldown.
- Consumed by: Part B's backtest loop, called once per fired candidate before sizing/placing it.

- [ ] **Step 1: Write the failing tests**

Append to `test/engine-risk.test.js`:

```js
const { checkGuardrails } = require('../src/engine/risk');

const CONFIG = {
  maxOpenPositions: 3, maxTotalRiskPct: 0.015, maxCoinExposurePct: 0.20,
  maxTotalExposurePct: 0.60, cooldownHours: 6,
};

function emptyState() {
  return { openPositions: [], cooldowns: {} };
}

test('allows a candidate when every guardrail has headroom', () => {
  const result = checkGuardrails(emptyState(), { coin: 'BTC', riskPct: 0.005, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.deepEqual(result, { allowed: true, reason: null });
});

test('blocks when max open positions is already reached', () => {
  const state = { openPositions: [
    { coin: 'BTC', riskPct: 0.005, exposurePct: 0.1 },
    { coin: 'ETH', riskPct: 0.005, exposurePct: 0.1 },
    { coin: 'SOL', riskPct: 0.005, exposurePct: 0.1 },
  ], cooldowns: {} };
  const result = checkGuardrails(state, { coin: 'XRP', riskPct: 0.005, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'max_open_positions');
});

test('blocks when adding the candidate would exceed total open risk', () => {
  const state = { openPositions: [{ coin: 'BTC', riskPct: 0.012, exposurePct: 0.1 }], cooldowns: {} };
  const result = checkGuardrails(state, { coin: 'ETH', riskPct: 0.005, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'total_open_risk');
});

test('blocks when adding the candidate would exceed per-coin exposure', () => {
  const state = { openPositions: [{ coin: 'BTC', riskPct: 0.002, exposurePct: 0.15 }], cooldowns: {} };
  const result = checkGuardrails(state, { coin: 'BTC', riskPct: 0.002, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'coin_exposure');
});

test('blocks when adding the candidate would exceed total exposure', () => {
  const state = { openPositions: [
    { coin: 'BTC', riskPct: 0.002, exposurePct: 0.3 },
    { coin: 'ETH', riskPct: 0.002, exposurePct: 0.25 },
  ], cooldowns: {} };
  const result = checkGuardrails(state, { coin: 'SOL', riskPct: 0.002, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'total_exposure');
});

test('blocks a coin still inside its post-stop cooldown window', () => {
  const state = { openPositions: [], cooldowns: { BTC: 5000 } };
  const result = checkGuardrails(state, { coin: 'BTC', riskPct: 0.005, exposurePct: 0.1, ts: 4000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'cooldown');
});

test('allows the same coin again once its cooldown has elapsed', () => {
  const state = { openPositions: [], cooldowns: { BTC: 5000 } };
  const result = checkGuardrails(state, { coin: 'BTC', riskPct: 0.005, exposurePct: 0.1, ts: 5001 }, CONFIG);
  assert.equal(result.allowed, true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-risk.test.js`
Expected: FAIL — `checkGuardrails is not a function`

- [ ] **Step 3: Implement**

In `src/engine/risk.js`, add before `module.exports`:

```js
function checkGuardrails(state, candidate, config) {
  if (state.openPositions.length >= config.maxOpenPositions) {
    return { allowed: false, reason: 'max_open_positions' };
  }

  const totalRisk = state.openPositions.reduce((sum, p) => sum + p.riskPct, 0) + candidate.riskPct;
  if (totalRisk > config.maxTotalRiskPct) {
    return { allowed: false, reason: 'total_open_risk' };
  }

  const coinExposure = state.openPositions
    .filter((p) => p.coin === candidate.coin)
    .reduce((sum, p) => sum + p.exposurePct, 0) + candidate.exposurePct;
  if (coinExposure > config.maxCoinExposurePct) {
    return { allowed: false, reason: 'coin_exposure' };
  }

  const totalExposure = state.openPositions.reduce((sum, p) => sum + p.exposurePct, 0) + candidate.exposurePct;
  if (totalExposure > config.maxTotalExposurePct) {
    return { allowed: false, reason: 'total_exposure' };
  }

  const cooldownUntil = state.cooldowns[candidate.coin];
  if (cooldownUntil !== undefined && candidate.ts < cooldownUntil) {
    return { allowed: false, reason: 'cooldown' };
  }

  return { allowed: true, reason: null };
}

module.exports = { sizePosition, checkFeeViability, checkGuardrails };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-risk.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/risk.js test/engine-risk.test.js
git commit -m "feat(engine): add portfolio guardrail gate (positions, risk, exposure, cooldown)"
```

---

## Task 4: `risk.js` — daily loss limit + weekly kill switch

**Files:**
- Modify: `src/engine/risk.js`
- Test: `test/engine-risk.test.js` (append)

**Interfaces:**
- Produces: `isDailyLossLimitHit(dailyPnlPct, config)` → `boolean` (`true` if `dailyPnlPct <= -config.dailyLossLimitPct`). `isKillSwitchTriggered(weeklyDrawdownPct, config)` → `boolean` (`true` if `weeklyDrawdownPct >= config.weeklyKillSwitchPct`). Both are one-shot predicates on a single number — **the caller owns persistence** (once triggered, the caller's own state must keep remembering it; these functions don't remember anything between calls, by design, since `src/engine/` holds no state).
- Consumed by: Part B's backtest loop, which ORs each day's/week's result into its own running `dailyLossLimitHit`/`killSwitchActive` flags and resets the daily one at UTC midnight (never resets the weekly one mid-run, per design — "restarted by hand").

- [ ] **Step 1: Write the failing tests**

Append to `test/engine-risk.test.js`:

```js
const { isDailyLossLimitHit, isKillSwitchTriggered } = require('../src/engine/risk');

const LOSS_CONFIG = { dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08 };

test('isDailyLossLimitHit is false while losses are under the limit', () => {
  assert.equal(isDailyLossLimitHit(-0.02, LOSS_CONFIG), false);
});

test('isDailyLossLimitHit is true once losses reach or exceed the limit', () => {
  assert.equal(isDailyLossLimitHit(-0.03, LOSS_CONFIG), true);
  assert.equal(isDailyLossLimitHit(-0.05, LOSS_CONFIG), true);
});

test('isDailyLossLimitHit is false on a profitable day', () => {
  assert.equal(isDailyLossLimitHit(0.02, LOSS_CONFIG), false);
});

test('isKillSwitchTriggered is false while weekly drawdown is under 8%', () => {
  assert.equal(isKillSwitchTriggered(0.05, LOSS_CONFIG), false);
});

test('isKillSwitchTriggered is true once weekly drawdown reaches or exceeds 8%', () => {
  assert.equal(isKillSwitchTriggered(0.08, LOSS_CONFIG), true);
  assert.equal(isKillSwitchTriggered(0.12, LOSS_CONFIG), true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-risk.test.js`
Expected: FAIL — `isDailyLossLimitHit is not a function`

- [ ] **Step 3: Implement**

In `src/engine/risk.js`, add before `module.exports`:

```js
function isDailyLossLimitHit(dailyPnlPct, config) {
  return dailyPnlPct <= -config.dailyLossLimitPct;
}

function isKillSwitchTriggered(weeklyDrawdownPct, config) {
  return weeklyDrawdownPct >= config.weeklyKillSwitchPct;
}

module.exports = {
  sizePosition, checkFeeViability, checkGuardrails,
  isDailyLossLimitHit, isKillSwitchTriggered,
};
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-risk.test.js`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/risk.js test/engine-risk.test.js
git commit -m "feat(engine): add daily-loss-limit and weekly-kill-switch predicates"
```

---

## Task 5: `playbook/trendBreakout.js`

**Files:**
- Create: `src/engine/playbook/trendBreakout.js`
- Test: `test/engine-playbook-trend-breakout.test.js`

**Interfaces:**
- Produces: `evaluate(coin, candles4h, indicators, i, regimeLabel)` → candidate `{ coin, setup: 'trend_breakout', regime: regimeLabel, entry, atr, default: { action: 'take', size: 1.0, stopAtr: 2.0, trailAtr: 2.5 }, exitType: 'trailing_stop' }` or `null`. `candles4h = [{ ts, open, high, low, close }]`. `indicators = { donchian20: { upper: number[], lower: number[] }, adx14: { adx: number[] } }` (only the fields this setup needs — Part B will pass a richer shared object; this setup only reads these two).
- Consumed by: Part B's backtest loop (calls every setup's `evaluate` for every coin at every 4h index where `regimeLabel === 'trend_up'`).

- [ ] **Step 1: Write the failing tests**

Create `test/engine-playbook-trend-breakout.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine/playbook/trendBreakout');

function makeIndicators({ donchianUpper, adx, atr14 }) {
  return {
    donchian20: { upper: donchianUpper, lower: [] }, adx14: { adx },
    atr14: atr14 || donchianUpper.map(() => 2),
  };
}

test('fires when close breaks above the PRIOR bar\'s 20-bar high and ADX is rising', () => {
  // donchianUpper[i-1]=100 and donchianUpper[i]=110 are deliberately different —
  // close=105 is above the prior value but below the current one, so this fixture
  // only fires under the correct "exclude current bar" rule, not the buggy one.
  const candles4h = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1, open: 100, high: 106, low: 99, close: 105 },
  ];
  const indicators = makeIndicators({ donchianUpper: [100, 110], adx: [20, 25], atr14: [2, 3] });

  const candidate = evaluate('BTC', candles4h, indicators, 1, 'trend_up');

  assert.ok(candidate);
  assert.equal(candidate.coin, 'BTC');
  assert.equal(candidate.setup, 'trend_breakout');
  assert.equal(candidate.entry, 105);
  assert.equal(candidate.atr, 3);
  assert.equal(candidate.default.stopAtr, 2.0);
  assert.equal(candidate.default.trailAtr, 2.5);
  assert.equal(candidate.exitType, 'trailing_stop');
});

test('does not fire when close is below the prior 20-bar high', () => {
  const candles4h = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1, open: 100, high: 103, low: 99, close: 101 }, // below prior high of 102
  ];
  const indicators = makeIndicators({ donchianUpper: [102, 103], adx: [20, 25] });

  assert.equal(evaluate('BTC', candles4h, indicators, 1, 'trend_up'), null);
});

test('does not fire when ADX is falling even if price breaks out', () => {
  const candles4h = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1, open: 100, high: 106, low: 99, close: 105 },
  ];
  const indicators = makeIndicators({ donchianUpper: [102, 104], adx: [25, 20] }); // ADX falling

  assert.equal(evaluate('BTC', candles4h, indicators, 1, 'trend_up'), null);
});

test('does not fire outside trend_up regime', () => {
  const candles4h = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1, open: 100, high: 106, low: 99, close: 105 },
  ];
  const indicators = makeIndicators({ donchianUpper: [102, 104], adx: [20, 25] });

  assert.equal(evaluate('BTC', candles4h, indicators, 1, 'range'), null);
});

test('does not fire when there is no prior bar\'s Donchian value yet (warm-up)', () => {
  const candles4h = [{ ts: 0, open: 100, high: 106, low: 99, close: 105 }];
  const indicators = makeIndicators({ donchianUpper: [null], adx: [25] });

  assert.equal(evaluate('BTC', candles4h, indicators, 0, 'trend_up'), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-playbook-trend-breakout.test.js`
Expected: FAIL — `Cannot find module '../src/engine/playbook/trendBreakout'`

- [ ] **Step 3: Implement**

Create `src/engine/playbook/trendBreakout.js`:

```js
'use strict';

function evaluate(coin, candles4h, indicators, i, regimeLabel) {
  if (regimeLabel !== 'trend_up') return null;
  if (i === 0) return null; // needs a prior bar's Donchian value

  const priorUpper = indicators.donchian20.upper[i - 1];
  const adxNow = indicators.adx14.adx[i];
  const adxPrev = indicators.adx14.adx[i - 1];
  if (priorUpper === null || adxNow === null || adxPrev === null) return null;

  const bar = candles4h[i];
  const brokeOut = bar.close > priorUpper;
  const adxRising = adxNow > adxPrev;
  if (!brokeOut || !adxRising) return null;

  return {
    coin,
    setup: 'trend_breakout',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 1.0, stopAtr: 2.0, trailAtr: 2.5 },
    exitType: 'trailing_stop',
  };
}

module.exports = { evaluate };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-playbook-trend-breakout.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/trendBreakout.js test/engine-playbook-trend-breakout.test.js
git commit -m "feat(playbook): add trend_breakout setup"
```

---

## Task 6: `playbook/trendPullback.js`

**Files:**
- Create: `src/engine/playbook/trendPullback.js`
- Test: `test/engine-playbook-trend-pullback.test.js`

**Interfaces:**
- Produces: `evaluate(coin, candles4h, indicators, i, regimeLabel)` → candidate `{ coin, setup: 'trend_pullback', regime, entry, atr, default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 }, exitType: 'trailing_stop' }` or `null`. `indicators = { ema20: number[], ema50: number[], rsi14: number[], atr14: number[] }`.
- Consumed by: Part B's backtest loop.

- [ ] **Step 1: Write the failing tests**

Create `test/engine-playbook-trend-pullback.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine/playbook/trendPullback');

function makeIndicators({ ema20, ema50, rsi14, atr14 }) {
  return { ema20, ema50, rsi14, atr14: atr14 || ema20.map(() => 2) };
}

test('fires when the bar dips to EMA20/50 and closes back above it, with RSI(14) in 40-55', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }]; // low 94 <= ema20 95, close 97 > 95
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48], atr14: [3] });

  const candidate = evaluate('ETH', candles4h, indicators, 0, 'trend_up');

  assert.ok(candidate);
  assert.equal(candidate.setup, 'trend_pullback');
  assert.equal(candidate.entry, 97);
  assert.equal(candidate.atr, 3);
  assert.equal(candidate.default.stopAtr, 1.5);
  assert.equal(candidate.default.trailAtr, 2.5);
});

test('does not fire when RSI(14) is outside the 40-55 band', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }];
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [70] });

  assert.equal(evaluate('ETH', candles4h, indicators, 0, 'trend_up'), null);
});

test('does not fire when the bar never touched EMA20 or EMA50', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 98, close: 99 }]; // low 98 > both EMAs
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48] });

  assert.equal(evaluate('ETH', candles4h, indicators, 0, 'trend_up'), null);
});

test('does not fire when the close stays below the touched EMA (no bounce, just a breakdown)', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 94 }]; // touched ema20 but closed AT/below it
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48] });

  assert.equal(evaluate('ETH', candles4h, indicators, 0, 'trend_up'), null);
});

test('does not fire outside trend_up regime', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }];
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48] });

  assert.equal(evaluate('ETH', candles4h, indicators, 0, 'range'), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-playbook-trend-pullback.test.js`
Expected: FAIL — `Cannot find module '../src/engine/playbook/trendPullback'`

- [ ] **Step 3: Implement**

Create `src/engine/playbook/trendPullback.js`:

```js
'use strict';

function evaluate(coin, candles4h, indicators, i, regimeLabel) {
  if (regimeLabel !== 'trend_up') return null;

  const ema20 = indicators.ema20[i];
  const ema50 = indicators.ema50[i];
  const rsi = indicators.rsi14[i];
  if (ema20 === null || ema50 === null || rsi === null) return null;

  const bar = candles4h[i];
  const touchedEma = bar.low <= ema20 || bar.low <= ema50;
  const heldAboveLower = bar.close > Math.min(ema20, ema50);
  const rsiInBand = rsi >= 40 && rsi <= 55;
  if (!touchedEma || !heldAboveLower || !rsiInBand) return null;

  return {
    coin,
    setup: 'trend_pullback',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    exitType: 'trailing_stop',
  };
}

module.exports = { evaluate };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-playbook-trend-pullback.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/trendPullback.js test/engine-playbook-trend-pullback.test.js
git commit -m "feat(playbook): add trend_pullback setup"
```

---

## Task 7: `playbook/rangeReversion.js`

**Files:**
- Create: `src/engine/playbook/rangeReversion.js`
- Test: `test/engine-playbook-range-reversion.test.js`

**Interfaces:**
- Produces: `evaluate(coin, candles4h, indicators, i, regimeLabel)` → candidate `{ coin, setup: 'range_reversion', regime, entry, atr, default: { action: 'take', size: 1.0, stopAtr: 1.5 }, exitType: 'target_or_time', targetType: 'bollinger_middle', timeStopHours: 24 }` or `null`. `indicators = { bollinger20: { lower: number[], middle: number[] }, rsi2: number[], dailyEma200Aligned: number[], atr14: number[] }` — `dailyEma200Aligned[i]` is this **coin's own** daily EMA200 value aligned to 4h bar `i` via `alignDailyIndices` (Task 1), already look-ahead-safe; Part B builds this per coin before calling any setup.
- Consumed by: Part B's backtest loop.

- [ ] **Step 1: Write the failing tests**

Create `test/engine-playbook-range-reversion.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine/playbook/rangeReversion');

function makeIndicators({ bollingerLower, bollingerMiddle, rsi2, dailyEma200Aligned, atr14 }) {
  return {
    bollinger20: { lower: bollingerLower, middle: bollingerMiddle }, rsi2, dailyEma200Aligned,
    atr14: atr14 || bollingerLower.map(() => 2),
  };
}

test('fires when close is below the lower Bollinger band, RSI(2)<10, and price is above daily EMA200', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [80], atr14: [4] });

  const candidate = evaluate('SOL', candles4h, indicators, 0, 'range');

  assert.ok(candidate);
  assert.equal(candidate.setup, 'range_reversion');
  assert.equal(candidate.entry, 95);
  assert.equal(candidate.atr, 4);
  assert.equal(candidate.default.stopAtr, 1.5);
  assert.equal(candidate.exitType, 'target_or_time');
  assert.equal(candidate.targetType, 'bollinger_middle');
  assert.equal(candidate.timeStopHours, 24);
});

test('does not fire when close is above the lower Bollinger band', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 98 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [80] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'range'), null);
});

test('does not fire when RSI(2) is 10 or above', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [10], dailyEma200Aligned: [80] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'range'), null);
});

test('does not fire when price is below its own daily EMA200 (not a real reversion-in-uptrend setup)', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [120] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'range'), null);
});

test('does not fire outside range regime', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [80] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'trend_up'), null);
});

test('does not fire when the daily EMA200 is not yet available (warm-up)', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [null] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'range'), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-playbook-range-reversion.test.js`
Expected: FAIL — `Cannot find module '../src/engine/playbook/rangeReversion'`

- [ ] **Step 3: Implement**

Create `src/engine/playbook/rangeReversion.js`:

```js
'use strict';

function evaluate(coin, candles4h, indicators, i, regimeLabel) {
  if (regimeLabel !== 'range') return null;

  const lowerBand = indicators.bollinger20.lower[i];
  const rsi = indicators.rsi2[i];
  const dailyEma200 = indicators.dailyEma200Aligned[i];
  if (lowerBand === null || rsi === null || dailyEma200 === null) return null;

  const bar = candles4h[i];
  const belowLowerBand = bar.close < lowerBand;
  const rsiOversold = rsi < 10;
  const aboveDailyTrend = bar.close > dailyEma200;
  if (!belowLowerBand || !rsiOversold || !aboveDailyTrend) return null;

  return {
    coin,
    setup: 'range_reversion',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 1.0, stopAtr: 1.5 },
    exitType: 'target_or_time',
    targetType: 'bollinger_middle',
    timeStopHours: 24,
  };
}

module.exports = { evaluate };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-playbook-range-reversion.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/rangeReversion.js test/engine-playbook-range-reversion.test.js
git commit -m "feat(playbook): add range_reversion setup"
```

---

## Task 8: `playbook/oversoldBounce.js`

**Files:**
- Create: `src/engine/playbook/oversoldBounce.js`
- Test: `test/engine-playbook-oversold-bounce.test.js`

**Interfaces:**
- Produces: `evaluate(coin, candles4h, indicators, i, regimeLabel)` → candidate `{ coin, setup: 'oversold_bounce', regime, entry, atr, default: { action: 'take', size: 0.5, stopAtr: 1.0 }, exitType: 'ema_cross_or_time', emaPeriod: 20, timeStopHours: 12 }` or `null` — note `default.size: 0.5`, the "half size max" cap from design §5.2, baked directly into the candidate so no caller can forget it. `indicators = { rsi2: number[], ema20: number[], atr14: number[] }`.
- Consumed by: Part B's backtest loop.

- [ ] **Step 1: Write the failing tests**

Create `test/engine-playbook-oversold-bounce.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine/playbook/oversoldBounce');

function makeCandles4hWith3DayFall() {
  // 18 bars = 3 days of 4h bars, falling, then the signal bar closes even lower.
  const candles = [];
  for (let i = 0; i <= 18; i += 1) {
    const price = 100 - i; // steadily falling
    candles.push({ ts: i, open: price + 1, high: price + 1, low: price - 1, close: price });
  }
  return candles;
}

test('fires when RSI(2)<5 on a 4h close after a 3-day fall, in downtrend', () => {
  const candles4h = makeCandles4hWith3DayFall();
  const rsi2 = new Array(candles4h.length).fill(50);
  rsi2[18] = 3;
  const ema20 = new Array(candles4h.length).fill(90);
  const atr14 = new Array(candles4h.length).fill(2.5);

  const candidate = evaluate('ADA', candles4h, { rsi2, ema20, atr14 }, 18, 'downtrend');

  assert.ok(candidate);
  assert.equal(candidate.setup, 'oversold_bounce');
  assert.equal(candidate.atr, 2.5);
  assert.equal(candidate.default.size, 0.5); // half size max, per design
  assert.equal(candidate.default.stopAtr, 1.0);
  assert.equal(candidate.exitType, 'ema_cross_or_time');
  assert.equal(candidate.emaPeriod, 20);
  assert.equal(candidate.timeStopHours, 12);
});

test('does not fire when RSI(2) is 5 or above', () => {
  const candles4h = makeCandles4hWith3DayFall();
  const rsi2 = new Array(candles4h.length).fill(50);
  rsi2[18] = 5;
  const ema20 = new Array(candles4h.length).fill(90);

  assert.equal(evaluate('ADA', candles4h, { rsi2, ema20 }, 18, 'downtrend'), null);
});

test('does not fire when there has not actually been a 3-day fall', () => {
  const candles4h = makeCandles4hWith3DayFall().map((c, i) => ({ ...c, close: 100 + i })); // rising, not falling
  const rsi2 = new Array(candles4h.length).fill(3);
  const ema20 = new Array(candles4h.length).fill(90);

  assert.equal(evaluate('ADA', candles4h, { rsi2, ema20 }, 18, 'downtrend'), null);
});

test('does not fire outside downtrend regime', () => {
  const candles4h = makeCandles4hWith3DayFall();
  const rsi2 = new Array(candles4h.length).fill(50);
  rsi2[18] = 3;
  const ema20 = new Array(candles4h.length).fill(90);

  assert.equal(evaluate('ADA', candles4h, { rsi2, ema20 }, 18, 'range'), null);
});

test('does not fire before 18 bars (3 days) of history exist', () => {
  const candles4h = makeCandles4hWith3DayFall().slice(0, 10);
  const rsi2 = new Array(candles4h.length).fill(3);
  const ema20 = new Array(candles4h.length).fill(90);

  assert.equal(evaluate('ADA', candles4h, { rsi2, ema20 }, 9, 'downtrend'), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-playbook-oversold-bounce.test.js`
Expected: FAIL — `Cannot find module '../src/engine/playbook/oversoldBounce'`

- [ ] **Step 3: Implement**

Create `src/engine/playbook/oversoldBounce.js`:

```js
'use strict';

const THREE_DAY_BARS = 18; // 3 days of 4h bars

function evaluate(coin, candles4h, indicators, i, regimeLabel) {
  if (regimeLabel !== 'downtrend') return null;
  if (i < THREE_DAY_BARS) return null;

  const rsi = indicators.rsi2[i];
  if (rsi === null) return null;

  const bar = candles4h[i];
  const threeDayFall = bar.close < candles4h[i - THREE_DAY_BARS].close;
  const rsiOversold = rsi < 5;
  if (!threeDayFall || !rsiOversold) return null;

  return {
    coin,
    setup: 'oversold_bounce',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 0.5, stopAtr: 1.0 },
    exitType: 'ema_cross_or_time',
    emaPeriod: 20,
    timeStopHours: 12,
  };
}

module.exports = { evaluate };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-playbook-oversold-bounce.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/oversoldBounce.js test/engine-playbook-oversold-bounce.test.js
git commit -m "feat(playbook): add oversold_bounce setup (half-size cap baked in)"
```

---

## Part A exit check

- [ ] `node --test test/` passes (all new risk/playbook/regime tests green, no regressions elsewhere).
- [ ] Every setup's `evaluate` returns `null` cleanly on regime mismatch and on warm-up-insufficient indices (checked by each task's own tests).
- [ ] `risk.js` exports are all pure, stateless, independently testable (no setup/sizing/guardrail function reads the clock or touches a file).

**Next:** Part B (separate plan) builds `src/broker/paper.js` (fills, fees, slippage, exit management per `exitType`) and `src/backtest/run.js` (the actual historical replay, sizing via this plan's `risk.js`, firing via this plan's playbook setups), producing the milestone 4 pass/fail report (R-based expectancy per setup vs buy-and-hold BTC).
