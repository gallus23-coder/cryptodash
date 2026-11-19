# Live Ingestion + Persistent Scheduler State (Milestone 5, Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pieces the hourly live scheduler (Part B, a separate plan) needs but doesn't itself define: a function that keeps the candle store current from Kraken each hour, SQLite tables that let the scheduler's state (open positions, balance, guardrails, closed trades, per-cycle log) survive a process restart, and a refactor that makes `tryOpenPosition`/`closePosition` genuinely shared between the backtest and the live cycle — not two copies of the same logic.

**Architecture:** `src/data/ingest.js` is the live analog of `scripts/backfill-candles.js`'s recent-data pull, trimmed to run every hour instead of once: fetch the newest closed candles, filter outliers (reusing milestone 4's fix), store them, rebuild only the trailing window of 4h/1d (not full history — that's a one-time backfill concern, not an hourly one). `src/broker/paper.js` becomes the one place that knows how to open and close a paper position — the backtest already built this logic correctly (including the entry-fee-double-count fix from milestone 4's final review); this plan moves it there so milestone 5's live cycle imports the exact same functions instead of a second implementation that could drift. Scheduler state persists as one JSON blob per mode (paper/live) in a new `scheduler_state` table — not five new normalized tables — because nothing needs to query open positions or cooldowns relationally yet; `trades` and `cycle_log` *are* proper tables because the dashboard (milestone 7) and any manual audit will want to query those by coin/setup/time.

**Tech Stack:** Node.js 20, `better-sqlite3` (already a dependency), `node --test`. No new dependencies.

**Spec:** `docs/v2-design.md` §§4 (candle store), 7 (database — `trades`, `cycle_log`), 10 (milestone 5 row); `CLAUDE.md`'s "every trade/order/decision is tagged paper or live" and "completed candles only" rules.

## Global Constraints

- Completed candles only — ingestion must never store a forming candle (same rule as milestones 1-2).
- Every trade/state row is tagged `mode` (`'paper'` or `'live'`) — `CLAUDE.md`: "Never mix them in P&L."
- No ORM — `better-sqlite3` prepared statements only.
- `src/broker/paper.js` stays interface-compatible with how `backtest/run.js` already calls it — this plan must not break milestone 4's existing, reviewed, real-data-verified backtest.

## Interpretation decisions

