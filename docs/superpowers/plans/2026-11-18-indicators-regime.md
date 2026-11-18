# Indicators + Regime (Milestone 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/engine/indicators.js` (EMA, RSI, ATR, ADX, Choppiness, Bollinger, Donchian — pure, rolling, whole-series functions) and `src/engine/regime.js` (pure regime labeling), then run a verification script over the 6+ months of real candle data from milestone 2 so the regime timeline can be eyeballed for sense, per the design doc's milestone-3 done-when.

**Architecture:** Every indicator function takes a full historical array and returns a same-length array of rolling values (nulls before there's enough history) — this is what lets the whole regime history be computed in one O(n) pass instead of recomputing indicators from scratch at every point in time, and it's what milestone 4's backtester will reuse directly (replay candle-by-candle, read the indicator array at that index). `regime.js` splits into two pure functions: `labelRegime(metrics)` (the actual rule table, one point in time, trivially unit-testable) and `computeRegimeSeries(...)` (the O(n) composition: builds indicator arrays once, aligns daily EMA200 onto the 4h grid, computes breadth from per-coin series looked up **by timestamp** — not by array position, because thinner pairs have real gaps). Nothing in `src/engine/` touches the DB, the network, or the clock; `scripts/compute-regime-history.js` is the only new file that does (it reads from `src/data/db.js` and prints a report).

**Tech Stack:** Node.js 20, `node --test`. No new dependencies.

**Spec:** `docs/v2-design.md` §§3, 5.1 (regime rules and metrics table), §10 (milestone 3 row); `CLAUDE.md`'s `src/engine/` purity rule.

## Global Constraints

- `src/engine/` is pure: no network, no clock, no DB inside engine code; data comes in as arguments. Backtest and live must run identical engine code.
- Results and reasoning should be explainable in plain terms later (design doc §5.1's regime table) — metrics are returned alongside the label, not just the label alone.
- Tests run via `node --test test/` (existing convention: flat files in `test/`, `'use strict'`, `node:test` + `node:assert/strict`).

## Verified formulas (standard technical-analysis definitions, used as written)

- **EMA(period):** seed = SMA of the first `period` values; each subsequent value = `(current - previous_ema) * (2 / (period + 1)) + previous_ema`.
- **RSI(period), Wilder's smoothing:** average gain/loss seeded as a simple average of the first `period` deltas, then Wilder-smoothed (`avg = (prevAvg * (period - 1) + current) / period`); `RSI = 100 - 100 / (1 + avgGain / avgLoss)`. Edge cases: `avgLoss === 0 && avgGain === 0` → RSI 50 (no movement at all); `avgLoss === 0 && avgGain > 0` → RSI 100.
- **ATR(period), Wilder's smoothing:** `TR = max(high - low, |high - prevClose|, |low - prevClose|)` (first bar's TR is just `high - low`, no previous close); same seed-then-Wilder-smooth pattern as RSI's averages.
- **ADX(period), Wilder's:** `+DM`/`-DM` per bar from consecutive highs/lows, Wilder-smoothed, divided by Wilder-smoothed TR to get `+DI`/`-DI`; `DX = 100 * |+DI - -DI| / (+DI + -DI)`; `ADX` = Wilder-smoothed `DX`.
- **Choppiness Index(period):** `100 * log10(sum(TR, period) / (highest_high(period) - lowest_low(period))) / log10(period)`. Bounded 0–100; low in strong trends, high in sideways/choppy conditions.
- **Bollinger Bands(period, mult):** `middle = SMA(period)`; `stddev` = **population** standard deviation (divide by `period`, not `period - 1` — the standard BB convention); `upper = middle + mult * stddev`, `lower = middle - mult * stddev`.
- **Donchian Channel(period):** `upper = highest high over period`, `lower = lowest low over period`.

## Scope decision: Positioning (funding rate / open interest)

The design doc's regime metrics table lists "Positioning" (avg funding rate, 24h OI change) alongside Trend/Trendiness/Volatility/Breadth. This plan carries a `positioning` field through `labelRegime`'s metrics (always `null` for now) but does **not** compute it historically: Kraken Futures' public `tickers` endpoint (built in milestone 1) only exposes the *current* funding rate/OI, not a history, and nothing has been recording it hourly yet (that starts with milestone 5's scheduler, per design §4). This is safe to defer because **none of the four regime labeling rules in §5.1 actually reference positioning** — it's informational context for Claude's decisions later (milestone 6+), not a label input. `computeRegimeSeries` leaves a clear seam (`positioning: null`) for milestone 5+ to fill in once `market_context` history exists.

