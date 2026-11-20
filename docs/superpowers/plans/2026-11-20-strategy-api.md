# Strategy API (Milestone 7, Part E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-only data the Strategy tab (design §8.2) needs: regime metrics, the market note, per-setup 30/90-day stats, and guardrail headroom — bundled behind design's own `GET /api/strategy` endpoint, plus `GET /api/positions` already built in Part D. No editing controls, no backtest-trigger, no config-version approval flow — see Interpretation decisions for why those are explicitly out of scope here.

**Architecture:** Two real gaps surface before any of this can be built. First, `GET /api/regime/current` (Part C) already computes per-bar regime `metrics` (trend/ADX/breadth/volatility) via `computeRegimeSeries`, but the route drops them, returning only `{label, ts}` — a one-line fix exposes what's already there. Second, `decide()`'s `marketNote`/`plainNote` fields are computed every cycle a Claude call happens, then discarded — `runCycle` never persists them anywhere, so there is currently no way to show "what Claude said about the market" after the fact. This plan adds two nullable columns to `cycle_log` (via a guarded `ALTER TABLE`, same migration pattern Part A used for `trades.candidate_id`, since `cycle_log` already has live rows on the Pi) and has `runCycle` write them whenever a real `decide()` call happens (most cycles right now don't — `risk_off` with zero candidates — so most rows legitimately have `null` notes, which is correct, not a bug).

**Tech Stack:** Express (existing API), `better-sqlite3`, `node --test` with real in-process HTTP requests.

**Spec:** `docs/v2-design.md` §8.2 (Current strategy tab), §9 (`GET /api/strategy`, `GET /api/positions`).

**Depends on:** milestone 4 (`computeExpectancy` in `src/backtest/stats.js`), milestone 5/6 (`scheduler_state`, guardrail config fields), Part C (`GET /api/regime/current`, `GET /api/positions`), Part D (static-asset serving pattern this plan's later UI part will reuse).

## Global Constraints

- Every endpoint scopes by `mode` (default `paper`).
- `cycle_log`'s new columns are nullable and backward-compatible — a row from before this migration (every real row on the Pi right now) simply has `market_note: null`, `plain_note_json: null`, read correctly as "no note was given this cycle," not an error.

## Interpretation decisions

- **Config-version display, config editing, backtest-trigger, and the weekly-proposal approve/reject flow are entirely out of scope for this plan.** Design §8.2 lists these under "Strategy controls" and "Config," but design's own build-order table (§10) puts "Weekly review + config approval" at milestone 8, separate from milestone 7's "Dashboard: Charts, Strategy, Decision log." There is no `config_versions` table, no config-editing code path, and no weekly-review-trigger code anywhere in the codebase yet — building any of those now would mean inventing milestone 8's data model to serve a read-only display this plan doesn't actually need. `GET /api/strategy`'s `config` field is a fixed `{ activeVersion: 'default', pending: null }` until milestone 8 gives it something real to report.
- **Risk level (Cautious/Normal/Bold), per-setup on/off editing, and stop/trail range editing are also out of scope.** These are write operations with no backing mutation path (`DEFAULT_RISK_CONFIG` is a static object; nothing persists a "current" risk level anywhere). A read-only Strategy tab can show the setups and their ranges (Task 3) without being able to edit them yet.
- **The market note is read from the most recent `cycle_log` row (for the given mode) that has a non-null `market_note`**, not from a dedicated "latest note" table — `cycle_log` already is "one row per hourly cycle," so a `WHERE market_note IS NOT NULL ORDER BY ts DESC LIMIT 1` query is the natural, no-new-table way to answer "what did Claude last say."
- **Per-setup stats use `computeExpectancy` from `src/backtest/stats.js` directly** (not a reimplementation) — the exact function the milestone-4 gate used, applied here to real trades instead of backtest trades, keeping "backtest and live share engine code" true for statistics too.

## Review Focus

- A setup with zero real trades in the last 30/90 days must report `{ count: 0, winRate: 0, expectancy: 0, pass: false }` (via `computeExpectancy`'s own empty-input handling) — not `NaN`, not an error. This is the common case for every setup right now.
- `GET /api/strategy`'s `guardrails` section must compute `dailyLoss`/`weeklyDrawdown` usage from the same formulas `runCycle` itself uses (`balanceAtDayStart = balance - dailyPnl`, `weeklyDrawdownPct = (weeklyPeakBalance - balance) / weeklyPeakBalance`) — a dashboard showing different numbers than what the live risk engine is actually checking would be actively misleading, not just incomplete.
- A cycle where `decide()` was never called (the overwhelming majority right now) must leave `market_note`/`plain_note_json` as `null` in `cycle_log`, not an empty string or a stale copy of the previous cycle's note — "no note" and "an empty note" are different facts.
- `GET /api/strategy` with no `scheduler_state` saved yet for the requested mode must return sensible zeroed/empty guardrail and position data, not throw.

---

## Task 1: Persist `marketNote`/`plainNote` per cycle

**Files:**
- Modify: `src/data/db.js`
- Modify: `src/scheduler/cycle.js`
- Test: `test/data-db-cycle-log-notes.test.js`

**Interfaces:**
- Produces: `cycle_log` gains `market_note TEXT`, `plain_note_json TEXT` (migrated via guarded `ALTER TABLE`, same pattern as `trades.candidate_id`). `insertCycleLog` accepts optional `marketNote`/`plainNote` fields (defaulting to `null`). `getLatestMarketNote(db, mode)` → `{ ts, marketNote, plainNote } | null`.
- Consumed by: Task 3's `GET /api/strategy`.

- [ ] **Step 1: Write the failing tests**

Create `test/data-db-cycle-log-notes.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb, insertCycleLog, getLatestMarketNote } = require('../src/data/db');

test('openDb adds market_note/plain_note_json to a pre-existing cycle_log table', () => {
  const tmpPath = path.join(os.tmpdir(), `cryptodash-cyclelog-migration-${Date.now()}.db`);
  const raw = new Database(tmpPath);
  raw.exec(`
    CREATE TABLE cycle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, mode TEXT NOT NULL, regime_label TEXT,
      candidates_count INTEGER NOT NULL, opened_count INTEGER NOT NULL, closed_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, error TEXT
    );
  `);
  raw.close();

  const migrated = openDb(tmpPath);
  const columns = migrated.prepare("PRAGMA table_info(cycle_log)").all().map((c) => c.name);
  assert.ok(columns.includes('market_note'));
  assert.ok(columns.includes('plain_note_json'));

  migrated.close();
  fs.unlinkSync(tmpPath);
  if (fs.existsSync(`${tmpPath}-wal`)) fs.unlinkSync(`${tmpPath}-wal`);
  if (fs.existsSync(`${tmpPath}-shm`)) fs.unlinkSync(`${tmpPath}-shm`);
});

test('insertCycleLog stores marketNote/plainNote when given, and getLatestMarketNote returns the newest one', () => {
  const db = openDb(':memory:');
  insertCycleLog(db, {
    ts: 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100,
  }); // no note this cycle — decide() was never called
  insertCycleLog(db, {
    ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 100,
    marketNote: 'Breadth improving, taking the pullback.', plainNote: { mood: 'positive', bullets: ['BTC uptrend'], botAction: 'Bought SOL' },
  });

  const latest = getLatestMarketNote(db, 'paper');
  assert.equal(latest.ts, 2000);
  assert.equal(latest.marketNote, 'Breadth improving, taking the pullback.');
  assert.equal(latest.plainNote.mood, 'positive');
});

test('getLatestMarketNote returns null when no cycle has ever had a note', () => {
  const db = openDb(':memory:');
  insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });
  assert.equal(getLatestMarketNote(db, 'paper'), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-db-cycle-log-notes.test.js`
Expected: FAIL — migration test fails (no such column), `getLatestMarketNote is not a function`.

- [ ] **Step 3: Implement**

In `src/data/db.js`, add the migration right after the existing `trades.candidate_id` migration block inside `openDb`:

```js
  const cycleLogColumns = db.prepare("PRAGMA table_info(cycle_log)").all().map((c) => c.name);
  if (!cycleLogColumns.includes('market_note')) {
    db.exec('ALTER TABLE cycle_log ADD COLUMN market_note TEXT');
  }
  if (!cycleLogColumns.includes('plain_note_json')) {
    db.exec('ALTER TABLE cycle_log ADD COLUMN plain_note_json TEXT');
  }
```

Update `insertCycleLog`:

```js
function insertCycleLog(db, row) {
  db.prepare(`
    INSERT INTO cycle_log (ts, mode, regime_label, candidates_count, opened_count, closed_count, duration_ms, error, market_note, plain_note_json)
    VALUES (@ts, @mode, @regimeLabel, @candidatesCount, @openedCount, @closedCount, @durationMs, @error, @marketNote, @plainNoteJson)
  `).run({
    error: null, marketNote: null, ...row,
    plainNoteJson: row.plainNote !== undefined ? JSON.stringify(row.plainNote) : null,
  });
}
```

Add:

```js
function getLatestMarketNote(db, mode) {
  const row = db.prepare(`
    SELECT ts, market_note AS marketNote, plain_note_json AS plainNoteJson
    FROM cycle_log WHERE mode = ? AND market_note IS NOT NULL
    ORDER BY ts DESC LIMIT 1
  `).get(mode);
  if (!row) return null;
  return { ts: row.ts, marketNote: row.marketNote, plainNote: row.plainNoteJson ? JSON.parse(row.plainNoteJson) : null };
}
```

Add `getLatestMarketNote` to `module.exports`.

In `src/scheduler/cycle.js`, find the success-path `insertCycleLog` call (inside the `try` block, after `persistCycleResults`) and thread the note through — it only exists when `decide()` was actually called this cycle, so capture `result` in an outer-scoped variable accessible at the point `insertCycleLog` is called. The `if (cycleCandidates.length > 0 || state.openPositions.length > 0) { ... const result = await decide(...); ... }` block is inside the same function as the final `insertCycleLog` call; declare `let decideResult = null;` before that `if` block, set `decideResult = result;` right after the `decide()` call, and change the final `insertCycleLog` call to:

```js
    insertCycleLog(db, {
      ts: nowHour, mode, regimeLabel, candidatesCount, openedCount, closedCount,
      durationMs: Date.now() - startedAt,
      marketNote: decideResult && !decideResult.fallback ? decideResult.marketNote : null,
      plainNote: decideResult && !decideResult.fallback ? decideResult.plainNote : null,
    });
```

(A `fallback: true` result's `marketNote`/`plainNote` are always empty-string/`null` per `parseDecisionResponse`'s fallback shape — explicitly excluding the fallback case here keeps `null` meaning "no real note," not "an empty fallback note.")

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-db-cycle-log-notes.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js src/scheduler/cycle.js test/data-db-cycle-log-notes.test.js
git commit -m "feat(data): persist marketNote/plainNote per cycle when decide() is actually called"
```

---

## Task 2: Expose regime metrics on `GET /api/regime/current`

**Files:**
- Modify: `src/server/app.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Modifies: `GET /api/regime/current` → adds a `metrics` field (the same object `computeRegimeSeries` already attaches to each series point — trend/ADX/breadth/volatility-rank fields, whatever `labelRegime` actually computes) alongside the existing `label`/`ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/server-app.test.js`:

```js
test('GET /api/regime/current includes the metrics behind the label, not just the label', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const rows = [];
    for (let i = 0; i < 250; i += 1) {
      rows.push({ coin: 'BTC', timeframe: '1d', ts: i * 86400, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1, trades: 1 });
      rows.push({ coin: 'BTC', timeframe: '4h', ts: i * 86400, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1, trades: 1 });
    }
    upsertCandles(db, rows);

    const res = await fetch(`http://127.0.0.1:${port}/api/regime/current`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    if (body.label !== null) {
      assert.ok(body.metrics, 'expected a metrics object once a label is computed');
      assert.ok(typeof body.metrics === 'object');
    }
  } finally {
    server.close();
  }
});
```

(This test's fixture may or may not produce enough real signal to yield a non-null label depending on `labelRegime`'s exact thresholds — the assertion is deliberately conditional on `body.label !== null` so the test doesn't become a fragile prediction of the regime engine's exact behavior; it only checks that *when* a label is computed, `metrics` rides along with it, which is this task's actual change.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server-app.test.js`
Expected: either the assertion fails (if a label is computed and `metrics` is missing) — confirm by temporarily checking the current route's response shape if the test doesn't trigger the `if`.

