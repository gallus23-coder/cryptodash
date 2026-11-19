# Claude Decision Layer, Part A (Milestone 6, Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every piece of the Claude decision layer that doesn't require an actual Claude call: candidate/decision persistence, the pure prompt-building and response-validation/clamping logic that enforces "Claude can't exceed limits," and the shadow-outcome engine that simulates the default action forward so Claude's choices can later be compared against it in R. Part B wires the real `claude -p` provider call into `runCycle` and proves fallbacks against the live Pi.

**Architecture:** `decide.js`'s safety-critical logic — building the compact input Claude sees and validating/clamping whatever comes back — is pure and unit-testable, so it's built and proven here without a live call. The shadow-outcome engine reuses `broker/paper.js`'s `fillEntry`/`fillExit`/`evaluateExit` unchanged (same engine code backtest and live already share), applied to a parallel list of "shadow positions" opened with each candidate's *default* action regardless of what gets decided for real — this is what makes the milestone-6 gate's "fallbacks tested" and the eventual scorecard possible. `candidates`/`decisions` tables are new, alongside the existing `trades`/`scheduler_state`/`cycle_log` from milestone 5.

**Tech Stack:** Node.js 20, `better-sqlite3`, `node --test`.

**Spec:** `docs/v2-design.md` §5.2 (playbook candidate shape), §5.3 (Claude decides — input/output contract), §5.4 (guardrails), §5.6 (cost controls, provider switch), §7 (database — `candidates`, `decisions` tables); `CLAUDE.md`'s "Claude can't exceed limits" hard rule (schema-validated, clamped to ranges, stops only tighten, unknown candidates ignored, any failure → skip the cycle) and `src/engine/` layout (`decide.js` listed alongside `indicators.js`/`regime.js`/`playbook/`/`risk.js`).

**Depends on:** `docs/superpowers/plans/2026-11-19-hourly-scheduler.md` (milestone 5 Part B — `runCycle`, `scheduler_state`, `trades`, `cycle_log`), already merged and running on the Pi in paper mode.

**Scope note (user-confirmed):** strict milestone 6 only — candidates/decisions tables, `decide.js`'s pure logic, shadow outcomes. The design doc's §13 Stage A items not yet built (`cycle_snapshots`, setup trial/active/auto_off lifecycle, near-miss logging) are explicitly deferred to a later catch-up task, not built here.

## Global Constraints

- "Claude can't exceed limits": output is schema-validated; values are clamped to each candidate's `ranges`; stops only tighten, never loosen; unknown candidate IDs are ignored, not errored; any failure (timeout, parse error, invalid shape) → the whole cycle's Claude step is skipped, never partially trusted.
- "Results in R (P&L ÷ amount risked) as well as £" — shadow outcomes follow the same convention as real trades.
- `src/engine/` layout explicitly includes `decide.js` — see Interpretation decisions below for how its one necessarily-impure piece (the real provider call, built in Part B) is isolated from the pure logic built here.
- One call per cycle, not one per coin (design §5.6) — `buildDecisionPrompt` takes the whole cycle's candidates and positions in one input object, not per-candidate.
- Every trade/decision tagged `mode` (`paper`/`live`) — `candidates` and `decisions` tables both carry a `mode` column.

## Interpretation decisions

- **`decide.js`'s pure logic lives in `src/engine/decide.js`; the real provider call (spawning `claude -p`) is built in Part B as a separate function in the same file, never exercised by this plan's tests.** CLAUDE.md lists `decide.js` under `src/engine/` in the target layout, but also says engine code must have no network calls. Reconciling both: the functions this plan builds — `buildDecisionPrompt` and `parseDecisionResponse` — take everything as arguments and do no I/O themselves, matching "pure" in the sense that matters (no hidden DB/clock/network access, deterministic given their inputs). The actual `claude -p` subprocess call is isolated to its own exported function (`callClaudeCli`, stubbed here, implemented in Part B) so the pure safety logic — the part CLAUDE.md's hard rule is actually protecting — is fully covered by fast, deterministic tests independent of whether the call itself is mocked, real, or down.
- **Candidate `context` is scoped to indicator-derived fields only (`rsi14`, `adx4h`) for this plan — `funding` and `oiChange24h` from the design's example are omitted.** Kraken Futures' funding-rate client exists (milestone 1) but isn't wired into `ingestAllCoins`/`runCycle` yet; wiring it in is separate scope from the decision layer itself and is a known, documented gap, not an oversight.
- **Candidate IDs are assigned centrally, not by each playbook setup.** The design's ID format (`c_20261118_10_SOL_trend_pullback`) needs the bar's timestamp, which playbook `evaluate()` functions already have via `candles4h[i].ts`, but assigning it inside four separate files invites drift; one pure helper (`buildCandidateId`) is more auditable and is the single place the format lives.
- **`ranges` is added to each playbook setup's returned candidate object, not computed elsewhere**, since each setup is the only place that knows what range of its own stop/trail/size is sane to let Claude pick within. Values below are derived from each setup's own default (table in design §5.2) with headroom similar to the design's own worked example for `trend_pullback` (`size: [0,1]`, `stopAtr: [1.0,3.0]`, `trailAtr: [1.5,4.0]`).

## Review Focus