## Review Focus

- Thinner pairs (LINK, ADA) have real gaps in their 4h candles (confirmed in milestone 2's gap report) — breadth calculation must look up each coin's "above EMA50" status **by timestamp**, not by array index, or a gap silently misaligns one coin's series against BTC's and corrupts the whole breadth number.
- `labelRegime`'s rules are "first match wins" — a candidate that satisfies both `risk_off` and `trend_up` conditions must resolve to `risk_off` (checked first), not whichever branch happens to be coded first by accident.
- RSI/ATR/ADX all have a zero-movement or zero-range edge case (flat price, or a bar with identical high/low/close) that must not produce `NaN` or `Infinity` silently propagating into the regime label.
- The daily EMA200-to-4h alignment must use the most recent **completed** daily candle at or before each 4h timestamp, never a daily candle that hasn't closed yet relative to that 4h point (look-ahead bias would make the regime history meaningless for later backtesting).
- Bollinger/Donchian/RSI are listed in the design doc's indicator file but aren't used by any `regime.js` rule — their tests must still exist (milestone 4's playbook setups consume them directly), but nothing in this plan should wire them into regime labeling just because they exist.

---

## Task 1: EMA + RSI

**Files:**
- Create: `src/engine/indicators.js`
- Test: `test/engine-indicators.test.js`

**Interfaces:**
- Produces: `ema(values, period)` → `number[]` (same length as `values`; indices `< period - 1` are `null`). `rsi(values, period = 14)` → `number[]` (same length; indices `<= period` are `null` — the first RSI value needs `period` deltas, i.e. `period + 1` prices).
- Consumed by: Task 5 (`computeRegimeSeries` calls `ema` on BTC daily closes); milestone 4's playbook setups will call `rsi` directly later (out of scope here).

- [ ] **Step 1: Write the failing tests**

Create `test/engine-indicators.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ema, rsi } = require('../src/engine/indicators');

test('ema seeds with an SMA then applies the standard multiplier', () => {
  // period=3 over [1,2,3,4,5,6,7]: seed = mean(1,2,3) = 2, multiplier = 2/(3+1) = 0.5
  // ema[3] = (4-2)*0.5+2 = 3; ema[4] = (5-3)*0.5+3 = 4; ema[5]=5; ema[6]=6
  const result = ema([1, 2, 3, 4, 5, 6, 7], 3);
  assert.deepEqual(result, [null, null, 2, 3, 4, 5, 6]);
});

test('ema returns all nulls when there is not enough data', () => {
  assert.deepEqual(ema([1, 2], 3), [null, null]);
});

test('rsi is exactly 100 when every change is a gain (no losses at all)', () => {
  const values = Array.from({ length: 20 }, (_, i) => 100 + i); // strictly increasing
  const result = rsi(values, 14);
  assert.equal(result[14], 100);
  assert.equal(result[19], 100);
});

test('rsi is exactly 0 when every change is a loss (no gains at all)', () => {
  const values = Array.from({ length: 20 }, (_, i) => 100 - i); // strictly decreasing
  const result = rsi(values, 14);
  assert.equal(result[14], 0);
});

test('rsi is 50 when price never moves at all (zero gain and zero loss)', () => {
  const values = Array.from({ length: 20 }, () => 100);
  const result = rsi(values, 14);
  assert.equal(result[14], 50);
});

test('rsi returns null before period+1 values are available', () => {
  const result = rsi([100, 101, 102], 14);
  assert.deepEqual(result, [null, null, null]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/engine-indicators.test.js`
Expected: FAIL — `Cannot find module '../src/engine/indicators'`

- [ ] **Step 3: Write the implementation**

Create `src/engine/indicators.js`:

```js
'use strict';

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] - prev) * multiplier + prev;
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gainSum += delta;
    else lossSum += -delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

module.exports = { ema, rsi };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/engine-indicators.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/indicators.js test/engine-indicators.test.js
git commit -m "feat(engine): add EMA and Wilder's RSI indicators"
```

---

## Task 2: ATR + ADX

**Files:**
- Modify: `src/engine/indicators.js`
- Test: `test/engine-indicators.test.js` (append)

**Interfaces:**
- Produces: `atr(candles, period = 14)` → `number[]` where `candles = [{ high, low, close }, ...]` (index `0` always has a value — true range on the first bar is just `high - low`, there's no previous close; indices `< period` beyond that are `null`... concretely: `out[0]` is the raw TR, `out[period - 1]` is the first seeded ATR, everything between is `null`). `adx(candles, period = 14)` → `{ adx: number[], plusDI: number[], minusDI: number[] }`, all three same length as `candles`, `null` before enough history.
- Consumed by: Task 5 (`computeRegimeSeries` uses `atr` for the volatility metric and `adx` for trendiness).

- [ ] **Step 1: Write the failing tests**

Append to `test/engine-indicators.test.js`:

```js
const { atr, adx } = require('../src/engine/indicators');

test('atr converges to the constant true range of a perfectly steady series', () => {
  // high-low=2 every bar, close always mid-range, so TR=2 on every bar.
  const candles = Array.from({ length: 20 }, (_, i) => ({ high: 101 + i, low: 99 + i, close: 100 + i }));
  const result = atr(candles, 14);
  assert.equal(result[13], 2);
  assert.equal(result[19], 2);
});

test('atr is never negative or NaN even with gaps between bars', () => {
  const candles = [
    { high: 100, low: 98, close: 99 },
    { high: 110, low: 108, close: 109 }, // gapped up — TR driven by |high-prevClose|
  ];
  const result = atr(candles, 1);
  assert.ok(Number.isFinite(result[1]));
  assert.ok(result[1] > 0);
});

test('adx shows +DI clearly above -DI for a consistently trending-up series', () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    high: 100 + i * 2, low: 99 + i * 2, close: 99.5 + i * 2,
  }));
  const { adx: adxSeries, plusDI, minusDI } = adx(candles, 14);
  const lastIdx = candles.length - 1;
  assert.ok(plusDI[lastIdx] > minusDI[lastIdx], `expected +DI > -DI, got ${plusDI[lastIdx]} vs ${minusDI[lastIdx]}`);
  assert.ok(adxSeries[lastIdx] > 20, `expected a trending ADX reading, got ${adxSeries[lastIdx]}`);
});

test('adx stays low and finite for a perfectly flat series (no directional movement)', () => {
  const candles = Array.from({ length: 30 }, () => ({ high: 100, low: 100, close: 100 }));
  const { adx: adxSeries } = adx(candles, 14);
  const lastIdx = candles.length - 1;
  assert.ok(Number.isFinite(adxSeries[lastIdx]));
  assert.ok(adxSeries[lastIdx] < 10, `expected a near-zero ADX for a flat series, got ${adxSeries[lastIdx]}`);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-indicators.test.js`
Expected: FAIL — `atr is not a function`

- [ ] **Step 3: Implement**

In `src/engine/indicators.js`, add:

```js
function trueRange(curr, prev) {
  if (!prev) return curr.high - curr.low;
  return Math.max(
    curr.high - curr.low,
    Math.abs(curr.high - prev.close),
    Math.abs(curr.low - prev.close),
  );
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length === 0) return out;
  const trs = candles.map((c, i) => trueRange(c, i > 0 ? candles[i - 1] : null));
  out[0] = trs[0];
  if (candles.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += trs[i];
  let prevAtr = sum / period;
  out[period - 1] = prevAtr;
  for (let i = period; i < candles.length; i += 1) {
    prevAtr = (prevAtr * (period - 1) + trs[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

function adx(candles, period = 14) {
  const n = candles.length;
  const adxOut = new Array(n).fill(null);
  const plusDIOut = new Array(n).fill(null);
  const minusDIOut = new Array(n).fill(null);
  if (n < period + 1) return { adx: adxOut, plusDI: plusDIOut, minusDI: minusDIOut };

  const trs = [0];
  const plusDMs = [0];
  const minusDMs = [0];
  for (let i = 1; i < n; i += 1) {
    trs.push(trueRange(candles[i], candles[i - 1]));
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let trSum = 0, plusDMSum = 0, minusDMSum = 0;
  for (let i = 1; i <= period; i += 1) {
    trSum += trs[i]; plusDMSum += plusDMs[i]; minusDMSum += minusDMs[i];
  }

  const dxValues = new Array(n).fill(null);
  const setDI = (i, smoothedTR, smoothedPlusDM, smoothedMinusDM) => {
    const plusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
    const minusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;
    plusDIOut[i] = plusDI;
    minusDIOut[i] = minusDI;
    const diSum = plusDI + minusDI;
    dxValues[i] = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
  };

  setDI(period, trSum, plusDMSum, minusDMSum);
  let smoothedTR = trSum, smoothedPlusDM = plusDMSum, smoothedMinusDM = minusDMSum;
  for (let i = period + 1; i < n; i += 1) {
    smoothedTR = smoothedTR - smoothedTR / period + trs[i];
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDMs[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDMs[i];
    setDI(i, smoothedTR, smoothedPlusDM, smoothedMinusDM);
  }

  if (n >= period * 2) {
    let dxSum = 0;
    for (let i = period; i < period * 2; i += 1) dxSum += dxValues[i];
    let prevAdx = dxSum / period;
    adxOut[period * 2 - 1] = prevAdx;
    for (let i = period * 2; i < n; i += 1) {
      prevAdx = (prevAdx * (period - 1) + dxValues[i]) / period;
      adxOut[i] = prevAdx;
    }
  }

  return { adx: adxOut, plusDI: plusDIOut, minusDI: minusDIOut };
}

module.exports = { ema, rsi, atr, adx };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-indicators.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/indicators.js test/engine-indicators.test.js
git commit -m "feat(engine): add Wilder's ATR and ADX indicators"
```

---

## Task 3: Choppiness + Bollinger + Donchian

**Files:**
- Modify: `src/engine/indicators.js`
- Test: `test/engine-indicators.test.js` (append)

**Interfaces:**
- Produces: `choppiness(candles, period = 14)` → `number[]` (candles `= [{high,low,close}]`, bounded 0–100, `null` before `period` bars). `bollinger(values, period = 20, mult = 2)` → `{ middle: number[], upper: number[], lower: number[] }`. `donchian(candles, period = 20)` → `{ upper: number[], lower: number[] }` (candles `= [{high,low}]`).
- Consumed by: Task 5 (`choppiness` is included in regime metrics for visibility, though not used in the label rule itself per the Review Focus note). `bollinger`/`donchian` aren't consumed by anything in this plan — milestone 4's playbook setups (`range_reversion`, `trend_breakout`) consume them later.

- [ ] **Step 1: Write the failing tests**

Append to `test/engine-indicators.test.js`:

```js
const { choppiness, bollinger, donchian } = require('../src/engine/indicators');

test('choppiness is lower for a strong trend than for a sideways chop over the same span', () => {
  const trending = Array.from({ length: 20 }, (_, i) => ({ high: 101 + i, low: 100 + i, close: 100.5 + i }));
  const choppy = Array.from({ length: 20 }, (_, i) => {
    const base = 100 + (i % 2 === 0 ? 1 : -1); // oscillates, net movement near zero
    return { high: base + 1, low: base - 1, close: base };
  });
  const trendCI = choppiness(trending, 14)[19];
  const choppyCI = choppiness(choppy, 14)[19];
  assert.ok(trendCI >= 0 && trendCI <= 100);
  assert.ok(choppyCI >= 0 && choppyCI <= 100);
  assert.ok(trendCI < choppyCI, `expected trending CI (${trendCI}) < choppy CI (${choppyCI})`);
});

test('bollinger matches the textbook population-stddev example: [2,4,4,4,5,5,7,9], period 8', () => {
  // mean=5, population variance=4, stddev=2 (classic stats textbook example)
  const result = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  assert.equal(result.middle[7], 5);
  assert.equal(result.upper[7], 9);
  assert.equal(result.lower[7], 1);
});

test('bollinger has zero band width when every value in the window is identical', () => {
  const result = bollinger([10, 10, 10, 10], 4, 2);
  assert.equal(result.middle[3], 10);
  assert.equal(result.upper[3], 10);
  assert.equal(result.lower[3], 10);
});

test('donchian tracks the rolling highest-high and lowest-low over the period', () => {
  const candles = [
    { high: 10, low: 5 }, { high: 12, low: 6 }, { high: 8, low: 4 }, { high: 15, low: 9 },
  ];
  const result = donchian(candles, 3);
  // window for index 3 is candles[1..3]: highs {12,8,15} low-s {6,4,9}
  assert.equal(result.upper[3], 15);
  assert.equal(result.lower[3], 4);
  assert.equal(result.upper[1], null); // not enough data yet (needs 3 bars)
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-indicators.test.js`
Expected: FAIL — `choppiness is not a function`

- [ ] **Step 3: Implement**

In `src/engine/indicators.js`, add:

```js
function choppiness(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  const trs = candles.map((c, i) => trueRange(c, i > 0 ? candles[i - 1] : null));
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const trSum = trs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    const highestHigh = Math.max(...window.map((c) => c.high));
    const lowestLow = Math.min(...window.map((c) => c.low));
    const range = highestHigh - lowestLow;
    out[i] = range === 0 ? 0 : (100 * Math.log10(trSum / range)) / Math.log10(period);
  }
  return out;
}

function bollinger(values, period = 20, mult = 2) {
  const middle = new Array(values.length).fill(null);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const stddev = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + mult * stddev;
    lower[i] = mean - mult * stddev;
  }
  return { middle, upper, lower };
}

function donchian(candles, period = 20) {
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    upper[i] = Math.max(...window.map((c) => c.high));
    lower[i] = Math.min(...window.map((c) => c.low));
  }
  return { upper, lower };
}

module.exports = { ema, rsi, atr, adx, choppiness, bollinger, donchian };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-indicators.test.js`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/indicators.js test/engine-indicators.test.js
git commit -m "feat(engine): add Choppiness Index, Bollinger Bands, Donchian Channel"
```

---

## Task 4: `labelRegime` — the pure rule table

**Files:**
- Create: `src/engine/regime.js`
- Test: `test/engine-regime.test.js`

**Interfaces:**
- Produces: `labelRegime(metrics)` → `{ label: 'risk_off' | 'trend_up' | 'downtrend' | 'range', metrics }` where `metrics = { btcAboveEma200, ema200SlopeFalling, adx, choppiness, breadthPct, volatilityRankPct, btc24hChangePct, positioning }` (`positioning` may be `null`). The function echoes `metrics` back unchanged on the result so a caller can log/store exactly what was evaluated.
- Consumed by: Task 5's `computeRegimeSeries`, which assembles `metrics` for each point in time and calls this.

- [ ] **Step 1: Write the failing tests**

Create `test/engine-regime.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { labelRegime } = require('../src/engine/regime');

function baseMetrics(overrides = {}) {
  return {
    btcAboveEma200: true, ema200SlopeFalling: false, adx: 25, choppiness: 40,
    breadthPct: 70, volatilityRankPct: 50, btc24hChangePct: 0, positioning: null,
    ...overrides,
  };
}

test('risk_off when volatility rank exceeds the 90th percentile', () => {
  const { label } = labelRegime(baseMetrics({ volatilityRankPct: 95 }));
  assert.equal(label, 'risk_off');
});

test('risk_off when BTC has dropped more than 6% in 24h', () => {
  const { label } = labelRegime(baseMetrics({ btc24hChangePct: -7 }));
  assert.equal(label, 'risk_off');
});

test('risk_off wins even when trend_up conditions are also true (first match wins)', () => {
  const { label } = labelRegime(baseMetrics({ volatilityRankPct: 95, btcAboveEma200: true, adx: 30, breadthPct: 80 }));
  assert.equal(label, 'risk_off');
});

test('trend_up when BTC is above EMA200, ADX > 22, and breadth >= 60%', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: true, adx: 23, breadthPct: 60 }));
  assert.equal(label, 'trend_up');
});