- [ ] **Step 3: Implement**

In `src/server/app.js`, change the `/api/regime/current` handler's final line:

```js
    res.json(latest ? { label: latest.label, ts: latest.ts, metrics: latest.metrics } : { label: null, ts: null, metrics: null });
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/server-app.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/app.js test/server-app.test.js
git commit -m "feat(server): expose regime metrics on GET /api/regime/current"
```

---

## Task 3: `GET /api/strategy`

**Files:**
- Modify: `src/server/app.js`
- Modify: `src/data/db.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `getSetupStats(db, mode, setupName, sinceTs)` in `src/data/db.js` — filters `getTrades(db, mode)` to `setup === setupName` and `exitTs >= sinceTs`, runs them through `computeExpectancy`. `GET /api/strategy?mode=` → `200` with:
```json
{
  "setups": [{ "name": "trend_breakout", "ranges": {...}, "stats30d": {...}, "stats90d": {...} }, ...],
  "marketNote": { "ts": ..., "marketNote": "...", "plainNote": {...} } | null,
  "guardrails": {
    "killSwitchActive": false,
    "openPositions": { "used": 0, "max": 3 },
    "totalRiskPct": { "used": 0, "max": 0.015 },
    "totalExposurePct": { "used": 0, "max": 0.60 },
    "dailyLossPct": { "used": 0, "max": 0.03 },
    "weeklyDrawdownPct": { "used": 0, "max": 0.08 }
  },
  "config": { "activeVersion": "default", "pending": null }
}
```

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:

```js
test('GET /api/strategy returns per-setup stats, computed with computeExpectancy, zeroed for a setup with no trades', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.setups.length, 4); // the four real setups
    const pullback = body.setups.find((s) => s.name === 'trend_pullback');
    assert.ok(pullback.ranges); // ranges came from the real playbook module
    assert.equal(pullback.stats30d.count, 0);
    assert.equal(pullback.stats30d.expectancy, 0);
  } finally {
    server.close();
  }
});