- A `decisions` response with a correct JSON envelope but an out-of-range `stopAtr`/`trailAtr`/`size` for one candidate must get that one value clamped into range, not rejected outright and not applied as-is — a reasonable person reading "Claude can't exceed limits" expects the trade to still happen, just capped, not silently vanish over a single out-of-range number.
- A `positionActions` entry proposing a *looser* stop than the position currently has must be dropped (treated as a no-op for that entry), never applied — CLAUDE.md says stops "only tighten."
- A `decisions` entry whose `candidateId` doesn't match any candidate from this cycle's input must be dropped silently (not thrown, not counted as a parse failure for the rest of the response) — CLAUDE.md says "unknown candidates ignored."
- A response that isn't valid JSON at all, or whose top-level shape is wrong (e.g. `decisions` is not an array), must fall back to "skip all" for the *whole* cycle — CLAUDE.md says "any failure → skip the cycle (never trade on a bad response)," not "skip just the broken part."
- A shadow position opened for a `target_or_time`/`ema_cross_or_time` setup must resolve using the exact same exit logic real positions use (`evaluateExit`) — if the shadow engine re-implemented exit logic instead of reusing `evaluateExit`, a future change to real exit behavior could silently diverge from what the scorecard measures.

---

## Task 1: Add `ranges` to each playbook setup's candidate

**Files:**
- Modify: `src/engine/playbook/trendBreakout.js`, `src/engine/playbook/trendPullback.js`, `src/engine/playbook/rangeReversion.js`, `src/engine/playbook/oversoldBounce.js`
- Modify: `test/engine-playbook-trend-breakout.test.js`, `test/engine-playbook-trend-pullback.test.js`, `test/engine-playbook-range-reversion.test.js`, `test/engine-playbook-oversold-bounce.test.js`

**Interfaces:**
- Produces: each setup's candidate object gains a `ranges` field (`{ size: [min,max], stopAtr: [min,max], trailAtr?: [min,max] }` — `trailAtr` only present for setups whose `exitType` is `trailing_stop`).
- Consumed by: Task 5's `parseDecisionResponse` (clamps Claude's proposed values into these ranges) and Task 4's `buildDecisionPrompt` (sends ranges to Claude so it knows what it's allowed to propose).

- [ ] **Step 1: Write the failing tests**