test('not trend_up when breadth is just under 60%', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: true, adx: 30, breadthPct: 59 }));
  assert.notEqual(label, 'trend_up');
});

test('downtrend when BTC is below EMA200 and the EMA200 slope is falling', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: false, ema200SlopeFalling: true, breadthPct: 10 }));
  assert.equal(label, 'downtrend');
});

test('range is the fallback when nothing else matches', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: false, ema200SlopeFalling: false, adx: 10, breadthPct: 40 }));
  assert.equal(label, 'range');
});

test('echoes the input metrics back unchanged alongside the label', () => {
  const metrics = baseMetrics();
  const result = labelRegime(metrics);
  assert.deepEqual(result.metrics, metrics);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-regime.test.js`
Expected: FAIL — `Cannot find module '../src/engine/regime'`

- [ ] **Step 3: Implement**

Create `src/engine/regime.js`:

```js
'use strict';

function labelRegime(metrics) {
  const { btcAboveEma200, ema200SlopeFalling, adx, breadthPct, volatilityRankPct, btc24hChangePct } = metrics;

  let label;
  if (volatilityRankPct > 90 || btc24hChangePct <= -6) {
    label = 'risk_off';
  } else if (btcAboveEma200 && adx > 22 && breadthPct >= 60) {
    label = 'trend_up';
  } else if (!btcAboveEma200 && ema200SlopeFalling) {
    label = 'downtrend';
  } else {
    label = 'range';
  }

  return { label, metrics };
}

module.exports = { labelRegime };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-regime.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/regime.js test/engine-regime.test.js
git commit -m "feat(engine): add labelRegime, the pure first-match-wins regime rule table"
```

---

## Task 5: `computeRegimeSeries` — the full pure composition

**Files:**
- Modify: `src/engine/regime.js`
- Test: `test/engine-regime.test.js` (append)

**Interfaces:**
- Produces: `computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h })` → `Array<{ ts, label, metrics }>`, one entry per `btc4h` index that has enough history (at least 220 daily candles behind it for EMA200+20-day slope, and at least `2 * 14` 4h candles for ADX to have a value). `btcDaily = [{ ts, close }]`, `btc4h = [{ ts, high, low, close }]`, `watchlistBy4h = { [coin]: [{ ts, close }] }` (every coin in the watchlist, including BTC itself, each coin's array sorted ascending by `ts` but **not necessarily the same length or the same timestamps as any other coin** — thinner pairs have real gaps).
- Consumed by: Task 6's `scripts/compute-regime-history.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/engine-regime.test.js`:

```js
const { computeRegimeSeries } = require('../src/engine/regime');

