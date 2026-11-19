# Hourly Scheduler (Milestone 5, Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the hourly cycle that keeps the candle store current, computes the regime, opens/closes paper positions through the exact same engine code the backtest uses, persists state, and wires it to run every hour — plus the systemd unit to run it as a Pi service. **Starting** that service is a separate, explicit step at the end, not bundled into "build the code."

**Architecture:** Two small refactors first (Tasks 1-2) pull the setup registry and the risk/guardrail config out of `backtest/run.js` into shared `src/engine/` modules — without this, the live cycle would need its own copy of "which setups exist" and "what the guardrail numbers are," and a future edit to one copy but not the other would silently make live and backtest disagree, which is exactly what `CLAUDE.md`'s "backtest and live run identical engine code" rule exists to prevent. `src/scheduler/cycle.js`'s `runCycle` is the live analog of `backtest/run.js`'s per-step loop body — same `ingestAllCoins` → regime → position-management → entry logic, but reading/writing persisted state via Part A's `scheduler_state`/`trades`/`cycle_log` tables instead of an in-memory object, and catching its own errors into `cycle_log` so one bad hour doesn't crash the process. `scheduler.js` (a new root-level file — **not** `server.js`, see Interpretation decisions) is the thin `node-cron` wrapper that calls it hourly.

**Tech Stack:** Node.js 20, `better-sqlite3`, `node-cron` (already a dependency), `node --test`.

**Spec:** `docs/v2-design.md` §§5 (hourly cycle), 5.4 (guardrails), 7 (database), 8.4 (paper mode default balance £1000), 10 (milestone 5 row); `CLAUDE.md`'s "backtest and live run identical engine code," "every trade tagged paper or live," "a broken step must never open a trade."

**Depends on:** `docs/superpowers/plans/2026-11-19-live-ingestion-persistence.md` (Part A — `ingestCoin`/`ingestAllCoins`, the three new tables, `tryOpenPosition`/`closePosition` in `broker/paper.js`), already merged.

## Global Constraints