Add to each of the four test files (shown here for `test/engine-playbook-trend-pullback.test.js` — the others follow the same shape with their own setup's ranges):

```js
test('candidate includes a ranges object bounding size/stopAtr/trailAtr', () => {
  const candles4h = buildPullbackCandles(); // however the existing tests in this file build fixture candles
  const indicators = buildIndicators(candles4h); // however the existing tests build fixtures
  const i = candles4h.length - 1;
  const candidate = evaluate('BTC', candles4h, indicators, i, 'trend_up');
  assert.deepEqual(candidate.ranges, { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] });
});
```

Use each file's own existing fixture-building helpers (already present in each test file from milestone 4) rather than rewriting fixtures — this step only adds one new assertion per file, reusing whatever already produces a firing candidate in that file's existing passing test.

For `trendBreakout`: `ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [2.0, 4.0] }`.
For `rangeReversion`: `ranges: { size: [0, 1], stopAtr: [1.0, 2.5] }` (no `trailAtr` — this setup's `exitType` is `target_or_time`).
For `oversoldBounce`: `ranges: { size: [0, 0.5], stopAtr: [0.5, 2.0] }` (no `trailAtr` — `exitType` is `ema_cross_or_time`; size capped at 0.5 matching the design's "half size max" for this setup).

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-playbook-trend-breakout.test.js test/engine-playbook-trend-pullback.test.js test/engine-playbook-range-reversion.test.js test/engine-playbook-oversold-bounce.test.js`
Expected: FAIL — `candidate.ranges` is `undefined`, `assert.deepEqual` fails against `undefined`.

- [ ] **Step 3: Implement**

In `src/engine/playbook/trendBreakout.js`, change the returned object:

```js
return {
  coin,
  setup: 'trend_breakout',
  regime: regimeLabel,
  entry: bar.close,
  atr: indicators.atr14[i],
  default: { action: 'take', size: 1.0, stopAtr: 2.0, trailAtr: 3.0 },
  ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [2.0, 4.0] },
  exitType: 'trailing_stop',
};
```

In `src/engine/playbook/trendPullback.js`:

```js
return {
  coin,
  setup: 'trend_pullback',
  regime: regimeLabel,
  entry: bar.close,
  atr: indicators.atr14[i],
  default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
  ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
  exitType: 'trailing_stop',
};
```

In `src/engine/playbook/rangeReversion.js`:

```js
return {
  coin,
  setup: 'range_reversion',
  regime: regimeLabel,
  entry: bar.close,
  atr: indicators.atr14[i],
  default: { action: 'take', size: 1.0, stopAtr: 1.5 },
  ranges: { size: [0, 1], stopAtr: [1.0, 2.5] },
  exitType: 'target_or_time',
  targetType: 'bollinger_middle',
  timeStopHours: 24,
};
```

In `src/engine/playbook/oversoldBounce.js`:

```js
return {
  coin,
  setup: 'oversold_bounce',
  regime: regimeLabel,
  entry: bar.close,
  atr: indicators.atr14[i],
  default: { action: 'take', size: 0.5, stopAtr: 1.0 },
  ranges: { size: [0, 0.5], stopAtr: [0.5, 2.0] },
  exitType: 'ema_cross_or_time',
  emaPeriod: 20,
  timeStopHours: 12,
};
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-playbook-trend-breakout.test.js test/engine-playbook-trend-pullback.test.js test/engine-playbook-range-reversion.test.js test/engine-playbook-oversold-bounce.test.js test/backtest-run.test.js`
Expected: PASS (all tests — the 4 new assertions, and `backtest-run.test.js` unchanged since `ranges` is an additive field nothing there reads yet).

- [ ] **Step 5: Commit**

```bash
git add src/engine/playbook/trendBreakout.js src/engine/playbook/trendPullback.js src/engine/playbook/rangeReversion.js src/engine/playbook/oversoldBounce.js test/engine-playbook-trend-breakout.test.js test/engine-playbook-trend-pullback.test.js test/engine-playbook-range-reversion.test.js test/engine-playbook-oversold-bounce.test.js
git commit -m "feat(playbook): add ranges to each setup's candidate for Claude's adjustment limits"
```

---

## Task 2: `engine/candidates.js` — candidate ID and context helpers

**Files:**
- Create: `src/engine/candidates.js`
- Test: `test/engine-candidates.test.js`

**Interfaces:**
- Produces: `buildCandidateId(tsSeconds, coin, setup)` → string, format `c_YYYYMMDD_HH_COIN_setup` (UTC). `attachContext(candidate, indicators, i)` → returns a new candidate object with a `context` field added (`{ rsi14, adx4h }`, pulled from `indicators.rsi14[i]` and `indicators.adx14.adx[i]`; either may be `null` during warmup, passed through as-is).
- Consumed by: Part B's `runCycle` (not this plan) — these are pure helpers proven here by unit test; nothing in this plan's other tasks calls them yet.

- [ ] **Step 1: Write the failing tests**

Create `test/engine-candidates.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidateId, attachContext } = require('../src/engine/candidates');

test('buildCandidateId formats as c_YYYYMMDD_HH_COIN_setup in UTC', () => {
  const ts = Date.UTC(2026, 10, 18, 10, 0, 0) / 1000; // 2026-11-18 10:00 UTC
  assert.equal(buildCandidateId(ts, 'SOL', 'trend_pullback'), 'c_20261118_10_SOL_trend_pullback');
});

test('buildCandidateId pads single-digit hours and handles month/day boundaries', () => {
  const ts = Date.UTC(2026, 0, 1, 4, 0, 0) / 1000; // 2026-01-01 04:00 UTC
  assert.equal(buildCandidateId(ts, 'BTC', 'oversold_bounce'), 'c_20260101_04_BTC_oversold_bounce');
});

test('attachContext adds rsi14 and adx4h from the indicator arrays at index i', () => {
  const candidate = { coin: 'BTC', setup: 'trend_pullback' };
  const indicators = { rsi14: [null, 47.2], adx14: { adx: [null, 26.1] } };
  const result = attachContext(candidate, indicators, 1);
  assert.deepEqual(result.context, { rsi14: 47.2, adx4h: 26.1 });
  assert.equal(result.coin, 'BTC'); // original fields preserved
});

test('attachContext passes through nulls during indicator warmup without throwing', () => {
  const candidate = { coin: 'BTC', setup: 'trend_pullback' };
  const indicators = { rsi14: [null], adx14: { adx: [null] } };
  const result = attachContext(candidate, indicators, 0);
  assert.deepEqual(result.context, { rsi14: null, adx4h: null });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-candidates.test.js`
Expected: FAIL — `Cannot find module '../src/engine/candidates'`

- [ ] **Step 3: Implement**

Create `src/engine/candidates.js`:

```js
'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildCandidateId(tsSeconds, coin, setup) {
  const d = new Date(tsSeconds * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  return `c_${yyyy}${mm}${dd}_${hh}_${coin}_${setup}`;
}

function attachContext(candidate, indicators, i) {
  return {
    ...candidate,
    context: { rsi14: indicators.rsi14[i], adx4h: indicators.adx14.adx[i] },
  };
}

module.exports = { buildCandidateId, attachContext };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-candidates.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/candidates.js test/engine-candidates.test.js
git commit -m "feat(engine): add candidate ID formatting and context-attachment helpers"
```

---

## Task 3: `candidates` + `decisions` tables and accessors

**Files:**
- Modify: `src/data/db.js`
- Test: `test/data-db-candidates-decisions.test.js`

**Interfaces:**
- Produces: `insertCandidate(db, candidate)` (upsert by `id` — a candidate re-seen across a retried cycle overwrites, doesn't duplicate), `getCandidate(db, id)` → candidate row or `null`, `updateCandidateShadow(db, id, { status, exitTs, pnl, r, exitReason })`, `insertDecision(db, decision)`, `getDecisions(db, mode, limit = 50)` → array newest-first.
- Consumed by: Part B's `runCycle` (not this plan) and Task 6's shadow-outcome tests (this plan, for `updateCandidateShadow`/`getCandidate`).

- [ ] **Step 1: Write the failing tests**

Create `test/data-db-candidates-decisions.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, insertCandidate, getCandidate, updateCandidateShadow, insertDecision, getDecisions } = require('../src/data/db');

function sampleCandidate(id = 'c_20261118_10_SOL_trend_pullback') {
  return {
    id, ts: 1700000000, mode: 'paper', coin: 'SOL', setup: 'trend_pullback', regime: 'trend_up',
    entry: 98.40, atr: 3.10,
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
    context: { rsi14: 47.2, adx4h: 26.1 },
  };
}

test('insertCandidate stores a candidate and getCandidate retrieves it with JSON fields parsed back out', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());

  const row = getCandidate(db, 'c_20261118_10_SOL_trend_pullback');
  assert.equal(row.coin, 'SOL');
  assert.equal(row.entry, 98.40);
  assert.deepEqual(row.default, { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 });
  assert.deepEqual(row.ranges, { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] });
  assert.deepEqual(row.context, { rsi14: 47.2, adx4h: 26.1 });
  assert.equal(row.shadowStatus, 'open'); // default status for a freshly-inserted candidate
});

test('insertCandidate upserts by id rather than duplicating on a retried cycle', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());
  insertCandidate(db, sampleCandidate()); // same id, simulating a retried cycle

  const row = getCandidate(db, 'c_20261118_10_SOL_trend_pullback');
  assert.ok(row); // still exactly one row reachable by id, not an error from a duplicate PK
});