function makeDailySeries(days, closeFn) {
  const HOUR = 3600, DAY = 24 * HOUR;
  return Array.from({ length: days }, (_, i) => ({ ts: i * DAY, close: closeFn(i) }));
}

function make4hSeries(bars, priceFn, { skipIndices = new Set() } = {}) {
  const HOUR = 3600, FOUR_H = 4 * HOUR;
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    if (skipIndices.has(i)) continue; // a real gap — this timestamp is simply absent
    const p = priceFn(i);
    out.push({ ts: i * FOUR_H, high: p + 1, low: p - 1, close: p });
  }
  return out;
}

test('computeRegimeSeries only starts once there is enough daily and 4h history', () => {
  const btcDaily = makeDailySeries(225, (i) => 100 + i * 0.1); // 225 days: 200 for EMA200 + 20 for slope + margin
  const btc4h = make4hSeries(225 * 6, (i) => 100 + i * 0.02);
  const watchlistBy4h = { BTC: btc4h.map((c) => ({ ts: c.ts, close: c.close })) };

  const result = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });

  assert.ok(result.length > 0);
  assert.ok(result.length < btc4h.length, 'should not start from index 0 — not enough warm-up history there');
  assert.ok(result.every((r) => typeof r.label === 'string'));
});

test('computeRegimeSeries looks up breadth by timestamp, so a gap in one coin does not misalign another', () => {
  const btcDaily = makeDailySeries(225, (i) => 100 + i); // strongly trending up -> above EMA200
  const btc4h = make4hSeries(225 * 6, (i) => 100 + i * 0.5); // also trending up strongly for ADX
  // ETH has a gap right in the middle of the series — its array is shorter and
  // misaligned by position against btc4h, but every remaining entry's ts is honest.
  const ethFull = make4hSeries(225 * 6, (i) => 50 + i * 0.5);
  const ethWithGap = ethFull.filter((_, i) => i !== 500);

  const watchlistBy4h = {
    BTC: btc4h.map((c) => ({ ts: c.ts, close: c.close })),
    ETH: ethWithGap.map((c) => ({ ts: c.ts, close: c.close })),
  };

  const result = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });

  // Right after the gap, ETH's next real entry must still be matched to the SAME ts
  // as BTC's corresponding bar, not shifted by one position.
  const afterGap = result.find((r) => r.ts === btc4h[501].ts);
  assert.ok(afterGap, "expected a regime point at the bar right after ETH's gap");
  assert.equal(afterGap.metrics.breadthPct, 100); // both BTC and ETH are trending up, both above their EMA50
});