- **Scheduler state is one JSON blob per mode**, not normalized tables for positions/cooldowns. Design §7 lists a fuller table set (`orders`, `cycle_snapshots`, `setups`, `benchmarks`) that spans milestones 5 through 8+ — building all of it now before anything queries it relationally would be speculative. `trades` and `cycle_log` get real tables because they're exactly what design §7 names and what the dashboard will query later.
- **Ingestion rebuilds only a 14-day trailing window of 4h/1d**, not the coin's full history, every hour — `aggregateCandles` only needs enough trailing 1h context to correctly judge the *newest* bucket's closedness (via the `nowTs` option from milestone 3's final review); re-aggregating years of history every hour would be pure waste. The one-time full-history rebuild stays `scripts/backfill-candles.js`'s job.

## Review Focus

- Ingestion must never store the forming (still-open) hourly candle, even though Kraken's response includes it — exactly the same risk the design's "completed candles only" rule exists for.
- The outlier filter (milestone 4's `filterOutlierCandles`) must run on freshly-ingested candles too, not just historical backfill — a single bad live tick would otherwise poison regime/ATR calculations in real time with nothing to catch it.
- Moving `tryOpenPosition`/`closePosition` into `broker/paper.js` must not reintroduce the entry-fee double-count bug milestone 4's final review fixed — the moved code must be the *fixed* version, and the existing regression test must still pass unchanged after the move.
- `scheduler_state`'s JSON round-trip must preserve every field exactly (especially `killSwitchActive` as a real boolean and `cooldowns` as a plain object) — a lossy serialize/deserialize would silently reset guardrails on every scheduler restart.
- `insertTrade`/`getTrades` and the rest of the new DB surface must filter by `mode` — a query that forgets the `WHERE mode = ?` clause would blend paper and live P&L, the exact mixing `CLAUDE.md` forbids.

---

## Task 1: `data/ingest.js` — live candle ingestion

**Files:**
- Create: `src/data/ingest.js`
- Test: `test/data-ingest.test.js`

**Interfaces:**
- Produces: `ingestCoin(db, krakenClient, coin, altname, now = Date.now())` → `Promise<{ coin, inserted, dropped, built4h, built1d }>`. `krakenClient` only needs a `getOhlc(altname, { interval })` method matching `src/kraken/rest.js`'s real client's shape (`{ candles: [{ time, open, high, low, close, volume, count, closed }], last }`) — tests pass a plain fake object, the live scheduler (Part B) passes the real `createRestClient(...)`. `ingestAllCoins(db, krakenClient, coinMap, now = Date.now())` → `Promise<Array<result>>`, `coinMap` is `{ [coin]: altname }`.
- Consumed by: Part B's hourly cycle.

- [ ] **Step 1: Write the failing tests**

Create `test/data-ingest.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, upsertCandles, getCandles } = require('../src/data/db');
const { ingestCoin } = require('../src/data/ingest');

function seedOneDayOfHourlyCandles(db, coin) {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    coin, timeframe: '1h', ts: i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 1, trades: 1,
  }));
  upsertCandles(db, rows);
}

test('ingestCoin stores new closed candles, excludes the forming one, and rebuilds closed 4h/1d from the trailing window', async () => {
  const db = openDb(':memory:');
  seedOneDayOfHourlyCandles(db, 'BTC');

  const fakeClient = {
    getOhlc: async () => ({
      candles: [
        { time: 86400, open: 100, high: 101, low: 99, close: 100, volume: 1, count: 1, closed: true },
        { time: 90000, open: 100, high: 500, low: 99, close: 100, volume: 1, count: 1, closed: false },
      ],
      last: 86400,
    }),
  };

  const result = await ingestCoin(db, fakeClient, 'BTC', 'XBTGBP', 90000 * 1000);

  assert.equal(result.inserted, 1); // only the closed candle
  assert.equal(result.dropped, 0);
  assert.equal(result.built4h, 6); // day 1's six 4h buckets, all closed by nowTs=90000
  assert.equal(result.built1d, 1); // day 1's one daily bucket

  const stored1h = getCandles(db, 'BTC', '1h', 0, 100000);
  assert.equal(stored1h.length, 25); // 24 seeded + 1 newly ingested
  assert.equal(stored1h.some((c) => c.ts === 90000), false); // forming candle never stored
});

test('ingestCoin drops an outlier candle before storing it', async () => {
  const db = openDb(':memory:');
  const fakeClient = {
    getOhlc: async () => ({
      candles: [
        { time: 0, open: 9300, high: 13000, low: 4.1, close: 4.1, volume: 20, count: 1, closed: true }, // outlier
        { time: 3600, open: 100, high: 101, low: 99, close: 100, volume: 1, count: 1, closed: true },
      ],
      last: 3600,
    }),
  };

  const result = await ingestCoin(db, fakeClient, 'BTC', 'XBTGBP', 7200 * 1000);

  assert.equal(result.inserted, 1);
  assert.equal(result.dropped, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-ingest.test.js`
Expected: FAIL — `Cannot find module '../src/data/ingest'`

- [ ] **Step 3: Implement**

Create `src/data/ingest.js`:

```js
'use strict';
const { upsertCandles, getCandles } = require('./db');
const { filterOutlierCandles, aggregateCandles } = require('./candles');

const HOUR = 3600, FOUR_H = 4 * HOUR, DAY = 24 * HOUR;
const REBUILD_WINDOW_SECONDS = 14 * DAY;

async function ingestCoin(db, krakenClient, coin, altname, now = Date.now()) {
  const { candles } = await krakenClient.getOhlc(altname, { interval: 60 });
  const closedRows = candles.filter((c) => c.closed).map((c) => ({
    ts: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, trades: c.count,
  }));
  const { candles: clean, dropped } = filterOutlierCandles(closedRows);
  const inserted = upsertCandles(db, clean.map((c) => ({ coin, timeframe: '1h', ...c })));

  const nowHour = Math.floor(now / 1000 / HOUR) * HOUR;
  const rebuildFrom = nowHour - REBUILD_WINDOW_SECONDS;
  const hourly = getCandles(db, coin, '1h', rebuildFrom, nowHour);

  const fourHourRows = aggregateCandles(hourly, FOUR_H, { nowTs: nowHour }).filter((c) => c.closed);
  const built4h = upsertCandles(db, fourHourRows.map((c) => ({ coin, timeframe: '4h', ...c })));
  const dailyRows = aggregateCandles(hourly, DAY, { nowTs: nowHour }).filter((c) => c.closed);
  const built1d = upsertCandles(db, dailyRows.map((c) => ({ coin, timeframe: '1d', ...c })));

  return { coin, inserted, dropped, built4h, built1d };
}

async function ingestAllCoins(db, krakenClient, coinMap, now = Date.now()) {
  const results = [];
  for (const [coin, altname] of Object.entries(coinMap)) {
    results.push(await ingestCoin(db, krakenClient, coin, altname, now));
  }
  return results;
}

module.exports = { ingestCoin, ingestAllCoins };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-ingest.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/data/ingest.js test/data-ingest.test.js
git commit -m "feat(data): add live candle ingestion (hourly pull, outlier filter, trailing rebuild)"
```

---

## Task 2: `data/db.js` — `trades`, `scheduler_state`, `cycle_log` tables

**Files:**
- Modify: `src/data/db.js`
- Test: `test/data-db.test.js` (append)

**Interfaces:**
- Produces: `insertTrade(db, trade)` where `trade = { mode, coin, setup, entryTs, exitTs, entryPrice, exitPrice, units, riskAmount, pnl, r, exitReason }`. `getTrades(db, mode)` → array ordered by `exitTs` ascending. `saveSchedulerState(db, mode, state)` (upserts, `state` is any JSON-serializable object). `loadSchedulerState(db, mode)` → the object, or `null` if never saved. `insertCycleLog(db, row)` where `row = { ts, mode, regimeLabel, candidatesCount, openedCount, closedCount, durationMs, error? }` (`error` defaults to `null`). `getCycleLog(db, mode, limit = 50)` → array ordered by `ts` descending.
- Consumed by: Part B's hourly cycle (persists state every run, logs every run, records every closed trade).

- [ ] **Step 1: Write the failing tests**

Append to `test/data-db.test.js`:

```js
const { insertTrade, getTrades, saveSchedulerState, loadSchedulerState, insertCycleLog, getCycleLog } = require('../src/data/db');

test('insertTrade/getTrades round-trips a closed trade, filtered by mode', () => {
  const db = openDb(':memory:');
  insertTrade(db, {
    mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 1000, exitTs: 2000,
    entryPrice: 100, exitPrice: 105, units: 1, riskAmount: 10, pnl: 5, r: 0.5, exitReason: 'stop',
  });
  insertTrade(db, {
    mode: 'live', coin: 'ETH', setup: 'range_reversion', entryTs: 1500, exitTs: 2500,
    entryPrice: 50, exitPrice: 48, units: 2, riskAmount: 8, pnl: -4, r: -0.5, exitReason: 'target',
  });

  const paperTrades = getTrades(db, 'paper');

  assert.equal(paperTrades.length, 1);
  assert.equal(paperTrades[0].coin, 'BTC');
  assert.equal(paperTrades[0].r, 0.5);
});

test('getTrades orders by exitTs ascending', () => {
  const db = openDb(':memory:');
  insertTrade(db, { mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 1, exitTs: 300, entryPrice: 1, exitPrice: 1, units: 1, riskAmount: 1, pnl: 0, r: 0, exitReason: 'stop' });
  insertTrade(db, { mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 1, exitTs: 100, entryPrice: 1, exitPrice: 1, units: 1, riskAmount: 1, pnl: 0, r: 0, exitReason: 'stop' });

  assert.deepEqual(getTrades(db, 'paper').map((t) => t.exitTs), [100, 300]);
});

test('saveSchedulerState/loadSchedulerState round-trips the full state shape, per mode', () => {
  const db = openDb(':memory:');
  const state = {
    balance: 987.65, dailyPnl: -12.3, currentDay: 20261, weeklyPeakBalance: 1000,
    killSwitchActive: false, openPositions: [{ coin: 'BTC', entryPrice: 100 }], cooldowns: { ETH: 123456 },
  };

  saveSchedulerState(db, 'paper', state);

  assert.deepEqual(loadSchedulerState(db, 'paper'), state);
  assert.equal(loadSchedulerState(db, 'live'), null); // different mode, never saved
});

test('saveSchedulerState overwrites the previous state for the same mode', () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'paper', { balance: 1000 });
  saveSchedulerState(db, 'paper', { balance: 950 });

  assert.deepEqual(loadSchedulerState(db, 'paper'), { balance: 950 });
});

test('insertCycleLog/getCycleLog round-trips and orders by ts descending', () => {
  const db = openDb(':memory:');
  insertCycleLog(db, { ts: 100, mode: 'paper', regimeLabel: 'range', candidatesCount: 2, openedCount: 1, closedCount: 0, durationMs: 50 });
  insertCycleLog(db, { ts: 200, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 0, openedCount: 0, closedCount: 1, durationMs: 40 });

  const rows = getCycleLog(db, 'paper', 10);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.ts), [200, 100]);
  assert.equal(rows[0].regime_label, 'trend_up');
  assert.equal(rows[0].error, null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-db.test.js`
Expected: FAIL — `insertTrade is not a function`

- [ ] **Step 3: Implement**

In `src/data/db.js`, add the three `CREATE TABLE` statements inside `openDb`'s existing `db.exec(...)` call (append after the `candles` table definition, inside the same template string):

```sql
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL, coin TEXT NOT NULL, setup TEXT NOT NULL,
    entry_ts INTEGER NOT NULL, exit_ts INTEGER NOT NULL,
    entry_price REAL NOT NULL, exit_price REAL NOT NULL,
    units REAL NOT NULL, risk_amount REAL NOT NULL,
    pnl REAL NOT NULL, r REAL NOT NULL, exit_reason TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scheduler_state (
    mode TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cycle_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, mode TEXT NOT NULL, regime_label TEXT,
    candidates_count INTEGER NOT NULL, opened_count INTEGER NOT NULL, closed_count INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL, error TEXT
  );
```

Then add these functions before `module.exports`:

```js
function insertTrade(db, trade) {
  db.prepare(`
    INSERT INTO trades (mode, coin, setup, entry_ts, exit_ts, entry_price, exit_price, units, risk_amount, pnl, r, exit_reason)
    VALUES (@mode, @coin, @setup, @entryTs, @exitTs, @entryPrice, @exitPrice, @units, @riskAmount, @pnl, @r, @exitReason)
  `).run(trade);
}

function getTrades(db, mode) {
  return db.prepare('SELECT * FROM trades WHERE mode = ? ORDER BY exit_ts ASC').all(mode);
}

function saveSchedulerState(db, mode, state) {
  db.prepare(`
    INSERT INTO scheduler_state (mode, state_json, updated_ts) VALUES (@mode, @stateJson, @updatedTs)
    ON CONFLICT(mode) DO UPDATE SET state_json = excluded.state_json, updated_ts = excluded.updated_ts
  `).run({ mode, stateJson: JSON.stringify(state), updatedTs: Date.now() });
}

function loadSchedulerState(db, mode) {
  const row = db.prepare('SELECT state_json FROM scheduler_state WHERE mode = ?').get(mode);
  return row ? JSON.parse(row.state_json) : null;
}

function insertCycleLog(db, row) {
  db.prepare(`
    INSERT INTO cycle_log (ts, mode, regime_label, candidates_count, opened_count, closed_count, duration_ms, error)
    VALUES (@ts, @mode, @regimeLabel, @candidatesCount, @openedCount, @closedCount, @durationMs, @error)
  `).run({ error: null, ...row });
}

function getCycleLog(db, mode, limit = 50) {
  return db.prepare('SELECT * FROM cycle_log WHERE mode = ? ORDER BY ts DESC LIMIT ?').all(mode, limit);
}
```

Update the final `module.exports` to add `insertTrade, getTrades, saveSchedulerState, loadSchedulerState, insertCycleLog, getCycleLog`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-db.test.js`
Expected: PASS (all tests — 5 new plus the existing 5)

- [ ] **Step 5: Commit**

```bash
git add src/data/db.js test/data-db.test.js
git commit -m "feat(data): add trades, scheduler_state, and cycle_log tables"
```

---

## Task 3: Move `tryOpenPosition`/`closePosition` into `broker/paper.js`

**Files:**
- Modify: `src/broker/paper.js`
- Modify: `src/backtest/run.js`
- Test: `test/broker-paper.test.js` (append)

**Interfaces:**
- Produces: `broker/paper.js` now also exports `tryOpenPosition(state, candidate, data, i, config)` and `closePosition(state, position, exit, config)` — the exact same behavior `backtest/run.js` already has (including the entry-fee fix from milestone 4's final review), just relocated so the live cycle (Part B) can import the identical functions instead of a second copy.
- Consumes: `sizePosition`/`checkFeeViability`/`checkGuardrails` (`src/engine/risk.js`, already a dependency of the code being moved).
- `backtest/run.js` keeps its existing exports (`buildCoinData`, `runBacktest`, `printReport`, `tryOpenPosition`, `closePosition`) unchanged from the outside — it now re-exports the two moved functions from `paper.js` instead of defining them, so nothing that already imports from `backtest/run.js` (including `test/backtest-run.test.js`) needs to change.

- [ ] **Step 1: Write the failing test**

Append to `test/broker-paper.test.js`:

```js
const { tryOpenPosition: tryOpenPositionFromPaper } = require('../src/broker/paper');

test('tryOpenPosition and closePosition live in broker/paper.js directly (not just re-exported from backtest/run.js)', () => {
  assert.equal(typeof tryOpenPositionFromPaper, 'function');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/broker-paper.test.js`
Expected: FAIL — `tryOpenPositionFromPaper` is `undefined`, so `typeof` is `'undefined'` not `'function'`

- [ ] **Step 3: Move the functions**

In `src/backtest/run.js`, cut these two function definitions (they currently sit between `SETUPS_BY_REGIME` and `function runBacktest`):

```js
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
  // Don't deduct the entry fee from balance here — closePosition's pnl already
  // subtracts position.entryFee once when the trade realizes. Deducting it here
  // too double-counted it.
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
```

(That comment above `state.openPositions.push(position)` is already in the current file — carry it over, it's still the right explanation at the new location.) Paste the two functions into `src/broker/paper.js` (after `evaluateExit`, before `module.exports`), with these two changes: add `const { sizePosition, checkFeeViability, checkGuardrails } = require('../engine/risk');` near the top of `paper.js`, and in `closePosition`, replace `const r = computeTradeR(pnl, position.riskAmount);` with `const r = pnl / position.riskAmount;` (inlined — `paper.js` has no reason to depend on `backtest/stats.js` for one division).

Update `paper.js`'s `module.exports` to:

```js
module.exports = { fillEntry, fillExit, evaluateExit, tryOpenPosition, closePosition, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT };
```

In `src/backtest/run.js`: delete the two function bodies you just moved. `fillEntry`, `fillExit`, `sizePosition`, `checkFeeViability`, `checkGuardrails`, and `computeTradeR` were only ever used inside those two functions — after deleting them, none of those six names are referenced anywhere else in `run.js` (`runBacktest` still calls `evaluateExit` directly at its position-management step, and still calls `isDailyLossLimitHit`/`isKillSwitchTriggered` directly for the guardrail checks — keep those). Change the two import lines from:

```js
const { sizePosition, checkFeeViability, checkGuardrails, isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
```
```js
const { fillEntry, fillExit, evaluateExit } = require('../broker/paper');
```
```js
const { computeTradeR, computeExpectancy, computeDrawdown } = require('./stats');
```

to:

```js
const { isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
```
```js
const { evaluateExit, tryOpenPosition, closePosition } = require('../broker/paper');
```
```js
const { computeExpectancy, computeDrawdown } = require('./stats');
```

Leave `module.exports` in `run.js` exactly as-is (`{ buildCoinData, runBacktest, printReport, tryOpenPosition, closePosition }`) — it now forwards the imported names instead of local ones.

- [ ] **Step 4: Run to verify everything passes — both the new test and the full existing suite**

Run: `node --test test/`
Expected: PASS (every test, including `test/backtest-run.test.js`'s entry-fee regression test, unchanged — proving the move didn't alter behavior)

- [ ] **Step 5: Commit**

```bash
git add src/broker/paper.js src/backtest/run.js test/broker-paper.test.js
git commit -m "refactor(broker): move tryOpenPosition/closePosition into paper.js for live reuse"
```

---

## Part A exit check

- [ ] `node --test test/` passes (all new ingest/db/broker tests green, no regressions — especially the milestone 4 backtest tests, unchanged).
- [ ] `tryOpenPosition`/`closePosition` have exactly one implementation (`src/broker/paper.js`), not two.

**Next:** Part B (separate plan) builds the hourly cycle orchestrator that calls `ingestCoin`, computes regime, opens/closes positions via this plan's shared broker functions, persists state via `scheduler_state`/`trades`/`cycle_log`, and wires it to run hourly — plus the systemd service file. Actually **starting** that service is a separate, explicit confirmation step (continuously running, hitting the real Kraken API on a schedule, even in paper mode) — not something to switch on as part of writing the code.