test('updateCandidateShadow resolves a candidate\'s shadow outcome', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());

  updateCandidateShadow(db, 'c_20261118_10_SOL_trend_pullback', {
    status: 'resolved', exitTs: 1700050000, pnl: 12.5, r: 1.2, exitReason: 'trailing_stop',
  });

  const row = getCandidate(db, 'c_20261118_10_SOL_trend_pullback');
  assert.equal(row.shadowStatus, 'resolved');
  assert.equal(row.shadowPnl, 12.5);
  assert.equal(row.shadowR, 1.2);
  assert.equal(row.shadowExitReason, 'trailing_stop');
});

test('insertDecision stores a decision linked to its candidate, and getDecisions returns newest first', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());
  insertCandidate(db, sampleCandidate('c_20261118_14_SOL_trend_pullback'));

  insertDecision(db, {
    candidateId: 'c_20261118_10_SOL_trend_pullback', ts: 1700000000, mode: 'paper',
    action: 'take', size: 0.5, stopAtr: 2.0, trailAtr: 2.5,
    reason: 'Setup valid but funding elevated.', plainReason: 'Bought smaller with more room.',
    defaultAction: 'take', diverged: true, model: 'claude-cli', latencyMs: 1200, rawResponse: '{"ok":true}',
  });
  insertDecision(db, {
    candidateId: 'c_20261118_14_SOL_trend_pullback', ts: 1700014400, mode: 'paper',
    action: 'skip', size: 0, stopAtr: null, trailAtr: null,
    reason: 'Breadth falling.', plainReason: 'Sat out.',
    defaultAction: 'take', diverged: true, model: 'claude-cli', latencyMs: 900, rawResponse: '{"ok":true}',
  });

  const decisions = getDecisions(db, 'paper');
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].candidateId, 'c_20261118_14_SOL_trend_pullback'); // newest first
  assert.equal(decisions[0].diverged, true);
  assert.equal(decisions[1].candidateId, 'c_20261118_10_SOL_trend_pullback');
});

test('getDecisions respects the mode filter and the limit', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());
  insertDecision(db, {
    candidateId: 'c_20261118_10_SOL_trend_pullback', ts: 1700000000, mode: 'live',
    action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5,
    reason: 'x', plainReason: 'x', defaultAction: 'take', diverged: false,
    model: 'claude-cli', latencyMs: 800, rawResponse: '{}',
  });

  assert.equal(getDecisions(db, 'paper').length, 0); // mode filter excludes the 'live' row
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-db-candidates-decisions.test.js`
Expected: FAIL — `insertCandidate is not a function` (not yet exported from `../src/data/db`).

- [ ] **Step 3: Implement**

In `src/data/db.js`, add to the schema inside `openDb` (in the same `db.exec` block as the milestone-5 tables):

```js
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, mode TEXT NOT NULL,
      coin TEXT NOT NULL, setup TEXT NOT NULL, regime TEXT NOT NULL,
      entry REAL NOT NULL, atr REAL NOT NULL,
      default_json TEXT NOT NULL, ranges_json TEXT NOT NULL, context_json TEXT NOT NULL,
      shadow_status TEXT NOT NULL DEFAULT 'open',
      shadow_exit_ts INTEGER, shadow_pnl REAL, shadow_r REAL, shadow_exit_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, ts INTEGER NOT NULL, mode TEXT NOT NULL,
      action TEXT NOT NULL, size REAL, stop_atr REAL, trail_atr REAL,
      reason TEXT, plain_reason TEXT, default_action TEXT NOT NULL, diverged INTEGER NOT NULL,
      model TEXT NOT NULL, latency_ms INTEGER NOT NULL, raw_response TEXT NOT NULL
    );
  `);
```

(This goes in the same template-literal block as the existing `trades`/`scheduler_state`/`cycle_log` tables from milestone 5 — add it right after those, inside the same `db.exec`.)

Then add these functions near `insertTrade`/`getTrades` (same file):

```js
function insertCandidate(db, candidate) {
  db.prepare(`
    INSERT INTO candidates (id, ts, mode, coin, setup, regime, entry, atr, default_json, ranges_json, context_json)
    VALUES (@id, @ts, @mode, @coin, @setup, @regime, @entry, @atr, @defaultJson, @rangesJson, @contextJson)
    ON CONFLICT(id) DO UPDATE SET
      ts = excluded.ts, mode = excluded.mode, coin = excluded.coin, setup = excluded.setup, regime = excluded.regime,
      entry = excluded.entry, atr = excluded.atr, default_json = excluded.default_json,
      ranges_json = excluded.ranges_json, context_json = excluded.context_json
  `).run({
    id: candidate.id, ts: candidate.ts, mode: candidate.mode, coin: candidate.coin, setup: candidate.setup,
    regime: candidate.regime, entry: candidate.entry, atr: candidate.atr,
    defaultJson: JSON.stringify(candidate.default), rangesJson: JSON.stringify(candidate.ranges),
    contextJson: JSON.stringify(candidate.context),
  });
}

function rowToCandidate(row) {
  if (!row) return null;
  return {
    id: row.id, ts: row.ts, mode: row.mode, coin: row.coin, setup: row.setup, regime: row.regime,
    entry: row.entry, atr: row.atr,
    default: JSON.parse(row.default_json), ranges: JSON.parse(row.ranges_json), context: JSON.parse(row.context_json),
    shadowStatus: row.shadow_status, shadowExitTs: row.shadow_exit_ts,
    shadowPnl: row.shadow_pnl, shadowR: row.shadow_r, shadowExitReason: row.shadow_exit_reason,
  };
}

function getCandidate(db, id) {
  return rowToCandidate(db.prepare('SELECT * FROM candidates WHERE id = ?').get(id));
}

function updateCandidateShadow(db, id, { status, exitTs, pnl, r, exitReason }) {
  db.prepare(`
    UPDATE candidates SET shadow_status = @status, shadow_exit_ts = @exitTs,
      shadow_pnl = @pnl, shadow_r = @r, shadow_exit_reason = @exitReason
    WHERE id = @id
  `).run({ id, status, exitTs, pnl, r, exitReason });
}

function insertDecision(db, decision) {
  db.prepare(`
    INSERT INTO decisions (candidate_id, ts, mode, action, size, stop_atr, trail_atr, reason, plain_reason, default_action, diverged, model, latency_ms, raw_response)
    VALUES (@candidateId, @ts, @mode, @action, @size, @stopAtr, @trailAtr, @reason, @plainReason, @defaultAction, @diverged, @model, @latencyMs, @rawResponse)
  `).run({ ...decision, diverged: decision.diverged ? 1 : 0 });
}

function getDecisions(db, mode, limit = 50) {
  return db.prepare(`
    SELECT candidate_id AS candidateId, ts, mode, action, size, stop_atr AS stopAtr, trail_atr AS trailAtr,
      reason, plain_reason AS plainReason, default_action AS defaultAction, diverged, model, latency_ms AS latencyMs, raw_response AS rawResponse
    FROM decisions WHERE mode = ? ORDER BY ts DESC LIMIT ?
  `).all(mode, limit).map((row) => ({ ...row, diverged: !!row.diverged }));
}
```