test('computeRegimeSeries never produces NaN or Infinity in any numeric metric', () => {
  const btcDaily = makeDailySeries(225, (i) => 100 + i * 0.1);
  const btc4h = make4hSeries(225 * 6, (i) => 100 + Math.sin(i / 10)); // oscillating, exercises choppiness/ADX edge cases
  const watchlistBy4h = { BTC: btc4h.map((c) => ({ ts: c.ts, close: c.close })) };

  const result = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });

  for (const point of result) {
    for (const [key, value] of Object.entries(point.metrics)) {
      if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `metric ${key} was not finite: ${value}`);
      }
    }
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-regime.test.js`
Expected: FAIL — `computeRegimeSeries is not a function`

- [ ] **Step 3: Implement**

In `src/engine/regime.js`:

```js
'use strict';
const { ema, adx, choppiness, atr } = require('./indicators');

function labelRegime(metrics) {
  const { btcAboveEma200, ema200SlopeFalling, adx: adxValue, breadthPct, volatilityRankPct, btc24hChangePct } = metrics;

  let label;
  if (volatilityRankPct > 90 || btc24hChangePct <= -6) {
    label = 'risk_off';
  } else if (btcAboveEma200 && adxValue > 22 && breadthPct >= 60) {
    label = 'trend_up';
  } else if (!btcAboveEma200 && ema200SlopeFalling) {
    label = 'downtrend';
  } else {
    label = 'range';
  }

  return { label, metrics };
}

