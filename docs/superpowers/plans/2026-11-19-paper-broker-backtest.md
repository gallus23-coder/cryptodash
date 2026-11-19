# Paper Broker + Backtester (Milestone 4, Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/broker/paper.js` (simulated fills, fees, slippage, and per-`exitType` exit management) and `src/backtest/run.js` (the historical replay that wires milestone 3's regime engine + Part A's risk guardrails and playbook setups + this plan's paper broker together), producing milestone 4's actual pass/fail verdict: per-setup R-based expectancy over the backtest window, vs buy-and-hold BTC, after fees.

**Architecture:** `broker/paper.js` is pure functions operating on explicit position objects — no internal state, so it's trivially testable and the same code could drive live trading later by swapping only the data source. `backtest/stats.js` holds the pure R/expectancy/drawdown math, extracted so the number that decides the gate is independently tested, not buried in an orchestration script. `backtest/run.js` is the one file allowed to touch the DB and hold mutable state (open positions, balance, cooldowns) — it's the only non-pure piece, and it's "proven by the real run" (milestone 2/3's established pattern for one-off orchestrators) rather than unit-tested end-to-end.

**Tech Stack:** Node.js 20, `better-sqlite3` (already a dependency), `node --test`. No new dependencies.

**Spec:** `docs/v2-design.md` §§5.2 (playbook), 5.4 (guardrails), 6 (execution/fees), 10 (milestone 4 pass/fail criteria), 13 Stage A (benchmark vs buy-and-hold); `CLAUDE.md`'s "Results in R" and "One exit order per position" rules.

**Depends on:** `docs/superpowers/plans/2026-11-18-risk-playbook.md` (Part A — `risk.js`, the 4 playbook setups) and the milestone 2/3 candle store + regime engine, all already merged to `v2`.

## Global Constraints