Add all five new functions to the `module.exports` object at the bottom of the file.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-db-candidates-decisions.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS (all prior tests unchanged, plus these 5 new ones)

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js test/data-db-candidates-decisions.test.js
git commit -m "feat(data): add candidates and decisions tables with shadow-outcome columns"
```

---

## Task 4: `engine/decide.js` — `buildDecisionPrompt`

**Files:**
- Create: `src/engine/decide.js`
- Test: `test/engine-decide-prompt.test.js`

**Interfaces:**
- Produces: `buildDecisionPrompt(input)` → `{ system, user }` (both strings; `user` is `JSON.stringify` of a compacted payload). `input` shape: `{ regime, regimeMetrics, candidates: [...], openPositions: [...], recentTrades: [...], setupConfig, guardrailHeadroom }` (matches design §5.3's "Input:" list).
- Consumed by: Part B's `runCycle` (not this plan) and Task 5's tests (which construct response fixtures referencing candidate IDs this would have sent).

- [ ] **Step 1: Write the failing tests**

Create `test/engine-decide-prompt.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDecisionPrompt } = require('../src/engine/decide');

function sampleInput() {
  return {
    regime: 'trend_up',
    regimeMetrics: { adx4h: 26.1, btcAbove200d: true },
    candidates: [{
      id: 'c_20261118_10_SOL_trend_pullback', coin: 'SOL', setup: 'trend_pullback', regime: 'trend_up',
      entry: 98.40, atr: 3.10, default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
      ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] }, context: { rsi14: 47.2, adx4h: 26.1 },
    }],
    openPositions: [{ coin: 'BTC', setup: 'trend_breakout', entryPrice: 61000, unrealizedPnlPct: 2.1 }],
    recentTrades: [{ coin: 'ETH', setup: 'range_reversion', r: 0.8, exitReason: 'target' }],
    setupConfig: { trend_breakout: 'active', trend_pullback: 'active', range_reversion: 'active', oversold_bounce: 'active' },
    guardrailHeadroom: { openPositionsRemaining: 2, totalRiskPctRemaining: 0.01 },
  };
}

test('buildDecisionPrompt returns a system string and a JSON-stringified user payload', () => {
  const { system, user } = buildDecisionPrompt(sampleInput());
  assert.equal(typeof system, 'string');
  assert.ok(system.length > 0);
  const parsed = JSON.parse(user); // must be valid JSON
  assert.equal(parsed.regime, 'trend_up');
});

test('the user payload includes every candidate id and its ranges, so Claude knows what it may propose', () => {
  const { user } = buildDecisionPrompt(sampleInput());
  const parsed = JSON.parse(user);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].id, 'c_20261118_10_SOL_trend_pullback');
  assert.deepEqual(parsed.candidates[0].ranges, { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] });
});

test('the user payload includes open positions and recent trades for context', () => {
  const { user } = buildDecisionPrompt(sampleInput());
  const parsed = JSON.parse(user);
  assert.equal(parsed.openPositions.length, 1);
  assert.equal(parsed.recentTrades.length, 1);
});