const DAILY_EMA_PERIOD = 200;
const DAILY_SLOPE_LOOKBACK = 20;
const ADX_PERIOD = 14;
const VOLATILITY_WINDOW_BARS = 90 * 6; // 90 days of 4h bars

function computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h }) {
  const dailyCloses = btcDaily.map((c) => c.close);
  const dailyEma200 = ema(dailyCloses, DAILY_EMA_PERIOD);

  const adxResult = adx(btc4h, ADX_PERIOD);
  const choppinessSeries = choppiness(btc4h, ADX_PERIOD);
  const atrSeries = atr(btc4h, ADX_PERIOD);
  const atrPctSeries = atrSeries.map((v, i) => (v === null ? null : (v / btc4h[i].close) * 100));

  const breadthLookups = {};
  for (const [coin, series] of Object.entries(watchlistBy4h)) {
    const closes = series.map((c) => c.close);
    const ema50 = ema(closes, 50);
    const byTs = new Map();
    series.forEach((c, i) => {
      if (ema50[i] !== null) byTs.set(c.ts, c.close >= ema50[i]);
    });
    breadthLookups[coin] = byTs;
  }
  const coinNames = Object.keys(watchlistBy4h);

  let dailyPointer = 0; // advances forward only — btc4h and btcDaily are both ts-ascending
  const results = [];

  for (let i = 0; i < btc4h.length; i += 1) {
    const bar = btc4h[i];

    while (dailyPointer + 1 < btcDaily.length && btcDaily[dailyPointer + 1].ts <= bar.ts) {
      dailyPointer += 1;
    }
    if (btcDaily[dailyPointer].ts > bar.ts) continue; // no completed daily candle yet at all
    const ema200Now = dailyEma200[dailyPointer];
    const slopeIdx = dailyPointer - DAILY_SLOPE_LOOKBACK;
    if (ema200Now === null || slopeIdx < 0 || dailyEma200[slopeIdx] === null) continue;
    const ema200Then = dailyEma200[slopeIdx];

    if (adxResult.adx[i] === null || atrPctSeries[i] === null) continue;

    const windowStart = Math.max(0, i - VOLATILITY_WINDOW_BARS + 1);
    const window = atrPctSeries.slice(windowStart, i + 1).filter((v) => v !== null);
    const countBelowOrEqual = window.filter((v) => v <= atrPctSeries[i]).length;
    const volatilityRankPct = (countBelowOrEqual / window.length) * 100;

    let breadthCount = 0;
    for (const coin of coinNames) {
      if (breadthLookups[coin].get(bar.ts)) breadthCount += 1;
    }
    const breadthPct = (breadthCount / coinNames.length) * 100;

    const prevIdx = i - 6; // 6 bars of 4h = 24h
    const btc24hChangePct = prevIdx >= 0 ? ((bar.close - btc4h[prevIdx].close) / btc4h[prevIdx].close) * 100 : 0;

    const metrics = {
      btcAboveEma200: bar.close >= ema200Now,
      ema200SlopeFalling: ema200Now < ema200Then,
      adx: adxResult.adx[i],
      choppiness: choppinessSeries[i],
      breadthPct,
      volatilityRankPct,
      btc24hChangePct,
      positioning: null,
    };

    results.push({ ts: bar.ts, ...labelRegime(metrics) });
  }

  return results;
}