- Results measured in R (P&L ÷ amount risked) as well as £, per `CLAUDE.md`.
- One exit order per position — this plan's `evaluateExit` only ever returns a single exit (stop, target, ema-cross, or time-stop), never more than one at a time, matching the real exchange constraint confirmed in milestone 1.
- Milestone 4 pass/fail (design §10): keep setups with positive expectancy **and** 30+ trades over the backtest window; benchmark against buy-and-hold BTC (design §13 Stage A: return, worst drawdown, return÷worst-drawdown for bot vs BTC vs cash).
- Fees: maker 0.25% / taker 0.40% (design §6); round-trip fee for the fee-viability check (Part A's `checkFeeViability`) = maker + taker = 0.65%.
- Slippage: 0.05% (design §6 "Paper broker: fills at the next tick past the limit price, applies taker or maker fees and 0.05% slippage, checks stops against each 1h candle's low").
- Starting balance: £1,000 (design §8.4's paper-mode default).

## Interpretation decisions

- **Entry fills** at the signal bar's close price, adjusted by slippage, charged the **maker** fee (post-only limit near the close, as design §6 describes for entries). A full limit-order-queue simulation isn't needed for this gate — the question milestone 4 answers is "does the *edge* survive fees", not "exactly how many orders miss their fill."
- **Exits always check the stop/trail first, before any profit condition, within the same candle** — if a candle's low touches the stop *and* its high touches the target in the same hour, there's no way to know which happened first from OHLC data alone, so the conservative (stop) outcome wins. This matches design §6's "checks stops against each 1h candle's low" being the only intrabar check the spec names explicitly.
- **Stop/target touch-checking uses 1h candles** for every setup (design §6, applies generally). **`ema_cross_or_time`'s profit condition is checked at 4h-close granularity specifically**, because design §5.2 says "first **4h close** above the EMA20" in those exact terms — it isn't a touch condition, it's a close condition, and 4h is the setup's own timeframe.
- **`range_reversion`'s target (`bollinger_middle`) is fixed at the value from the signal bar**, not recalculated every hour the position is open. The setup's max holding period is 24h anyway (its own time stop), so a moving mean-reversion target over such a short window adds complexity the backtest doesn't need.
- **The trailing stop's ATR distance is fixed at entry** (`atrAtEntry`), not recalculated each hour. The trail's *level* still ratchets up every hour as `highestHigh` rises — only the ATR distance itself is frozen. Recalculating ATR hourly would need an hourly-granularity ATR series that nothing else in this plan uses.
- **Guardrail caps block the whole candidate, never partially size it down.** Part A's `checkGuardrails` is binary (allowed/blocked) — if a candidate would breach a cap, it's skipped entirely this cycle, not resized to fit.
- **`risk_off`'s "tighten trailing stops on open trades" is out of scope for milestone 4.** Design §13 explicitly marks exit-rule refinements (including a `risk_off` stop-tightening rule) as Stage B, "only if the milestone 4 backtest shows an edge." Milestone 4 itself only needs `risk_off` to block new entries — existing positions ride out normally.

## Review Focus

- A candle where both the stop *and* the profit condition would trigger must resolve to the stop (the worse outcome) — an implementation that checks profit first would systematically overstate the backtest's results.
- The trailing stop must only ratchet up (tighten), never loosen, even across a candle where price pulls back hard after a new high.
- `ema_cross_or_time`'s 4h-boundary detection must map each 1h bar to *its own* parent 4h candle's timestamp, not an adjacent one — an off-by-one here silently compares price against the wrong EMA20 value every single time, in a way no "does it run" smoke test would catch.
- The guardrail state built from `state.openPositions` each cycle must only include genuinely still-open positions — a closed position whose slot/risk/exposure isn't freed would either wrongly block all future trades or (worse) wrongly permit over-exposure if freed in the wrong direction.
- The weekly kill switch, once tripped, must never reset for the rest of the backtest run (design: "restarted by hand") — the daily loss limit, by contrast, must reset every UTC midnight. Conflating the two (e.g. accidentally resetting the kill switch daily too) would silently let a blown account keep trading.

---

## Task 1: `broker/paper.js` — entry/exit fills (fees + slippage)

**Files:**
- Create: `src/broker/paper.js`
- Test: `test/broker-paper.test.js`

**Interfaces:**
- Produces: `fillEntry({ candidate, sizing, fees?, slippagePct? })` → `{ fillPrice, feeAmount }` (`fillPrice = candidate.entry * (1 + slippagePct)`, `feeAmount = sizing.stakeValue * fees.makerPct`). `fillExit({ exitPrice, stakeValue, fees?, slippagePct? })` → `{ fillPrice, feeAmount }` (`fillPrice = exitPrice * (1 - slippagePct)`, `feeAmount = stakeValue * fees.takerPct`). `DEFAULT_FEES = { makerPct: 0.0025, takerPct: 0.0040 }`, `DEFAULT_SLIPPAGE_PCT = 0.0005`, both exported so callers (and tests) don't hardcode magic numbers twice.
- Consumed by: Task 6 (`backtest/run.js`'s `tryOpenPosition`/`closePosition`).

- [ ] **Step 1: Write the failing tests**

Create `test/broker-paper.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fillEntry, fillExit, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT } = require('../src/broker/paper');

test('fillEntry slips the price up (worse for a buyer) and charges the maker fee', () => {
  const result = fillEntry({
    candidate: { entry: 100 },
    sizing: { stakeValue: 1000 },
  });

  assert.equal(result.fillPrice, 100 * (1 + DEFAULT_SLIPPAGE_PCT));
  assert.equal(result.feeAmount, 1000 * DEFAULT_FEES.makerPct);
});

test('fillExit slips the price down (worse for a seller) and charges the taker fee', () => {
  const result = fillExit({
    exitPrice: 100,
    stakeValue: 1000,
  });

  assert.equal(result.fillPrice, 100 * (1 - DEFAULT_SLIPPAGE_PCT));
  assert.equal(result.feeAmount, 1000 * DEFAULT_FEES.takerPct);
});

test('fillEntry/fillExit accept overrides for fees and slippage', () => {
  const entry = fillEntry({
    candidate: { entry: 100 }, sizing: { stakeValue: 1000 },
    fees: { makerPct: 0.001, takerPct: 0.002 }, slippagePct: 0.01,
  });
  assert.equal(entry.fillPrice, 101);
  assert.equal(entry.feeAmount, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/broker-paper.test.js`
Expected: FAIL — `Cannot find module '../src/broker/paper'`

- [ ] **Step 3: Implement**

Create `src/broker/paper.js`:

```js
'use strict';

const DEFAULT_FEES = { makerPct: 0.0025, takerPct: 0.0040 };
const DEFAULT_SLIPPAGE_PCT = 0.0005;

function fillEntry({ candidate, sizing, fees = DEFAULT_FEES, slippagePct = DEFAULT_SLIPPAGE_PCT }) {
  const fillPrice = candidate.entry * (1 + slippagePct);
  const feeAmount = sizing.stakeValue * fees.makerPct;
  return { fillPrice, feeAmount };
}

function fillExit({ exitPrice, stakeValue, fees = DEFAULT_FEES, slippagePct = DEFAULT_SLIPPAGE_PCT }) {
  const fillPrice = exitPrice * (1 - slippagePct);
  const feeAmount = stakeValue * fees.takerPct;
  return { fillPrice, feeAmount };
}

module.exports = { fillEntry, fillExit, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/broker-paper.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/broker/paper.js test/broker-paper.test.js
git commit -m "feat(broker): add paper fill simulation (fees, slippage)"
```

---

## Task 2: `broker/paper.js` — `trailing_stop` exit management

**Files:**
- Modify: `src/broker/paper.js`
- Test: `test/broker-paper.test.js` (append)

**Interfaces:**
- Produces: `evaluateExit(position, { candles1h, ema20By4hTs })` → `{ exitTs, exitPrice, reason } | null`. `position` for this task needs: `{ exitType: 'trailing_stop', entryPrice, initialStopPrice, trailAtr, atrAtEntry }`. `candles1h` is every 1h candle **after** entry up to "now" (the caller's job to slice). This task only implements the `trailing_stop` branch; Task 3 adds the other two.
- Consumed by: Task 6 (`backtest/run.js`'s position-management loop).

- [ ] **Step 1: Write the failing tests**

Append to `test/broker-paper.test.js`:

```js
const { evaluateExit } = require('../src/broker/paper');

function trailingPosition(overrides = {}) {
  return {
    exitType: 'trailing_stop', entryPrice: 100, initialStopPrice: 90,
    trailAtr: 3, atrAtEntry: 5, // trail distance = 15
    ...overrides,
  };
}

test('trailing_stop ratchets the stop up as price makes new highs, never loosens', () => {
  const position = trailingPosition();
  const candles1h = [
    { ts: 3600, high: 110, low: 108, close: 109 },  // highestHigh=110, trail=95, stop=max(90,95)=95
    { ts: 7200, high: 130, low: 125, close: 128 },  // highestHigh=130, trail=115, stop=max(90,115)=115
    { ts: 10800, high: 131, low: 114, close: 116 }, // highestHigh=131, trail=116, stop=116 -> low 114 <= 116, exit
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 10800, exitPrice: 116, reason: 'stop' });
});

test('trailing_stop exits at the fixed initial stop if price never rallies', () => {
  const position = trailingPosition();
  const candles1h = [
    { ts: 3600, high: 101, low: 99, close: 100 },  // no new high worth trailing from
    { ts: 7200, high: 100, low: 89, close: 90 },   // low 89 <= initial stop 90
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 7200, exitPrice: 90, reason: 'stop' });
});

test('trailing_stop returns null (stays open) if neither the trail nor the initial stop is touched', () => {
  const position = trailingPosition();
  const candles1h = [
    { ts: 3600, high: 105, low: 100, close: 103 },
    { ts: 7200, high: 106, low: 101, close: 104 },
  ];

  assert.equal(evaluateExit(position, { candles1h, ema20By4hTs: new Map() }), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/broker-paper.test.js`
Expected: FAIL — `evaluateExit is not a function`

- [ ] **Step 3: Implement**

In `src/broker/paper.js`, add before `module.exports`:

```js
function evaluateExit(position, { candles1h, ema20By4hTs }) {
  let highestHigh = position.entryPrice;

  for (const candle of candles1h) {
    if (position.exitType === 'trailing_stop') {
      highestHigh = Math.max(highestHigh, candle.high);
    }
    const currentStopPrice = position.exitType === 'trailing_stop'
      ? Math.max(position.initialStopPrice, highestHigh - position.trailAtr * position.atrAtEntry)
      : position.initialStopPrice;

    if (candle.low <= currentStopPrice) {
      return { exitTs: candle.ts, exitPrice: currentStopPrice, reason: 'stop' };
    }
  }

  return null;
}

module.exports = { fillEntry, fillExit, evaluateExit, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/broker-paper.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/broker/paper.js test/broker-paper.test.js
git commit -m "feat(broker): add trailing_stop exit management (ratchet-only)"
```

---

## Task 3: `broker/paper.js` — `target_or_time` + `ema_cross_or_time` exits

**Files:**
- Modify: `src/broker/paper.js`
- Test: `test/broker-paper.test.js` (append)

**Interfaces:**
- Produces: `evaluateExit` now also handles `position.exitType === 'target_or_time'` (needs `targetPrice`, `timeStopTs`) and `'ema_cross_or_time'` (needs `timeStopTs`; reads `ema20By4hTs`, a `Map<fourHourCandleTs, number>`).
- Consumed by: Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `test/broker-paper.test.js`:

```js
test('target_or_time exits at the target when a candle high touches it', () => {
  const position = { exitType: 'target_or_time', initialStopPrice: 50, targetPrice: 110, timeStopTs: 100000 };
  const candles1h = [
    { ts: 3600, high: 105, low: 95, close: 102 },
    { ts: 7200, high: 111, low: 100, close: 108 }, // high touches target 110
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 7200, exitPrice: 110, reason: 'target' });
});

test('target_or_time exits via time stop when neither stop nor target is hit in time', () => {
  const position = { exitType: 'target_or_time', initialStopPrice: 50, targetPrice: 110, timeStopTs: 7200 };
  const candles1h = [
    { ts: 3600, high: 105, low: 95, close: 102 },
    { ts: 7200, high: 106, low: 96, close: 104 }, // reaches the time stop here
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 7200, exitPrice: 104, reason: 'time_stop' });
});

test('stop-loss takes priority over target/ema-cross within the same candle', () => {
  const position = { exitType: 'target_or_time', initialStopPrice: 100, targetPrice: 100, timeStopTs: 100000 };
  const candles1h = [{ ts: 3600, high: 105, low: 99, close: 101 }]; // low breaches stop AND high touches target

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.equal(result.reason, 'stop');
});

test('ema_cross_or_time exits when the 4h close crosses above EMA20', () => {
  // A full 4h period: 4 consecutive 1h bars starting at ts=0; the 4h candle's own
  // ts is 0 (its last constituent 1h bar has ts=10800, which is 0+10800).
  const position = { exitType: 'ema_cross_or_time', initialStopPrice: 50, timeStopTs: 100000 };
  const candles1h = [
    { ts: 0, high: 101, low: 99, close: 100 },
    { ts: 3600, high: 102, low: 99, close: 101 },
    { ts: 7200, high: 103, low: 99, close: 102 },
    { ts: 10800, high: 106, low: 99, close: 105 }, // last hour of the 4h period, close=105
  ];
  const ema20By4hTs = new Map([[0, 100]]); // the 4h candle at ts=0 has EMA20=100; close 105 > 100

  const result = evaluateExit(position, { candles1h, ema20By4hTs });

  assert.deepEqual(result, { exitTs: 10800, exitPrice: 105, reason: 'ema_cross' });
});

test('ema_cross_or_time does not exit on a mid-4h-period hour, only on the 4h close', () => {
  const position = { exitType: 'ema_cross_or_time', initialStopPrice: 50, timeStopTs: 100000 };
  // This single candle is NOT the last hour of its 4h period (ts=3600 % 14400 !== 10800),
  // so even though its close is above the mapped EMA20, it must not trigger an exit.
  const candles1h = [{ ts: 3600, high: 102, low: 99, close: 101 }];
  const ema20By4hTs = new Map([[0, 50]]);

  assert.equal(evaluateExit(position, { candles1h, ema20By4hTs }), null);
});

test('ema_cross_or_time exits via time stop when the EMA never crosses', () => {
  const position = { exitType: 'ema_cross_or_time', initialStopPrice: 50, timeStopTs: 10800 };
  const candles1h = [
    { ts: 0, high: 101, low: 99, close: 100 },
    { ts: 3600, high: 102, low: 99, close: 101 },
    { ts: 7200, high: 103, low: 99, close: 102 },
    { ts: 10800, high: 103, low: 99, close: 102 }, // close 102 stays below EMA20=150
  ];
  const ema20By4hTs = new Map([[0, 150]]);

  const result = evaluateExit(position, { candles1h, ema20By4hTs });

  assert.deepEqual(result, { exitTs: 10800, exitPrice: 102, reason: 'time_stop' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/broker-paper.test.js`
Expected: FAIL — `target_or_time exits at the target...` fails (returns `null`, since only `trailing_stop` is handled so far; `currentStopPrice` falls back to `position.initialStopPrice` for other types, which is correct, but there's no target/time-stop/ema-cross logic yet, so these tests see `null` or a bare stop-check result instead of the expected target/time/ema outcomes)

- [ ] **Step 3: Implement**

In `src/broker/paper.js`, inside the `for (const candle of candles1h)` loop in `evaluateExit`, add after the existing stop check:

```js
    if (position.exitType === 'target_or_time') {
      if (candle.high >= position.targetPrice) {
        return { exitTs: candle.ts, exitPrice: position.targetPrice, reason: 'target' };
      }
      if (candle.ts >= position.timeStopTs) {
        return { exitTs: candle.ts, exitPrice: candle.close, reason: 'time_stop' };
      }
    }

    if (position.exitType === 'ema_cross_or_time') {
      const isLastHourOfFourHourPeriod = candle.ts % 14400 === 10800;
      if (isLastHourOfFourHourPeriod) {
        const fourHourTs = candle.ts - 10800;
        const ema20 = ema20By4hTs.get(fourHourTs);
        if (ema20 !== undefined && candle.close > ema20) {
          return { exitTs: candle.ts, exitPrice: candle.close, reason: 'ema_cross' };
        }
      }
      if (candle.ts >= position.timeStopTs) {
        return { exitTs: candle.ts, exitPrice: candle.close, reason: 'time_stop' };
      }
    }
```

(This goes between the existing `if (candle.low <= currentStopPrice) { ... }` block and the loop's closing brace — the full function now has three type-specific blocks after the shared stop check, in the same loop iteration.)

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/broker-paper.test.js`
Expected: PASS (all tests — 11 total)

- [ ] **Step 5: Commit**

```bash
git add src/broker/paper.js test/broker-paper.test.js
git commit -m "feat(broker): add target_or_time and ema_cross_or_time exit management"
```

---

## Task 4: `backtest/stats.js` — R, expectancy, drawdown

**Files:**
- Create: `src/backtest/stats.js`
- Test: `test/backtest-stats.test.js`

**Interfaces:**
- Produces: `computeTradeR(pnl, riskAmount)` → `number`. `computeExpectancy(trades)` → `{ count, winRate, expectancy, pass }` (`trades` is any array of objects with a numeric `.r` field; `pass = expectancy > 0 && count >= 30`, the milestone 4 gate rule verbatim). `computeDrawdown(values)` → `{ peak, maxDrawdownPct }` (`values` is any array of numbers — an equity curve or a price series; reusable for both the bot's balance and BTC's price).
- Consumed by: Task 6 (`backtest/run.js`'s final report).

- [ ] **Step 1: Write the failing tests**

Create `test/backtest-stats.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeTradeR, computeExpectancy, computeDrawdown } = require('../src/backtest/stats');

test('computeTradeR divides P&L by the amount risked', () => {
  assert.equal(computeTradeR(50, 100), 0.5);
  assert.equal(computeTradeR(-25, 100), -0.25);
});

test('computeExpectancy averages R across trades and reports win rate', () => {
  const trades = [{ r: 1 }, { r: -0.5 }, { r: 2 }, { r: -1 }];
  const result = computeExpectancy(trades);

  assert.equal(result.count, 4);
  assert.equal(result.winRate, 0.5);
  assert.equal(result.expectancy, 0.375); // (1 - 0.5 + 2 - 1) / 4
});

test('computeExpectancy fails the gate with fewer than 30 trades even if expectancy is positive', () => {
  const trades = Array.from({ length: 29 }, () => ({ r: 1 }));
  assert.equal(computeExpectancy(trades).pass, false);
});

test('computeExpectancy fails the gate with 30+ trades if expectancy is not positive', () => {
  const trades = Array.from({ length: 30 }, () => ({ r: 0 }));
  assert.equal(computeExpectancy(trades).pass, false);
});

test('computeExpectancy passes the gate with 30+ trades and positive expectancy', () => {
  const trades = Array.from({ length: 30 }, (_, i) => ({ r: i % 2 === 0 ? 1 : -0.3 }));
  assert.equal(computeExpectancy(trades).pass, true);
});

test('computeExpectancy handles zero trades without dividing by zero', () => {
  assert.deepEqual(computeExpectancy([]), { count: 0, winRate: 0, expectancy: 0, pass: false });
});

test('computeDrawdown tracks the worst peak-to-trough drop as a percentage', () => {
  const result = computeDrawdown([100, 120, 90, 110]); // peak 120, trough 90 -> (120-90)/120 = 0.25
  assert.equal(result.peak, 120);
  assert.equal(result.maxDrawdownPct, 0.25);
});

test('computeDrawdown is zero for a monotonically rising series', () => {
  const result = computeDrawdown([100, 110, 120]);
  assert.equal(result.maxDrawdownPct, 0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/backtest-stats.test.js`
Expected: FAIL — `Cannot find module '../src/backtest/stats'`

- [ ] **Step 3: Implement**

Create `src/backtest/stats.js`:

```js
'use strict';

function computeTradeR(pnl, riskAmount) {
  return pnl / riskAmount;
}

function computeExpectancy(trades) {
  if (trades.length === 0) return { count: 0, winRate: 0, expectancy: 0, pass: false };
  const totalR = trades.reduce((sum, t) => sum + t.r, 0);
  const expectancy = totalR / trades.length;
  const wins = trades.filter((t) => t.r > 0).length;
  const winRate = wins / trades.length;
  const pass = expectancy > 0 && trades.length >= 30;
  return { count: trades.length, winRate, expectancy, pass };
}

function computeDrawdown(values) {
  let peak = values.length > 0 ? values[0] : 0;
  let maxDrawdownPct = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - v) / peak);
  }
  return { peak, maxDrawdownPct };
}

module.exports = { computeTradeR, computeExpectancy, computeDrawdown };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/backtest-stats.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/backtest/stats.js test/backtest-stats.test.js
git commit -m "feat(backtest): add pure R/expectancy/drawdown stats"
```

---

## Task 5: `backtest/run.js` — per-coin indicator data builder

**Files:**
- Create: `src/backtest/run.js`
- Test: `test/backtest-run.test.js`

**Interfaces:**
- Produces: `buildCoinData({ candles4h, candles1h, candlesDaily })` → `{ candles4h, candles1h, indicators, ema20By4hTs }` where `indicators = { ema20, ema50, rsi14, rsi2, atr14, donchian20, bollinger20, adx14, dailyEma200Aligned }` (every array the same length as `candles4h`, computed once via `src/engine/indicators.js` + `alignDailyIndices`). `ema20By4hTs` is a `Map<ts, number>` keyed by each `candles4h` entry's own `ts`, skipping `null` (warm-up) values. This function takes plain candle arrays — no DB access — so it's directly testable with small synthetic fixtures; `main()` (Task 6) is the only place that calls `openDb`/`getCandles`.
- Consumed by: Task 6's `main()`.

- [ ] **Step 1: Write the failing test**

Create `test/backtest-run.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCoinData } = require('../src/backtest/run');

function makeFixture() {
  const DAY = 24 * 3600, FOUR_H = 4 * 3600;
  const candlesDaily = Array.from({ length: 230 }, (_, i) => ({ ts: i * DAY, close: 100 + i * 0.1 }));
  const candles4h = Array.from({ length: 230 * 6 }, (_, i) => {
    const price = 100 + i * 0.02;
    return { ts: i * FOUR_H, open: price, high: price + 1, low: price - 1, close: price };
  });
  const candles1h = Array.from({ length: 230 * 24 }, (_, i) => {
    const price = 100 + i * (0.02 / 4);
    return { ts: i * 3600, open: price, high: price + 0.5, low: price - 0.5, close: price };
  });
  return { candles4h, candles1h, candlesDaily };
}

test('buildCoinData returns one indicator value per 4h candle, with dailyEma200Aligned look-ahead-safe', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();

  const data = buildCoinData({ candles4h, candles1h, candlesDaily });

  assert.equal(data.indicators.ema20.length, candles4h.length);
  assert.equal(data.indicators.dailyEma200Aligned.length, candles4h.length);
  assert.equal(data.indicators.adx14.adx.length, candles4h.length);
  // Well past warm-up (the fixture has 230 days / 1380 4h-bars), everything should be populated.
  const lastIdx = candles4h.length - 1;
  assert.ok(data.indicators.ema20[lastIdx] !== null);
  assert.ok(data.indicators.dailyEma200Aligned[lastIdx] !== null);
});

test('buildCoinData builds ema20By4hTs keyed by each 4h candle\'s own ts, skipping warm-up nulls', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();

  const data = buildCoinData({ candles4h, candles1h, candlesDaily });

  assert.equal(data.ema20By4hTs.size, candles4h.length - 19); // ema20 needs 20 bars, so 19 are null
  const lastBar = candles4h[candles4h.length - 1];
  assert.equal(data.ema20By4hTs.get(lastBar.ts), data.indicators.ema20[candles4h.length - 1]);
  assert.equal(data.ema20By4hTs.has(candles4h[0].ts), false); // index 0 is warm-up, should be skipped
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/backtest-run.test.js`
Expected: FAIL — `Cannot find module '../src/backtest/run'`

- [ ] **Step 3: Implement**

Create `src/backtest/run.js`:

```js
'use strict';
const { ema, rsi, atr, adx, donchian, bollinger } = require('../engine/indicators');
const { alignDailyIndices } = require('../engine/regime');

function buildCoinData({ candles4h, candles1h, candlesDaily }) {
  const closes4h = candles4h.map((c) => c.close);
  const dailyCloses = candlesDaily.map((c) => c.close);
  const dailyEma200 = ema(dailyCloses, 200);
  const dailyIdx = alignDailyIndices(candlesDaily, candles4h);
  const dailyEma200Aligned = dailyIdx.map((idx) => (idx === null ? null : dailyEma200[idx]));

  const indicators = {
    ema20: ema(closes4h, 20),
    ema50: ema(closes4h, 50),
    rsi14: rsi(closes4h, 14),
    rsi2: rsi(closes4h, 2),
    atr14: atr(candles4h, 14),
    donchian20: donchian(candles4h, 20),
    bollinger20: bollinger(closes4h, 20, 2),
    adx14: adx(candles4h, 14),
    dailyEma200Aligned,
  };

  const ema20By4hTs = new Map();
  candles4h.forEach((c, i) => {
    if (indicators.ema20[i] !== null) ema20By4hTs.set(c.ts, indicators.ema20[i]);
  });

  return { candles4h, candles1h, indicators, ema20By4hTs };
}

module.exports = { buildCoinData };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/backtest-run.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/backtest/run.js test/backtest-run.test.js
git commit -m "feat(backtest): add per-coin indicator data builder"
```

---

## Task 6: `backtest/run.js` — walk-forward loop, guardrails, and report

**Files:**
- Modify: `src/backtest/run.js`

**Interfaces:**
- Produces: `main()` — reads the real DB, builds each coin's data (Task 5), computes the regime series (milestone 3's `computeRegimeSeries`), walks forward through every 4h timestamp in the backtest window opening/closing positions via Part A's playbook + risk guardrails and this plan's paper broker, then prints the milestone 4 report (per-setup pass/fail, bot vs BTC vs cash benchmark). Not unit-tested — this is the orchestration layer; Task 7 is its real-data proof.
- Consumes: `buildCoinData` (Task 5), `fillEntry`/`fillExit`/`evaluateExit` (Tasks 1-3), `computeTradeR`/`computeExpectancy`/`computeDrawdown` (Task 4), `computeRegimeSeries`/`alignDailyIndices` (milestone 3's `src/engine/regime.js`), `sizePosition`/`checkFeeViability`/`checkGuardrails`/`isDailyLossLimitHit`/`isKillSwitchTriggered` (Part A's `src/engine/risk.js`), and the four playbook setups' `evaluate` (Part A's `src/engine/playbook/*.js`).

- [ ] **Step 1: Write the orchestration code**

In `src/backtest/run.js`, add after `buildCoinData` (before `module.exports`):

```js
const { openDb, getCandles } = require('../data/db');
const { computeRegimeSeries } = require('../engine/regime');
const { sizePosition, checkFeeViability, checkGuardrails, isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
const trendBreakout = require('../engine/playbook/trendBreakout');
const trendPullback = require('../engine/playbook/trendPullback');
const rangeReversion = require('../engine/playbook/rangeReversion');
const oversoldBounce = require('../engine/playbook/oversoldBounce');
const { fillEntry, fillExit, evaluateExit } = require('../broker/paper');
const { computeTradeR, computeExpectancy, computeDrawdown } = require('./stats');

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'LINK'];
const HOUR = 3600, FOUR_H = 4 * 3600, DAY = 24 * 3600;
const SIX_MONTHS_SECONDS = 186 * DAY;

const CONFIG = {
  baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
  maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6,
  dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08,
  roundTripFeePct: 0.65, // percent, matches checkFeeViability's expected units
};

const SETUPS = {
  trend_breakout: trendBreakout, trend_pullback: trendPullback,
  range_reversion: rangeReversion, oversold_bounce: oversoldBounce,
};
const SETUPS_BY_REGIME = {
  trend_up: ['trend_breakout', 'trend_pullback'],
  range: ['range_reversion'],
  downtrend: ['oversold_bounce'],
  risk_off: [],
};

function tryOpenPosition(state, candidate, data, i, config) {
  const atrPct = (candidate.atr / candidate.entry) * 100;
  if (!checkFeeViability({ atrPct, roundTripFeePct: config.roundTripFeePct })) return;

  const stopPrice = candidate.entry - candidate.default.stopAtr * candidate.atr;
  const riskPct = config.baseRiskPct * candidate.default.size;
  const sizing = sizePosition({ balance: state.balance, riskPct, entryPrice: candidate.entry, stopPrice });
  const exposurePct = sizing.stakeValue / state.balance;
  const barTs = data.candles4h[i].ts;

  const gate = checkGuardrails(
    {
      openPositions: state.openPositions.map((p) => ({ coin: p.coin, riskPct: p.riskPct, exposurePct: p.exposurePct })),
      cooldowns: state.cooldowns,
    },
    { coin: candidate.coin, riskPct, exposurePct, ts: barTs },
    config,
  );
  if (!gate.allowed) return;

  const fill = fillEntry({ candidate, sizing });
  const position = {
    coin: candidate.coin, setup: candidate.setup, entryTs: barTs,
    entryPrice: fill.fillPrice, units: sizing.units, riskAmount: sizing.riskAmount,
    riskPct, exposurePct, initialStopPrice: stopPrice, atrAtEntry: candidate.atr,
    exitType: candidate.exitType, trailAtr: candidate.default.trailAtr,
    targetPrice: candidate.exitType === 'target_or_time' ? data.indicators.bollinger20.middle[i] : undefined,
    timeStopTs: candidate.timeStopHours !== undefined ? barTs + candidate.timeStopHours * 3600 : undefined,
    entryFee: fill.feeAmount,
  };
  state.balance -= fill.feeAmount;
  state.openPositions.push(position);
}

function closePosition(state, position, exit, config) {
  const stakeValue = position.units * position.entryPrice;
  const fill = fillExit({ exitPrice: exit.exitPrice, stakeValue });
  const pnl = (fill.fillPrice - position.entryPrice) * position.units - position.entryFee - fill.feeAmount;
  const r = computeTradeR(pnl, position.riskAmount);

  state.balance += pnl;
  state.dailyPnl += pnl;
  state.openPositions = state.openPositions.filter((p) => p !== position);
  state.cooldowns[position.coin] = exit.exitTs + config.cooldownHours * 3600;
  state.closedTrades.push({ ...position, exitTs: exit.exitTs, exitPrice: fill.fillPrice, pnl, r, exitReason: exit.reason });
}

function runBacktest(db, config = CONFIG) {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const fromTs = nowHour - SIX_MONTHS_SECONDS;

  const btcDaily = getCandles(db, 'BTC', '1d', 0, nowHour);
  const btc4h = getCandles(db, 'BTC', '4h', fromTs, nowHour);
  const watchlistBy4h = {};
  for (const coin of COINS) {
    watchlistBy4h[coin] = getCandles(db, coin, '4h', fromTs, nowHour).map((c) => ({ ts: c.ts, close: c.close }));
  }
  const regimeByTs = new Map(computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h }).map((r) => [r.ts, r.label]));

  const coinData = {};
  for (const coin of COINS) {
    coinData[coin] = buildCoinData({
      candles4h: getCandles(db, coin, '4h', fromTs, nowHour),
      candles1h: getCandles(db, coin, '1h', fromTs, nowHour + FOUR_H),
      candlesDaily: getCandles(db, coin, '1d', 0, nowHour),
    });
  }

  const startingBalance = 1000;
  const state = {
    balance: startingBalance, dailyPnl: 0, currentDay: null,
    weeklyPeakBalance: startingBalance, killSwitchActive: false,
    openPositions: [], cooldowns: {}, closedTrades: [], equityCurve: [],
  };

  for (const bar of btc4h) {
    const ts = bar.ts;
    const regimeLabel = regimeByTs.get(ts);
    if (regimeLabel === undefined) continue;

    const dayKey = Math.floor(ts / DAY);
    if (state.currentDay !== dayKey) {
      state.currentDay = dayKey;
      state.dailyPnl = 0;
    }

    for (const position of [...state.openPositions]) {
      const data = coinData[position.coin];
      const candles1hSlice = data.candles1h.filter((c) => c.ts > position.entryTs && c.ts <= ts + FOUR_H - HOUR);
      const exit = evaluateExit(position, { candles1h: candles1hSlice, ema20By4hTs: data.ema20By4hTs });
      if (exit) closePosition(state, position, exit, config);
    }

    state.weeklyPeakBalance = Math.max(state.weeklyPeakBalance, state.balance);
    const weeklyDrawdownPct = (state.weeklyPeakBalance - state.balance) / state.weeklyPeakBalance;
    if (isKillSwitchTriggered(weeklyDrawdownPct, config)) state.killSwitchActive = true;
    const dailyLossHit = isDailyLossLimitHit(state.dailyPnl / startingBalance, config);

    if (!state.killSwitchActive && !dailyLossHit && regimeLabel !== 'risk_off') {
      for (const coin of COINS) {
        const data = coinData[coin];
        const i = data.candles4h.findIndex((c) => c.ts === ts);
        if (i === -1) continue;
        for (const setupName of SETUPS_BY_REGIME[regimeLabel] || []) {
          const candidate = SETUPS[setupName].evaluate(coin, data.candles4h, data.indicators, i, regimeLabel);
          if (candidate) tryOpenPosition(state, candidate, data, i, config);
        }
      }
    }

    state.equityCurve.push(state.balance);
  }

  return { state, btc4h, startingBalance };
}

function printReport({ state, btc4h, startingBalance }) {
  const bySetup = {};
  for (const trade of state.closedTrades) {
    (bySetup[trade.setup] = bySetup[trade.setup] || []).push(trade);
  }

  console.log(`\nBacktest: ${state.closedTrades.length} closed trades, final balance £${state.balance.toFixed(2)} (started £${startingBalance})`);
  console.log('\nPer-setup results (milestone 4 gate: positive expectancy AND 30+ trades):');
  for (const [setup, trades] of Object.entries(bySetup)) {
    const { count, winRate, expectancy, pass } = computeExpectancy(trades);
    console.log(`  ${setup}: ${count} trades, win rate ${(winRate * 100).toFixed(1)}%, expectancy ${expectancy.toFixed(2)}R -> ${pass ? 'PASS' : 'FAIL'}`);
  }

  const botReturnPct = ((state.balance - startingBalance) / startingBalance) * 100;
  const botDD = computeDrawdown([startingBalance, ...state.equityCurve]);

  const btcCloses = btc4h.map((c) => c.close);
  const btcReturnPct = ((btcCloses[btcCloses.length - 1] - btcCloses[0]) / btcCloses[0]) * 100;
  const btcDD = computeDrawdown(btcCloses);

  console.log('\nBenchmark (vs buy-and-hold BTC, vs cash):');
  console.log(`  Bot:  return ${botReturnPct.toFixed(1)}%, worst drawdown ${(botDD.maxDrawdownPct * 100).toFixed(1)}%`);
  console.log(`  BTC:  return ${btcReturnPct.toFixed(1)}%, worst drawdown ${(btcDD.maxDrawdownPct * 100).toFixed(1)}%`);
  console.log('  Cash: return 0.0%, worst drawdown 0.0%');
}

function main() {
  const db = openDb();
  const result = runBacktest(db);
  printReport(result);
}

if (require.main === module) main();

module.exports = { buildCoinData, runBacktest, printReport };
```

- [ ] **Step 2: Sanity-check it loads and runs end-to-end against the real DB**

Run: `node src/backtest/run.js`
Expected: prints the backtest report (trade count, per-setup pass/fail lines, benchmark section) without throwing — correctness of the *numbers* is Task 7's job, this step just proves the wiring doesn't crash.

- [ ] **Step 3: Commit**

```bash
git add src/backtest/run.js
git commit -m "feat(backtest): add walk-forward loop, guardrail wiring, and milestone 4 report"
```

---

## Task 7: Run the real milestone 4 backtest and review the pass/fail verdict

This is the actual gate. Design §10: "if the default playbook shows no positive expectancy over May–Nov 2026 after fees, fix or replace the setups before building milestones 6+."

- [ ] **Step 1: Run it**

Run: `node src/backtest/run.js`

- [ ] **Step 2: Read every number, not just PASS/FAIL**

For each setup, check: trade count (is 30+ actually reachable given ~6 months of data and this setup's firing frequency, or does the report show e.g. 3 trades — too few to judge at all, not a real pass or fail), win rate, expectancy in R. For the benchmark section, check the bot's return and drawdown against BTC's.

- [ ] **Step 3: If a setup shows 0 or very few trades, investigate before concluding anything**

A setup firing 0 times in 6 months across 6 coins is far more likely a plumbing bug (wrong regime filter, warm-up never clearing, an index mismatch) than a genuinely-never-occurring market condition — use `superpowers:systematic-debugging` to check the setup's conditions against real indicator values at a few sample points, rather than reporting "0 trades" as the gate result.

- [ ] **Step 4: Report the actual verdict to the user**

Per design §10's rule — setups with positive expectancy and 30+ trades pass; keep those. If none pass, say so plainly: the spec's own instruction is to fix or replace setups before milestone 6, not to proceed with a non-passing playbook. This is the user's call to make, not something to paper over.

---

## Part B exit check

- [ ] `node --test test/` passes (all new broker/stats/backtest-data-builder tests green, no regressions).
- [ ] `node src/backtest/run.js` runs against the real DB without crashing and prints a complete report.
- [ ] The milestone 4 pass/fail verdict is reported to the user with real numbers, not just "done."