test('an empty candidates list still produces a valid prompt (position-management-only cycle)', () => {
  const input = { ...sampleInput(), candidates: [] };
  const { user } = buildDecisionPrompt(input);
  assert.deepEqual(JSON.parse(user).candidates, []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-decide-prompt.test.js`
Expected: FAIL — `Cannot find module '../src/engine/decide'`

- [ ] **Step 3: Implement**

Create `src/engine/decide.js`:

```js
'use strict';

const SYSTEM_PROMPT = `You are the hourly decision layer for a Kraken spot trading bot ("cryptodash").
For each candidate, choose "take" or "skip". If taking, you may resize (0-1x) and adjust stopAtr/trailAtr, but only within the "ranges" given for that candidate - values outside that range will be clamped, not honored as-is.
For open positions, you may tighten a stop (never loosen it) or close. You may disable a setup for the rest of the current regime via setupToggles.
Respond with strict JSON only, matching this shape:
{"decisions":[{"candidateId":"...","action":"take|skip","size":0.0,"stopAtr":0.0,"trailAtr":0.0,"reason":"...","plainReason":"..."}],
 "positionActions":[],"setupToggles":[],"marketNote":"...","plainNote":{"mood":"...","bullets":["..."],"botAction":"..."}}
Any field you omit for a "skip" decision may be left out. Do not include commentary outside the JSON.`;

function buildDecisionPrompt(input) {
  const user = JSON.stringify({
    regime: input.regime,
    regimeMetrics: input.regimeMetrics,
    candidates: input.candidates,
    openPositions: input.openPositions,
    recentTrades: input.recentTrades,
    setupConfig: input.setupConfig,
    guardrailHeadroom: input.guardrailHeadroom,
  });
  return { system: SYSTEM_PROMPT, user };
}

module.exports = { buildDecisionPrompt };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-decide-prompt.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/decide.js test/engine-decide-prompt.test.js
git commit -m "feat(engine): add buildDecisionPrompt (compact Claude input, one call per cycle)"
```

---

## Task 5: `engine/decide.js` — `parseDecisionResponse`

**Files:**
- Modify: `src/engine/decide.js`
- Test: `test/engine-decide-parse.test.js`

**Interfaces:**
- Produces: `parseDecisionResponse(rawText, { candidates, openPositions, setupNames })` → `{ decisions, positionActions, setupToggles, marketNote, plainNote, fallback }`. `candidates` is the same array passed to `buildDecisionPrompt` (used to look up each candidate's `ranges` for clamping, and to validate `candidateId`s). `openPositions` each have at least `{ coin, setup, currentStopPrice }` (used to validate "tighten only"). `setupNames` is an array of valid setup names (used to validate `setupToggles`). On any top-level failure, returns `{ decisions: [], positionActions: [], setupToggles: [], marketNote: '', plainNote: null, fallback: true, error }`.
- Consumed by: Part B's `runCycle` (not this plan).

- [ ] **Step 1: Write the failing tests**

Create `test/engine-decide-parse.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDecisionResponse } = require('../src/engine/decide');

function sampleCandidates() {
  return [{
    id: 'c_20261118_10_SOL_trend_pullback', coin: 'SOL', setup: 'trend_pullback',
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
  }];
}

test('a well-formed response with in-range values passes through unchanged', () => {
  const raw = JSON.stringify({
    decisions: [{ candidateId: 'c_20261118_10_SOL_trend_pullback', action: 'take', size: 0.5, stopAtr: 2.0, trailAtr: 2.5, reason: 'r', plainReason: 'p' }],
    positionActions: [], setupToggles: [], marketNote: 'note', plainNote: { mood: 'ok', bullets: [], botAction: 'x' },
  });
  const result = parseDecisionResponse(raw, { candidates: sampleCandidates(), openPositions: [], setupNames: ['trend_pullback'] });
  assert.equal(result.fallback, false);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].size, 0.5);
  assert.equal(result.decisions[0].stopAtr, 2.0);
});

test('an out-of-range stopAtr is clamped into range, not rejected', () => {
  const raw = JSON.stringify({
    decisions: [{ candidateId: 'c_20261118_10_SOL_trend_pullback', action: 'take', size: 0.5, stopAtr: 10.0, trailAtr: 2.5, reason: 'r', plainReason: 'p' }],
    positionActions: [], setupToggles: [], marketNote: '', plainNote: null,
  });
  const result = parseDecisionResponse(raw, { candidates: sampleCandidates(), openPositions: [], setupNames: ['trend_pullback'] });
  assert.equal(result.fallback, false);
  assert.equal(result.decisions[0].stopAtr, 3.0); // clamped to the range's max, not dropped
});

test('a decision referencing an unknown candidateId is dropped, the rest of the response still processed', () => {
  const raw = JSON.stringify({
    decisions: [
      { candidateId: 'c_does_not_exist', action: 'take', size: 1.0, stopAtr: 2.0, trailAtr: 2.5, reason: 'r', plainReason: 'p' },
      { candidateId: 'c_20261118_10_SOL_trend_pullback', action: 'skip', reason: 'r', plainReason: 'p' },
    ],
    positionActions: [], setupToggles: [], marketNote: '', plainNote: null,
  });
  const result = parseDecisionResponse(raw, { candidates: sampleCandidates(), openPositions: [], setupNames: ['trend_pullback'] });
  assert.equal(result.fallback, false);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].candidateId, 'c_20261118_10_SOL_trend_pullback');
});

test('a positionAction proposing a looser stop than the position currently has is dropped', () => {
  const raw = JSON.stringify({
    decisions: [], setupToggles: [], marketNote: '', plainNote: null,
    positionActions: [{ coin: 'BTC', setup: 'trend_breakout', action: 'tighten_stop', newStopPrice: 55000 }],
  });
  const result = parseDecisionResponse(raw, {
    candidates: [], openPositions: [{ coin: 'BTC', setup: 'trend_breakout', currentStopPrice: 58000 }], setupNames: [],
  });
  assert.equal(result.positionActions.length, 0); // 55000 < 58000 is looser (for a long), dropped
});

test('a positionAction proposing a tighter stop is kept', () => {
  const raw = JSON.stringify({
    decisions: [], setupToggles: [], marketNote: '', plainNote: null,
    positionActions: [{ coin: 'BTC', setup: 'trend_breakout', action: 'tighten_stop', newStopPrice: 59000 }],
  });
  const result = parseDecisionResponse(raw, {
    candidates: [], openPositions: [{ coin: 'BTC', setup: 'trend_breakout', currentStopPrice: 58000 }], setupNames: [],
  });
  assert.equal(result.positionActions.length, 1);
  assert.equal(result.positionActions[0].newStopPrice, 59000);
});

test('a positionAction with action "close" is always kept regardless of stop comparison', () => {
  const raw = JSON.stringify({
    decisions: [], setupToggles: [], marketNote: '', plainNote: null,
    positionActions: [{ coin: 'BTC', setup: 'trend_breakout', action: 'close' }],
  });
  const result = parseDecisionResponse(raw, {
    candidates: [], openPositions: [{ coin: 'BTC', setup: 'trend_breakout', currentStopPrice: 58000 }], setupNames: [],
  });
  assert.equal(result.positionActions.length, 1);
  assert.equal(result.positionActions[0].action, 'close');
});