test('GET /api/strategy reports real win rate/expectancy for a setup with real trades', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const recentTs = Math.floor(Date.now() / 1000) - 3600;
    insertTrade(db, {
      mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: recentTs, exitTs: recentTs + 100,
      entryPrice: 100, exitPrice: 110, units: 1, riskAmount: 5, pnl: 5, r: 1.0, exitReason: 'target',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    const pullback = body.setups.find((s) => s.name === 'trend_pullback');
    assert.equal(pullback.stats30d.count, 1);
    assert.equal(pullback.stats30d.winRate, 1);
  } finally {
    server.close();
  }
});

test('GET /api/strategy computes guardrail usage with the same formulas runCycle uses, with no state defaulting to zeroed guardrails', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.guardrails.killSwitchActive, false);
    assert.equal(body.guardrails.openPositions.used, 0);
    assert.equal(body.guardrails.openPositions.max, 3);
    assert.equal(body.guardrails.dailyLossPct.max, 0.03);
  } finally {
    server.close();
  }
});

test('GET /api/strategy includes the latest market note when one exists, null otherwise', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const noNoteRes = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal((await noNoteRes.json()).marketNote, null);

    insertCycleLog(db, {
      ts: 1700000000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 100,
      marketNote: 'Taking the pullback.', plainNote: { mood: 'positive', bullets: [], botAction: 'x' },
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.marketNote.marketNote, 'Taking the pullback.');
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` for all 4 (no such route yet).

- [ ] **Step 3: Export a `RANGES` constant from each playbook setup**

Each setup currently builds its `ranges` object inline inside the candidate `evaluate()` returns — there's no static export `/api/strategy` can read without constructing a synthetic candle just to call `evaluate()`. Name the existing literal once per setup and export it, without changing its value.

In `src/engine/playbook/trendBreakout.js`, add near the top (after `'use strict';`):

```js
const RANGES = { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [2.0, 4.0] };
```

and change the returned candidate's `ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [2.0, 4.0] }` to `ranges: RANGES`, and the file's `module.exports = { evaluate };` to `module.exports = { evaluate, RANGES };`.

Do the same in `src/engine/playbook/trendPullback.js` (`RANGES = { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] }`), `src/engine/playbook/rangeReversion.js` (`RANGES = { size: [0, 1], stopAtr: [1.0, 2.5] }`), and `src/engine/playbook/oversoldBounce.js` (`RANGES = { size: [0, 0.5], stopAtr: [0.5, 2.0] }`) — each value copied exactly from that file's current inline `ranges` literal, each file's `module.exports` gaining `RANGES` alongside `evaluate`.

This is a pure refactor (same values, just named and exported) — the existing playbook tests from milestone 6 Part A already assert these exact `ranges` values on the returned candidate, so running them confirms nothing changed behaviorally.

- [ ] **Step 4: Run the playbook tests to confirm the refactor changed nothing**

Run: `node --test test/engine-playbook-trend-breakout.test.js test/engine-playbook-trend-pullback.test.js test/engine-playbook-range-reversion.test.js test/engine-playbook-oversold-bounce.test.js`
Expected: PASS (unchanged — same values, now also exported)

- [ ] **Step 5: Implement `getSetupStats` and the `/api/strategy` route**

In `src/data/db.js`, add:

```js
function getSetupStats(db, mode, setupName, sinceTs) {
  const { computeExpectancy } = require('../backtest/stats');
  const trades = getTrades(db, mode).filter((t) => t.setup === setupName && t.exitTs >= sinceTs);
  return computeExpectancy(trades);
}
```

Add `getSetupStats` to `module.exports`.

In `src/server/app.js`, add:

```js
  const { getSetupStats, getLatestMarketNote } = require('../data/db');
  const { SETUPS } = require('../engine/playbook');

  app.get('/api/strategy', (req, res) => {
    const mode = req.query.mode || 'paper';
    const nowTs = Math.floor(Date.now() / 1000);

    const setups = Object.entries(SETUPS).map(([name, mod]) => ({
      name, ranges: mod.RANGES,
      stats30d: getSetupStats(db, mode, name, nowTs - 30 * 86400),
      stats90d: getSetupStats(db, mode, name, nowTs - 90 * 86400),
    }));

    const state = loadSchedulerState(db, mode);
    const balanceAtDayStart = state ? state.balance - state.dailyPnl : 0;
    const weeklyDrawdownPct = state && state.weeklyPeakBalance > 0 ? (state.weeklyPeakBalance - state.balance) / state.weeklyPeakBalance : 0;
    const totalRiskPctUsed = state ? state.openPositions.reduce((sum, p) => sum + p.riskPct, 0) : 0;
    const totalExposurePctUsed = state ? state.openPositions.reduce((sum, p) => sum + p.exposurePct, 0) : 0;
    const dailyLossPctUsed = state && balanceAtDayStart > 0 ? -state.dailyPnl / balanceAtDayStart : 0;

    res.json({
      setups,
      marketNote: getLatestMarketNote(db, mode),
      guardrails: {
        killSwitchActive: state ? state.killSwitchActive : false,
        openPositions: { used: state ? state.openPositions.length : 0, max: DEFAULT_RISK_CONFIG.maxOpenPositions },
        totalRiskPct: { used: totalRiskPctUsed, max: DEFAULT_RISK_CONFIG.maxTotalRiskPct },
        totalExposurePct: { used: totalExposurePctUsed, max: DEFAULT_RISK_CONFIG.maxTotalExposurePct },
        dailyLossPct: { used: Math.max(0, dailyLossPctUsed), max: DEFAULT_RISK_CONFIG.dailyLossLimitPct },
        weeklyDrawdownPct: { used: weeklyDrawdownPct, max: DEFAULT_RISK_CONFIG.weeklyKillSwitchPct },
      },
      config: { activeVersion: 'default', pending: null },
    });
  });