- Completed candles only; one exit order per position; every trade/state row tagged `mode`.
- "Runs at every 1h candle close, about 30 seconds after the hour" (design §5) — the cron schedule is `30 0 * * * *` (second 30, minute 0, every hour).
- Setup entries only evaluated on a 4h boundary (00/04/08/12/16/20 UTC) — position management (checking exits) still happens every hour.
- Paper starting balance default: £1,000 (design §8.4).
- No ORM — `better-sqlite3` prepared statements only (already satisfied by Part A's `db.js` functions this plan reuses).

## Interpretation decisions

- **The new scheduler entrypoint is `scheduler.js` at the repo root, not `server.js`.** Design §3's target layout shows `server.js` as "Express API + scheduler" combined — but that's the *end state*, after milestone 7 builds the dashboard/API that actually replaces what v1's `server.js` does. V1's `server.js` still exists at the repo root right now and, per `CLAUDE.md`, stays until its v2 equivalent exists — milestone 5 doesn't build dashboard/API parity, so creating a file named `server.js` now would silently overwrite v1's file without having actually replaced its functionality. The scheduler becomes part of `server.js` once milestone 7 is ready to retire v1's file for real.
- **`runCycle` catches its own errors and always writes a `cycle_log` row**, returning `{ error }` instead of throwing. This matches design's own `cycle_log` table (`errors` column) and the "a broken step must never open a trade" principle — a thrown exception from, say, a Kraken API hiccup should produce a logged, diagnosable failed cycle, not crash the whole scheduler process for the day.
- **The daily-loss-limit check uses the balance *at the start of today*, not a hardcoded starting balance.** The backtest's final review flagged this as a latent issue there (fixed balance, fine for a short backtest) and explicitly deferred fixing it until something needed live parity — this is that something. `balanceAtDayStart = state.balance - state.dailyPnl` is correct because `dailyPnl` only accumulates realized P&L from today's closes.
- **Regime is computed from full history every cycle** (same as the backtest), and the cycle uses whichever regime point's `ts` is the latest one `<= nowHour` — reusing `computeRegimeSeries` unmodified, satisfying "identical engine code," rather than trying to cheaply compute just the newest point.
- **Market data comes from REST polling (`ingestAllCoins`), not the WebSocket client.** Design §5 describes the cycle in exactly these polling terms ("runs... about 30 seconds after the hour"); a persistent WS connection buys nothing for an hourly trigger and adds reconnect-handling surface this milestone doesn't need.

## Review Focus

- `runCycle` must never save a partially-updated `scheduler_state` if an earlier step in the same cycle throws — the `try`/`catch` must wrap the whole state-mutating sequence, not just the ingestion call, or a mid-cycle crash could persist positions opened but never fee-charged, or vice versa.
- Setup entries must only fire exactly on a 4h boundary — a cycle running at, say, 14:00:30 UTC (not a 4h mark) must still manage exits but must not evaluate any setup's `evaluate()` at all.
- The daily P&L reset must trigger on the UTC day actually changing, not on every cycle — and the weekly kill switch must never reset, matching Part A's already-tested predicates (this plan just has to wire them correctly, not re-prove them).
- `state.closedTrades` must be drained into the permanent `trades` table and emptied every cycle — if a bug left trades accumulating in the JSON blob instead, `scheduler_state` would grow without bound and historical trades would live somewhere `getTrades` can never see them.
- Extracting the setup registry and risk config into shared modules (Tasks 1-2) must not change the backtest's behavior at all — the existing milestone 4 backtest tests (including the real-data run) are the regression proof, and they must still pass unchanged.

---

## Task 1: Extract the setup registry into `engine/playbook/index.js`

**Files:**
- Create: `src/engine/playbook/index.js`
- Modify: `src/backtest/run.js`
- Test: `test/engine-playbook-index.test.js`

**Interfaces:**
- Produces: `SETUPS` (`{ [setupName]: { evaluate } }`, all four playbook modules) and `SETUPS_BY_REGIME` (`{ [regimeLabel]: setupName[] }`) from `src/engine/playbook/index.js`.
- Consumed by: `backtest/run.js` (this task) and Task 4's `runCycle`.

- [ ] **Step 1: Write the failing tests**

Create `test/engine-playbook-index.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SETUPS, SETUPS_BY_REGIME } = require('../src/engine/playbook');

test('SETUPS contains all four setups, each with an evaluate function', () => {
  assert.deepEqual(Object.keys(SETUPS).sort(), ['oversold_bounce', 'range_reversion', 'trend_breakout', 'trend_pullback']);
  for (const setup of Object.values(SETUPS)) assert.equal(typeof setup.evaluate, 'function');
});

test('every setup named in SETUPS_BY_REGIME exists in SETUPS', () => {
  for (const names of Object.values(SETUPS_BY_REGIME)) {
    for (const name of names) assert.ok(SETUPS[name], `${name} referenced in SETUPS_BY_REGIME but missing from SETUPS`);
  }
});

test('risk_off allows no setups; trend_up allows exactly the two trend setups', () => {
  assert.deepEqual(SETUPS_BY_REGIME.risk_off, []);
  assert.deepEqual(SETUPS_BY_REGIME.trend_up.sort(), ['trend_breakout', 'trend_pullback']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-playbook-index.test.js`
Expected: FAIL — `Cannot find module '../src/engine/playbook'`

- [ ] **Step 3: Implement and refactor**

Create `src/engine/playbook/index.js`:

```js
'use strict';
const trendBreakout = require('./trendBreakout');
const trendPullback = require('./trendPullback');
const rangeReversion = require('./rangeReversion');
const oversoldBounce = require('./oversoldBounce');

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

module.exports = { SETUPS, SETUPS_BY_REGIME };
```

In `src/backtest/run.js`, remove these four lines:

```js
const trendBreakout = require('../engine/playbook/trendBreakout');
const trendPullback = require('../engine/playbook/trendPullback');
const rangeReversion = require('../engine/playbook/rangeReversion');
const oversoldBounce = require('../engine/playbook/oversoldBounce');
```

and this block:

```js
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
```

replacing both with a single line added to the top import group:

```js
const { SETUPS, SETUPS_BY_REGIME } = require('../engine/playbook');
```

- [ ] **Step 4: Run to verify everything passes**

Run: `node --test test/engine-playbook-index.test.js test/backtest-run.test.js`
Expected: PASS (all tests — the 3 new ones, plus `backtest-run.test.js` unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/index.js src/backtest/run.js test/engine-playbook-index.test.js
git commit -m "refactor(engine): extract setup registry for sharing between backtest and live"
```

---

## Task 2: Extract shared config into `engine/config.js`

**Files:**
- Create: `src/engine/config.js`
- Modify: `src/backtest/run.js`
- Test: `test/engine-config.test.js`

**Interfaces:**
- Produces: `DEFAULT_RISK_CONFIG` (the guardrail/fee/risk object, same values `backtest/run.js`'s `CONFIG` already has), `COIN_ALTNAMES` (`{ [coin]: krakenAltname }`, the 6-coin mapping confirmed live in milestone 1), `COINS` (`Object.keys(COIN_ALTNAMES)`), all from `src/engine/config.js`.
- Consumed by: `backtest/run.js` (this task) and Task 4's `runCycle` (needs `COIN_ALTNAMES` for `ingestAllCoins`, which `backtest/run.js` never did).

- [ ] **Step 1: Write the failing tests**

Create `test/engine-config.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS } = require('../src/engine/config');

test('DEFAULT_RISK_CONFIG matches design spec §5.4 values', () => {
  assert.equal(DEFAULT_RISK_CONFIG.baseRiskPct, 0.005);
  assert.equal(DEFAULT_RISK_CONFIG.maxOpenPositions, 3);
  assert.equal(DEFAULT_RISK_CONFIG.maxTotalRiskPct, 0.015);
  assert.equal(DEFAULT_RISK_CONFIG.maxCoinExposurePct, 0.20);
  assert.equal(DEFAULT_RISK_CONFIG.maxTotalExposurePct, 0.60);
  assert.equal(DEFAULT_RISK_CONFIG.cooldownHours, 6);
  assert.equal(DEFAULT_RISK_CONFIG.dailyLossLimitPct, 0.03);
  assert.equal(DEFAULT_RISK_CONFIG.weeklyKillSwitchPct, 0.08);
});

test('COIN_ALTNAMES has the 6 watchlist coins with their confirmed Kraken altnames', () => {
  assert.deepEqual(COIN_ALTNAMES, {
    BTC: 'XBTGBP', ETH: 'ETHGBP', SOL: 'SOLGBP', XRP: 'XRPGBP', ADA: 'ADAGBP', LINK: 'LINKGBP',
  });
});

test('COINS is derived from COIN_ALTNAMES and matches the backtest\'s coin list', () => {
  assert.deepEqual(COINS.sort(), ['ADA', 'BTC', 'ETH', 'LINK', 'SOL', 'XRP']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-config.test.js`
Expected: FAIL — `Cannot find module '../src/engine/config'`

- [ ] **Step 3: Implement and refactor**

Create `src/engine/config.js`:

```js
'use strict';

const DEFAULT_RISK_CONFIG = {
  baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
  maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6,
  dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08,
  roundTripFeePct: 0.65, // percent, matches checkFeeViability's expected units
};

const COIN_ALTNAMES = { BTC: 'XBTGBP', ETH: 'ETHGBP', SOL: 'SOLGBP', XRP: 'XRPGBP', ADA: 'ADAGBP', LINK: 'LINKGBP' };
const COINS = Object.keys(COIN_ALTNAMES);

module.exports = { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS };
```

In `src/backtest/run.js`, remove:

```js
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'LINK'];
```

and the `CONFIG` object:

```js
const CONFIG = {
  baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
  maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6,
  dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08,
  roundTripFeePct: 0.65, // percent, matches checkFeeViability's expected units
};
```

Add to the top import group:

```js
const { DEFAULT_RISK_CONFIG, COINS } = require('../engine/config');
```

Then change `runBacktest`'s signature from `function runBacktest(db, config = CONFIG, fromTs = 0)` to `function runBacktest(db, config = DEFAULT_RISK_CONFIG, fromTs = 0)`.

- [ ] **Step 4: Run to verify everything passes**

Run: `node --test test/engine-config.test.js test/backtest-run.test.js`
Expected: PASS (all tests, `backtest-run.test.js` unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/engine/config.js src/backtest/run.js test/engine-config.test.js
git commit -m "refactor(engine): extract shared risk config and coin/altname map"
```

---

## Task 3: `scheduler/cycle.js` — pure boundary helpers

**Files:**
- Create: `src/scheduler/cycle.js`
- Test: `test/scheduler-cycle.test.js`

**Interfaces:**
- Produces: `isFourHourBoundary(tsSeconds)` → `boolean` (`true` iff `tsSeconds % 14400 === 0`). `utcDayKey(tsSeconds)` → integer day number (`Math.floor(tsSeconds / 86400)`). `freshState(startingBalance = 1000)` → a new scheduler state object matching the shape `tryOpenPosition`/`closePosition`/`evaluateExit` expect (`{ balance, dailyPnl, currentDay: null, weeklyPeakBalance, killSwitchActive: false, openPositions: [], cooldowns: {}, closedTrades: [] }`).
- Consumed by: Task 4's `runCycle` (in the same file).

- [ ] **Step 1: Write the failing tests**

Create `test/scheduler-cycle.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFourHourBoundary, utcDayKey, freshState } = require('../src/scheduler/cycle');

test('isFourHourBoundary is true exactly at 00/04/08/12/16/20 UTC', () => {
  const HOUR = 3600;
  assert.equal(isFourHourBoundary(0), true);
  assert.equal(isFourHourBoundary(4 * HOUR), true);
  assert.equal(isFourHourBoundary(20 * HOUR), true);
  assert.equal(isFourHourBoundary(24 * HOUR), true); // next day's 00:00
});

test('isFourHourBoundary is false at any other hour', () => {
  const HOUR = 3600;
  assert.equal(isFourHourBoundary(1 * HOUR), false);
  assert.equal(isFourHourBoundary(14 * HOUR), false);
});

test('utcDayKey groups all timestamps within the same UTC day', () => {
  const DAY = 86400;
  assert.equal(utcDayKey(0), 0);
  assert.equal(utcDayKey(DAY - 1), 0);
  assert.equal(utcDayKey(DAY), 1);
});

test('freshState defaults to a £1000 starting balance with no open positions', () => {
  const state = freshState();
  assert.equal(state.balance, 1000);
  assert.equal(state.weeklyPeakBalance, 1000);
  assert.deepEqual(state.openPositions, []);
  assert.deepEqual(state.cooldowns, {});
  assert.equal(state.killSwitchActive, false);
});

test('freshState accepts a custom starting balance', () => {
  assert.equal(freshState(500).balance, 500);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/scheduler-cycle.test.js`
Expected: FAIL — `Cannot find module '../src/scheduler/cycle'`

- [ ] **Step 3: Implement**

Create `src/scheduler/cycle.js`:

```js
'use strict';

const HOUR = 3600, FOUR_H = 4 * HOUR, DAY = 24 * HOUR;

function isFourHourBoundary(tsSeconds) {
  return tsSeconds % FOUR_H === 0;
}

function utcDayKey(tsSeconds) {
  return Math.floor(tsSeconds / DAY);
}

function freshState(startingBalance = 1000) {
  return {
    balance: startingBalance, dailyPnl: 0, currentDay: null,
    weeklyPeakBalance: startingBalance, killSwitchActive: false,
    openPositions: [], cooldowns: {}, closedTrades: [],
  };
}

module.exports = { isFourHourBoundary, utcDayKey, freshState };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/scheduler-cycle.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/cycle.js test/scheduler-cycle.test.js
git commit -m "feat(scheduler): add pure 4h-boundary and UTC-day helpers"
```

---

## Task 4: `scheduler/cycle.js` — `runCycle`

**Files:**
- Modify: `src/scheduler/cycle.js`

**Interfaces:**
- Produces: `runCycle(db, krakenClient, mode, config = DEFAULT_RISK_CONFIG, now = Date.now())` → `Promise<{ regimeLabel, candidatesCount, openedCount, closedCount } | { error }>`. Never throws — every failure is caught, written to `cycle_log` with the error message, and returned as `{ error }`.
- Consumes: `ingestAllCoins` (Part A), `computeRegimeSeries` (milestone 3), `isDailyLossLimitHit`/`isKillSwitchTriggered` (milestone 4 Part A), `buildCoinData` (milestone 4 Part B, exported from `backtest/run.js`), `SETUPS`/`SETUPS_BY_REGIME` (Task 1), `DEFAULT_RISK_CONFIG`/`COIN_ALTNAMES`/`COINS` (Task 2), `evaluateExit`/`tryOpenPosition`/`closePosition` (`broker/paper.js`), `getCandles`/`loadSchedulerState`/`saveSchedulerState`/`insertTrade`/`insertCycleLog` (Part A's `data/db.js`).
- Not unit-tested with a synthetic fixture — this is the orchestration layer, and a realistic regime-eligible fixture would need 220+ days of 6-coin OHLC data to even produce a non-null regime label (the same reason `scripts/compute-regime-history.js` and `backtest/run.js`'s `runBacktest`/`main` were proven by a real run rather than a synthetic test). Step 2 below is that real run, against the actual DB and the actual (public, read-only) Kraken API, in paper mode — safe: no secrets, no real orders, no real money.

- [ ] **Step 1: Write the implementation**

In `src/scheduler/cycle.js`, add after `freshState` (before `module.exports`):

```js
const { getCandles, loadSchedulerState, saveSchedulerState, insertTrade, insertCycleLog } = require('../data/db');
const { ingestAllCoins } = require('../data/ingest');
const { computeRegimeSeries } = require('../engine/regime');
const { isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
const { buildCoinData } = require('../backtest/run');
const { SETUPS, SETUPS_BY_REGIME } = require('../engine/playbook');
const { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS } = require('../engine/config');
const { evaluateExit, tryOpenPosition, closePosition } = require('../broker/paper');

async function runCycle(db, krakenClient, mode, config = DEFAULT_RISK_CONFIG, now = Date.now()) {
  const startedAt = Date.now();
  const nowHour = Math.floor(now / 1000 / HOUR) * HOUR;
  let regimeLabel = null, candidatesCount = 0, openedCount = 0, closedCount = 0;

  try {
    await ingestAllCoins(db, krakenClient, COIN_ALTNAMES, now);

    const btcDaily = getCandles(db, 'BTC', '1d', 0, nowHour);
    const btc4h = getCandles(db, 'BTC', '4h', 0, nowHour);
    const watchlistBy4h = {};
    const coinData = {};
    for (const coin of COINS) {
      const candles4h = getCandles(db, coin, '4h', 0, nowHour);
      watchlistBy4h[coin] = candles4h.map((c) => ({ ts: c.ts, close: c.close }));
      coinData[coin] = buildCoinData({
        candles4h,
        candles1h: getCandles(db, coin, '1h', 0, nowHour + FOUR_H),
        candlesDaily: getCandles(db, coin, '1d', 0, nowHour),
      });
    }

    const regimeSeries = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
    const currentRegime = [...regimeSeries].reverse().find((r) => r.ts <= nowHour);
    regimeLabel = currentRegime ? currentRegime.label : null;

    const state = loadSchedulerState(db, mode) || freshState();
    const dayKey = utcDayKey(nowHour);
    if (state.currentDay !== dayKey) {
      state.currentDay = dayKey;
      state.dailyPnl = 0;
    }

    for (const position of [...state.openPositions]) {
      const data = coinData[position.coin];
      const candles1hSlice = data.candles1h.filter((c) => c.ts > position.entryTs && c.ts <= nowHour);
      const exit = evaluateExit(position, { candles1h: candles1hSlice, ema20By4hTs: data.ema20By4hTs });
      if (exit) {
        closePosition(state, position, exit, config);
        closedCount += 1;
      }
    }

    state.weeklyPeakBalance = Math.max(state.weeklyPeakBalance, state.balance);
    const weeklyDrawdownPct = (state.weeklyPeakBalance - state.balance) / state.weeklyPeakBalance;
    if (isKillSwitchTriggered(weeklyDrawdownPct, config)) state.killSwitchActive = true;
    const balanceAtDayStart = state.balance - state.dailyPnl;
    const dailyLossHit = isDailyLossLimitHit(state.dailyPnl / balanceAtDayStart, config);

    if (regimeLabel && isFourHourBoundary(nowHour) && !state.killSwitchActive && !dailyLossHit && regimeLabel !== 'risk_off') {
      for (const coin of COINS) {
        const data = coinData[coin];
        const i = data.candles4h.findIndex((c) => c.ts === nowHour);
        if (i === -1) continue;
        for (const setupName of SETUPS_BY_REGIME[regimeLabel] || []) {
          const candidate = SETUPS[setupName].evaluate(coin, data.candles4h, data.indicators, i, regimeLabel);
          if (!candidate) continue;
          candidatesCount += 1;
          const before = state.openPositions.length;
          tryOpenPosition(state, candidate, data, i, config);
          if (state.openPositions.length > before) openedCount += 1;
        }
      }
    }

    for (const trade of state.closedTrades) {
      insertTrade(db, {
        mode, coin: trade.coin, setup: trade.setup, entryTs: trade.entryTs, exitTs: trade.exitTs,
        entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, units: trade.units,
        riskAmount: trade.riskAmount, pnl: trade.pnl, r: trade.r, exitReason: trade.exitReason,
      });
    }
    state.closedTrades = [];

    saveSchedulerState(db, mode, state);
    insertCycleLog(db, {
      ts: nowHour, mode, regimeLabel, candidatesCount, openedCount, closedCount,
      durationMs: Date.now() - startedAt,
    });

    return { regimeLabel, candidatesCount, openedCount, closedCount };
  } catch (err) {
    insertCycleLog(db, {
      ts: nowHour, mode, regimeLabel, candidatesCount, openedCount, closedCount,
      durationMs: Date.now() - startedAt, error: err.message,
    });
    return { error: err.message };
  }
}

module.exports = { isFourHourBoundary, utcDayKey, freshState, runCycle };
```

- [ ] **Step 2: Run it for real, once, against the actual DB and the actual Kraken API**

Run:

```bash
node -e "
const { openDb } = require('./src/data/db');
const { createRestClient } = require('./src/kraken/rest');
const { runCycle } = require('./src/scheduler/cycle');
(async () => {
  const db = openDb();
  const client = createRestClient({});
  const result = await runCycle(db, client, 'paper');
  console.log(JSON.stringify(result, null, 2));
})();
"
```

Expected: prints `{ regimeLabel, candidatesCount, openedCount, closedCount }` with no `error` field — a real regime label (e.g. `"range"` or `"downtrend"`, whatever the market is doing right now), and small non-negative counts. If it prints `{ "error": "..." }` instead, read the message and debug before moving on — don't treat a caught error as "it ran successfully."

- [ ] **Step 3: Confirm state actually persisted**

Run: `sqlite3 data/cryptodash-v2.db "SELECT mode, updated_ts FROM scheduler_state; SELECT * FROM cycle_log ORDER BY ts DESC LIMIT 1;"`
Expected: one `scheduler_state` row for `mode='paper'`, and the most recent `cycle_log` row matching the result from Step 2 (same `regime_label`, counts, and `error` is `NULL`).

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS (all tests, same count as before plus Task 3's 5 new ones — `runCycle` itself has no dedicated unit test, by design, per this task's Interfaces note)

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/cycle.js
git commit -m "feat(scheduler): add runCycle (ingest, regime, positions, persistence)"
```

---

## Task 5: `scheduler.js` entrypoint (cron wiring)

**Files:**
- Create: `scheduler.js` (repo root)

**Interfaces:**
- Produces: a long-running script, run as `node scheduler.js`, that schedules `runCycle` via `node-cron` at `30 0 * * * *` (every hour, 30 seconds past). Logs each cycle's result to the console. Not started as a background process by this task — Task 6 covers running it as a service, gated on explicit confirmation.

- [ ] **Step 1: Write the script**

Create `scheduler.js`:

```js
'use strict';
const cron = require('node-cron');
const { openDb } = require('./src/data/db');
const { createRestClient } = require('./src/kraken/rest');
const { runCycle } = require('./src/scheduler/cycle');

const MODE = 'paper';

const db = openDb();
const krakenClient = createRestClient({});

cron.schedule('30 0 * * * *', async () => {
  const result = await runCycle(db, krakenClient, MODE);
  console.log(`[${new Date().toISOString()}] cycle result:`, JSON.stringify(result));
});

console.log(`Scheduler started (mode=${MODE}). Waiting for the next hourly cycle (xx:00:30 UTC)...`);
```

- [ ] **Step 2: Sanity-check it loads without crashing, then stop it**

Run (in the background, for a few seconds, then stop it — this just proves the cron registration and Kraken client construction don't throw at startup; it won't actually fire a cycle unless the clock happens to hit xx:00:30 while it's running):

```bash
timeout 5 node scheduler.js
```

Expected: prints `Scheduler started (mode=paper). Waiting for the next hourly cycle (xx:00:30 UTC)...` and exits cleanly after the 5-second timeout (via `timeout`, not a crash).

- [ ] **Step 3: Commit**

```bash
git add scheduler.js
git commit -m "feat(scheduler): add cron entrypoint (hourly, xx:00:30 UTC)"
```

---

## Task 6: systemd service (created, not enabled)

**Files:**
- Create: `deploy/cryptodash-paper.service`

**Interfaces:**
- Produces: a systemd unit file. This task does **not** run `systemctl enable` or `systemctl start` — per this plan's own framing, actually starting a continuously-running process that calls the real Kraken API on a schedule is a separate, explicit confirmation step, even in paper mode.

- [ ] **Step 1: Write the unit file**

Create `deploy/cryptodash-paper.service`:

```ini
[Unit]
Description=Cryptodash v2 paper-trading scheduler
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gallus23
WorkingDirectory=/home/gallus23/crypto-dashboard
ExecStart=/usr/bin/node /home/gallus23/crypto-dashboard/scheduler.js
Restart=on-failure
RestartSec=30
EnvironmentFile=-/home/gallus23/.config/cryptodash/env

[Install]
WantedBy=multi-user.target
```

(`EnvironmentFile=-...` — the leading `-` makes it tolerant of the file not existing yet; paper-mode ingestion only hits Kraken's public endpoints, no credentials needed. The file becomes required once live mode needs the Kraken API key.)

- [ ] **Step 2: Commit**

```bash
git add deploy/cryptodash-paper.service
git commit -m "feat(deploy): add systemd unit for the paper scheduler (not enabled)"
```

- [ ] **Step 3: Stop here and ask the user before enabling it**

Tell the user the unit file is ready at `deploy/cryptodash-paper.service` and that starting it means a process will run continuously on the Pi, polling Kraken every hour indefinitely (still paper mode — no real money, no credentials needed yet). If they want it running now, the commands are:

```bash
sudo cp deploy/cryptodash-paper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cryptodash-paper.service
sudo systemctl status cryptodash-paper.service
```

Do not run these yourself without the user explicitly asking you to.

---

## Part B exit check

- [ ] `node --test test/` passes (all new scheduler/config/playbook-registry tests green, no regressions — especially the milestone 4 backtest, unchanged).
- [ ] `runCycle` has been run for real at least once (Task 4 Step 2), against the real DB and real Kraken API, with no `error` in its result.
- [ ] `scheduler_state`, `trades`, and `cycle_log` all have at least one row after that real run.
- [ ] The systemd unit exists but is **not** enabled — starting it is the user's explicit call, made separately from this plan's execution.