module.exports = { labelRegime, computeRegimeSeries };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-regime.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/regime.js test/engine-regime.test.js
git commit -m "feat(engine): add computeRegimeSeries, ts-aligned across gappy watchlist coins"
```

---

## Task 6: Regime history verification script

**Files:**
- Create: `scripts/compute-regime-history.js`

**Interfaces:**
- Consumes: `src/data/db.js` (`openDb`, `getCandles`), `src/engine/regime.js` (`computeRegimeSeries`).
- Produces: a CLI script, run as `node scripts/compute-regime-history.js`, that prints a readable regime timeline for manual review (not unit-tested — it's a thin read-and-print wrapper around already-tested pure logic, proven by the real run itself per this task's done-when).

- [ ] **Step 1: Write the script**

Create `scripts/compute-regime-history.js`:

```js
'use strict';
const { openDb, getCandles } = require('../src/data/db');
const { computeRegimeSeries } = require('../src/engine/regime');

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'LINK'];
const HOUR = 3600;
const SIX_MONTHS_SECONDS = 186 * 24 * HOUR;

function main() {
  const db = openDb();
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const fromTs = nowHour - SIX_MONTHS_SECONDS;

  // BTC's daily EMA200 needs well over 200 days of history behind the window start,
  // and our real DB has BTC history back to 2014, so pull everything available.
  const btcDaily = getCandles(db, 'BTC', '1d', 0, nowHour);
  const btc4h = getCandles(db, 'BTC', '4h', 0, nowHour);
  const watchlistBy4h = {};
  for (const coin of COINS) {
    watchlistBy4h[coin] = getCandles(db, coin, '4h', 0, nowHour).map((c) => ({ ts: c.ts, close: c.close }));
  }

  const series = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
  const windowed = series.filter((p) => p.ts >= fromTs);

  console.log(`Regime history: ${windowed.length} 4h points from ${new Date(fromTs * 1000).toISOString()} to ${new Date(nowHour * 1000).toISOString()}\n`);

  // Collapse consecutive same-label runs into readable ranges.
  let runStart = null, runLabel = null, runCount = 0;
  const flush = (endTs) => {
    if (runLabel === null) return;
    const days = ((endTs - runStart) / (24 * HOUR)).toFixed(1);
    console.log(`  ${new Date(runStart * 1000).toISOString().slice(0, 10)} -> ${new Date(endTs * 1000).toISOString().slice(0, 10)} (${days}d, ${runCount} bars): ${runLabel}`);
  };
  for (const point of windowed) {
    if (point.label !== runLabel) {
      flush(point.ts);
      runStart = point.ts; runLabel = point.label; runCount = 0;
    }
    runCount += 1;
  }
  if (windowed.length > 0) flush(windowed[windowed.length - 1].ts + 4 * HOUR);

  const distribution = {};
  for (const point of windowed) distribution[point.label] = (distribution[point.label] || 0) + 1;
  console.log('\nTime spent per regime:');
  for (const [label, count] of Object.entries(distribution)) {
    console.log(`  ${label}: ${((count / windowed.length) * 100).toFixed(1)}% (${count} bars)`);
  }

  const latest = windowed[windowed.length - 1];
  if (latest) {
    console.log(`\nCurrent regime: ${latest.label}`);
    console.log(`  metrics: ${JSON.stringify(latest.metrics, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))}`);
  }
}

main();
```

- [ ] **Step 2: Run it against the real backfilled DB**

Run: `node scripts/compute-regime-history.js`
Expected: prints a non-empty timeline of regime runs over roughly the last 6 months, a time-spent-per-regime breakdown summing to 100%, and a current regime with finite metric numbers.

- [ ] **Step 3: Eyeball-review the output with the user**

Check: does the timeline look plausible against known BTC market behavior over this period (e.g. periods of `risk_off` roughly coincide with sharp drawdowns, `trend_up` runs are multi-day not flickering every single 4h bar)? If `label` is flickering between `trend_up`/`range` every single bar, that's usually a sign the thresholds are too tight for real data — note it for the design doc's §13 Stage B regime-buffer idea, but don't change the milestone-3 thresholds without the user's say (they're copied verbatim from the spec).

- [ ] **Step 4: Commit**

```bash
git add scripts/compute-regime-history.js
git commit -m "feat(engine): add regime history verification script"
```

---

## Milestone 3 exit check

- [ ] `node --test test/` passes (all engine indicator/regime tests green, no regressions elsewhere).
- [ ] `node scripts/compute-regime-history.js` run against the real 6-month candle store, output reviewed with the user for plausibility.