test('a setupToggles entry naming an unknown setup is dropped', () => {
  const raw = JSON.stringify({
    decisions: [], positionActions: [], marketNote: '', plainNote: null,
    setupToggles: [{ setup: 'not_a_real_setup', action: 'disable_setup' }],
  });
  const result = parseDecisionResponse(raw, { candidates: [], openPositions: [], setupNames: ['trend_pullback'] });
  assert.equal(result.setupToggles.length, 0);
});

test('invalid JSON falls back to skip-all for the whole cycle', () => {
  const result = parseDecisionResponse('not json at all', { candidates: sampleCandidates(), openPositions: [], setupNames: [] });
  assert.equal(result.fallback, true);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.positionActions, []);
});

test('valid JSON but wrong top-level shape (decisions not an array) falls back to skip-all', () => {
  const raw = JSON.stringify({ decisions: 'take everything', positionActions: [], setupToggles: [] });
  const result = parseDecisionResponse(raw, { candidates: sampleCandidates(), openPositions: [], setupNames: [] });
  assert.equal(result.fallback, true);
  assert.deepEqual(result.decisions, []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-decide-parse.test.js`
Expected: FAIL — `parseDecisionResponse is not a function`

- [ ] **Step 3: Implement**

Append to `src/engine/decide.js`:

```js
function clamp(value, [min, max]) {
  return Math.min(Math.max(value, min), max);
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateTopLevelShape(parsed) {
  return isPlainObject(parsed)
    && Array.isArray(parsed.decisions)
    && Array.isArray(parsed.positionActions)
    && Array.isArray(parsed.setupToggles);
}

function sanitizeDecision(raw, candidatesById) {
  const candidate = candidatesById.get(raw.candidateId);
  if (!candidate) return null;
  if (raw.action !== 'take' && raw.action !== 'skip') return null;

  const decision = { candidateId: raw.candidateId, action: raw.action, reason: raw.reason || '', plainReason: raw.plainReason || '' };
  if (raw.action === 'take') {
    decision.size = clamp(typeof raw.size === 'number' ? raw.size : candidate.default.size, candidate.ranges.size);
    decision.stopAtr = clamp(typeof raw.stopAtr === 'number' ? raw.stopAtr : candidate.default.stopAtr, candidate.ranges.stopAtr);
    if (candidate.ranges.trailAtr) {
      decision.trailAtr = clamp(typeof raw.trailAtr === 'number' ? raw.trailAtr : candidate.default.trailAtr, candidate.ranges.trailAtr);
    }
  }
  return decision;
}

function sanitizePositionAction(raw, openPositionsByKey) {
  const position = openPositionsByKey.get(`${raw.coin}:${raw.setup}`);
  if (!position) return null;
  if (raw.action === 'close') return { coin: raw.coin, setup: raw.setup, action: 'close' };
  if (raw.action === 'tighten_stop' && typeof raw.newStopPrice === 'number') {
    // "Tighten only": a long's stop only ever moves up. A looser (lower) proposal is dropped, not clamped —
    // clamping to the current stop would silently turn a loosen attempt into a no-op positionAction, which
    // is indistinguishable from "Claude proposed exactly the current stop"; dropping it keeps the log honest.
    if (raw.newStopPrice > position.currentStopPrice) {
      return { coin: raw.coin, setup: raw.setup, action: 'tighten_stop', newStopPrice: raw.newStopPrice };
    }
    return null;
  }
  return null;
}

function sanitizeSetupToggle(raw, setupNameSet) {
  if (!setupNameSet.has(raw.setup)) return null;
  if (raw.action !== 'disable_setup') return null;
  return { setup: raw.setup, action: 'disable_setup' };
}

function fallbackResult(error) {
  return { decisions: [], positionActions: [], setupToggles: [], marketNote: '', plainNote: null, fallback: true, error };
}

function parseDecisionResponse(rawText, { candidates, openPositions, setupNames }) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return fallbackResult(`invalid JSON: ${err.message}`);
  }
  if (!validateTopLevelShape(parsed)) {
    return fallbackResult('response shape invalid: decisions/positionActions/setupToggles must be arrays');
  }

  const candidatesById = new Map(candidates.map((c) => [c.id, c]));
  const openPositionsByKey = new Map(openPositions.map((p) => [`${p.coin}:${p.setup}`, p]));
  const setupNameSet = new Set(setupNames);

  return {
    decisions: parsed.decisions.map((d) => sanitizeDecision(d, candidatesById)).filter(Boolean),
    positionActions: parsed.positionActions.map((p) => sanitizePositionAction(p, openPositionsByKey)).filter(Boolean),
    setupToggles: parsed.setupToggles.map((t) => sanitizeSetupToggle(t, setupNameSet)).filter(Boolean),
    marketNote: typeof parsed.marketNote === 'string' ? parsed.marketNote : '',
    plainNote: parsed.plainNote || null,
    fallback: false,
  };
}

module.exports = { buildDecisionPrompt, parseDecisionResponse };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-decide-parse.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS (all prior tests, plus these 9)

- [ ] **Step 6: Commit**

```bash
git add src/engine/decide.js test/engine-decide-parse.test.js
git commit -m "feat(engine): add parseDecisionResponse (schema validation, clamping, stop-tighten-only)"
```

---

## Task 6: `broker/shadow.js` — shadow outcome engine

**Files:**
- Create: `src/broker/shadow.js`
- Test: `test/broker-shadow.test.js`

**Interfaces:**
- Produces: `openShadowPosition(candidate)` → a shadow position object (same shape `tryOpenPosition` builds for a real position, minus guardrail/balance fields — sizing is nominal since R is unit-independent). `resolveShadowPositions(shadowPositions, coinData)` → `{ stillOpen, resolved }` where `resolved` entries carry `{ candidateId, exitTs, pnl, r, exitReason }`, ready for `updateCandidateShadow`.
- Consumes: `fillEntry`, `fillExit`, `evaluateExit` from `../broker/paper` (unchanged — reusing the exact exit logic real positions use, per this plan's Review Focus).
- Consumed by: Part B's `runCycle` (not this plan).

- [ ] **Step 1: Write the failing tests**

Create `test/broker-shadow.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openShadowPosition, resolveShadowPositions } = require('../src/broker/shadow');

function sampleCandidate() {
  return {
    id: 'c_20261118_10_SOL_trend_pullback', coin: 'SOL', setup: 'trend_pullback',
    entry: 100, atr: 5, exitType: 'trailing_stop',
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
  };
}

test('openShadowPosition builds a position using the default action, independent of what Claude decided', () => {
  const position = openShadowPosition(sampleCandidate());
  assert.equal(position.candidateId, 'c_20261118_10_SOL_trend_pullback');
  assert.equal(position.coin, 'SOL');
  assert.equal(position.exitType, 'trailing_stop');
  assert.equal(position.initialStopPrice, 100 - 1.5 * 5); // entry - stopAtr*atr, same formula tryOpenPosition uses
  assert.ok(position.units > 0);
  assert.ok(position.riskAmount > 0);
});

test('resolveShadowPositions closes a shadow position that hits its stop, using evaluateExit', () => {
  const position = openShadowPosition(sampleCandidate());
  const coinData = {
    SOL: {
      candles1h: [{ ts: 3600, high: 95, low: 90, close: 92 }], // breaches initialStopPrice of 92.5
      ema20By4hTs: new Map(),
    },
  };
  const { stillOpen, resolved } = resolveShadowPositions([{ ...position, entryTs: 0 }], coinData);
  assert.equal(stillOpen.length, 0);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].candidateId, 'c_20261118_10_SOL_trend_pullback');
  assert.equal(resolved[0].exitReason, 'stop');
  assert.ok(resolved[0].r < 0); // a stop-out is a losing trade
});

test('resolveShadowPositions keeps a position open if no 1h candle has arrived to check yet', () => {
  const position = openShadowPosition(sampleCandidate());
  const coinData = { SOL: { candles1h: [], ema20By4hTs: new Map() } };
  const { stillOpen, resolved } = resolveShadowPositions([{ ...position, entryTs: 0 }], coinData);
  assert.equal(stillOpen.length, 1);
  assert.equal(resolved.length, 0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/broker-shadow.test.js`
Expected: FAIL — `Cannot find module '../src/broker/shadow'`

- [ ] **Step 3: Implement**

Create `src/broker/shadow.js`:

```js
'use strict';
const { fillEntry, fillExit, evaluateExit } = require('./paper');

const NOMINAL_RISK_AMOUNT = 10; // arbitrary and unit-independent: R = pnl/riskAmount scales out regardless of this choice

function openShadowPosition(candidate) {
  const stopPrice = candidate.entry - candidate.default.stopAtr * candidate.atr;
  const stopDistance = candidate.entry - stopPrice;
  const units = NOMINAL_RISK_AMOUNT / stopDistance;
  const sizing = { stakeValue: units * candidate.entry, units, riskAmount: NOMINAL_RISK_AMOUNT };
  const fill = fillEntry({ candidate, sizing });

  return {
    candidateId: candidate.id, coin: candidate.coin, setup: candidate.setup,
    entryPrice: fill.fillPrice, units: sizing.units, riskAmount: sizing.riskAmount,
    initialStopPrice: stopPrice, atrAtEntry: candidate.atr,
    exitType: candidate.exitType, trailAtr: candidate.default.trailAtr,
    targetPrice: candidate.exitType === 'target_or_time' ? candidate.targetPrice : undefined,
    timeStopTs: candidate.timeStopTs,
    entryFee: fill.feeAmount,
  };
}

function resolveShadowPositions(shadowPositions, coinData) {
  const stillOpen = [];
  const resolved = [];

  for (const position of shadowPositions) {
    const data = coinData[position.coin];
    const exit = evaluateExit(position, { candles1h: data.candles1h, ema20By4hTs: data.ema20By4hTs });
    if (!exit) {
      stillOpen.push(position);
      continue;
    }
    const stakeValue = position.units * position.entryPrice;
    const fill = fillExit({ exitPrice: exit.exitPrice, stakeValue });
    const pnl = (fill.fillPrice - position.entryPrice) * position.units - position.entryFee - fill.feeAmount;
    const r = pnl / position.riskAmount;
    resolved.push({ candidateId: position.candidateId, exitTs: exit.exitTs, pnl, r, exitReason: exit.reason });
  }

  return { stillOpen, resolved };
}

module.exports = { openShadowPosition, resolveShadowPositions };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/broker-shadow.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS (all prior tests, plus these 3)

- [ ] **Step 6: Commit**

```bash
git add src/broker/shadow.js test/broker-shadow.test.js
git commit -m "feat(broker): add shadow-outcome engine (simulates default action using real exit logic)"
```

---

## Part A exit check

- [ ] `node --test test/` passes (all new tests green: 4 playbook-ranges assertions, 4 `engine-candidates` tests, 5 `candidates`/`decisions` DB tests, 4 `buildDecisionPrompt` tests, 9 `parseDecisionResponse` tests, 3 shadow-engine tests — 29 new tests total — plus every prior test unchanged).
- [ ] No real Claude call has been made or attempted — `callClaudeCli` doesn't exist yet; that's Part B.
- [ ] Nothing in this plan touches `runCycle` — `src/scheduler/cycle.js` is untouched by this plan; wiring candidates/decisions/shadow into the live cycle is Part B.