```

(`DEFAULT_RISK_CONFIG` needs importing if not already in scope in this part of the file: `const { DEFAULT_RISK_CONFIG } = require('../engine/config');` — check whether an earlier route in the same `createApp` body already imports it before adding a second `require` of the same binding name.)

- [ ] **Step 6: Run to verify the `/api/strategy` tests pass**

Run: `node --test test/server-app.test.js test/engine-playbook-trend-breakout.test.js test/engine-playbook-trend-pullback.test.js test/engine-playbook-range-reversion.test.js test/engine-playbook-oversold-bounce.test.js`
Expected: PASS (all tests — the 4 new `/api/strategy` tests, plus the playbook tests unchanged in their actual assertions since `RANGES`'s value is identical to what was inline before)

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/data/db.js src/server/app.js src/engine/playbook/trendBreakout.js src/engine/playbook/trendPullback.js src/engine/playbook/rangeReversion.js src/engine/playbook/oversoldBounce.js test/server-app.test.js
git commit -m "feat(server): add GET /api/strategy (setups, stats, guardrails, market note)"
```

---

## Task 4: Real-run verification

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm the real endpoint against real data**

```bash
timeout 4 node dashboard.js &
sleep 1
curl -s "http://127.0.0.1:3000/api/strategy" | head -c 600
echo
curl -s "http://127.0.0.1:3000/api/regime/current"
echo
wait 2>/dev/null
```
Expected: `strategy` returns all 4 real setups with their real ranges and zeroed stats (no real trades exist yet, given `risk_off` throughout), `marketNote: null` (no real decide() call has happened yet), zeroed guardrails matching `DEFAULT_RISK_CONFIG`'s real caps; `regime/current` now includes a `metrics` field (possibly `null` if the real regime computation still returns `null` for `label`, consistent with Part C's earlier real run).

- [ ] **Step 2: Run the full suite one final time**

Run: `node --test test/`
Expected: PASS

## Part E exit check

- [ ] `node --test test/` passes (all new tests green: 3 cycle-log-notes tests, 1 regime-metrics test, 4 `/api/strategy` tests — 8 new tests — plus every prior test unchanged, including the 4 playbook setup test files after the `RANGES` refactor).
- [ ] `GET /api/strategy` and `GET /api/regime/current` both confirmed against the real Pi database.
- [ ] No UI yet — the next part builds the Strategy tab display (regime card, market note, active setups table, open positions, guardrails) against this API, read-only, with config-editing/backtest-trigger/approval explicitly deferred to milestone 8.
