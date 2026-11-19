# Decision Log API (Milestone 7, Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Express API endpoints the Decision log tab needs — `GET /api/decisions`, `GET /api/decisions/:cycleId`, `GET /api/scorecard` — plus the `trades`→`candidates` linkage those endpoints depend on, which doesn't exist yet. No UI in this part; Part B builds the tab against this API.

**Architecture:** A real trade currently has no link back to the candidate that produced it — `tryOpenPosition` never records `candidate.id` on the position it opens. Without that link, "the outcome (trade P&L or shadow P&L if skipped)" the Decision log's expanded view needs (design §8.3) is unanswerable for a `take` decision: there'd be no way to find which `trades` row belongs to which `candidates` row. Task 1 closes that gap with a `candidate_id` column threaded through `tryOpenPosition`→`closePosition`→`insertTrade`. Because `trades` already exists as a real table on the Pi (created in milestone 5, with live data in it), adding the column needs an `ALTER TABLE` migration — `CREATE TABLE IF NOT EXISTS` is silently a no-op against a table that already exists, so just adding the column to the schema string would work on fresh test databases while doing nothing to the real one. Tasks 2-5 build a small, password-gated Express app (`src/server/app.js`, a factory so tests can inject a `:memory:` db) and the three endpoints, each proven with real in-process HTTP requests (Node 20's global `fetch` against `app.listen(0)`'s ephemeral port) rather than route-handler unit tests in isolation — an endpoint's correctness is inseparable from its HTTP wiring (query parsing, status codes, JSON shape), so testing it through a real request is more honest than mocking Express away.

**Tech Stack:** Node.js 20 (built-in `fetch`, used as the test HTTP client), Express 4 (already a dependency from v1), `better-sqlite3`, `node --test`.

**Spec:** `docs/v2-design.md` §7 (database — `trades`/`candidates`/`decisions`), §8.3 (Decision log — scorecard, expanded view, filters), §8.4 ("every screen has a Paper / Live / Both filter" — this plan's `mode` handling), §8.7 ("the API listens only on the Pi's local network, with a single password from an env file"), §9 (API endpoint list). `CLAUDE.md`'s "no secrets in the repo or in Claude's context" (the dashboard password) and "every trade/order/decision is tagged paper or live."

**Depends on:** milestone 6 (`candidates`, `decisions`, `trades`, `cycle_log` tables and the live `runCycle` writing to them — already running on the Pi).

## Global Constraints

- Every endpoint must support filtering/scoping by `mode` (`paper`/`live`) — never mixing P&L or decision data across modes, per design §8.4's "every screen has a Paper / Live / Both filter."
- The dashboard password lives in the env file (`~/.config/cryptodash/env` / `process.env`, same precedence pattern `src/config/env.js` already uses for Kraken credentials) — never hardcoded, never logged.
- No ORM — `better-sqlite3` prepared statements only, consistent with every prior milestone.
- The new Express app is **not** named `server.js` yet — see Interpretation decisions.

## Interpretation decisions

- **The new Express app lives at `src/server/app.js` (a `createApp(db, options)` factory), launched by a new root file `dashboard.js` — not `server.js`.** CLAUDE.md's target layout wants the final `server.js` to be "Express API + scheduler," and says v1's `server.js` stays until "its v2 equivalent exists." This plan's API only covers one of milestone 7's three tabs — it isn't yet a full replacement for what v1's `server.js` serves, so claiming the `server.js` name now would be premature. The rename to `server.js` (and deletion of v1's file) happens once all three tabs exist, same reasoning that kept `scheduler.js` off the `server.js` name in milestone 5.
- **Auth is a simple shared-password header check (`X-Dashboard-Password`), not a session/cookie login flow.** Design §8.7 says "a single password from an env file" with no mention of sessions; a full login UI is Part B's concern (or later) once there's an actual page to gate. The header check is the minimal real thing this API needs today: every route requires it, returning `401` without a matching header. If no password is configured (local dev, no env file), the middleware allows all requests through and logs a one-line startup warning — refusing to serve at all without a password would make local development without `~/.config/cryptodash/env` impossible, which isn't this plan's intent to force.
- **`candidate_id` is migrated onto the existing `trades` table with a guarded `ALTER TABLE`, run every time `openDb()` opens a database** (checking `PRAGMA table_info` first, so it's a no-op on a database that already has the column — including every fresh `:memory:` test database, which gets the column from the `CREATE TABLE` string directly and never needs the `ALTER`). This is the only safe way to add a column to a table that's already live with real rows on the Pi.
- **The scorecard's "confidence range" is a 95% CI on mean R** (`mean ± 1.96 × standard error`) over the window's diverged decisions — design §8.3 says "a confidence range" without specifying the statistic; a standard CI on the R values already being tracked is the natural, defensible choice and needs no new data.
- **`cycleId` in `GET /api/decisions/:cycleId` is the cycle's `ts`** (the hourly UTC timestamp, matching `cycle_log.ts` — the natural unique key for "one row per hourly cycle" that design §8.3 describes), not a separate surrogate ID. There is no `cycle_snapshots` table (explicitly deferred in milestone 6's scope note), so this endpoint reconstructs a cycle's data from `cycle_log` + `candidates`/`decisions` filtered to that `ts`, not from a stored snapshot.

## Review Focus

- A request for `GET /api/decisions` with `mode` unspecified must not silently mix paper and live rows — design §8.4's "never mix" rule applies to a read endpoint just as much as to internal P&L math; the default must be an explicit single mode (`paper`), not "all modes with no filter."
- `GET /api/decisions/:cycleId` for a `ts` that has a `cycle_log` row but zero `candidates`/`decisions` at that `ts` (a genuine "no candidates this hour, no Claude call" cycle — the common case right now since the real market has been `risk_off`) must return a valid, well-shaped empty response, not a 404 or a crash — an empty decision list is real data, not an error.
- The scorecard must not count a `take` decision's shadow outcome twice if the shadow and the real trade happen to be identical in content (same setup defaults, Claude took exactly the default) — the comparison is always "real outcome vs shadow outcome," even when the two numbers come out equal, not "skip the comparison when they match."
- The password middleware must reject an *absent* header and a *wrong* header identically (`401`, no distinction in the response that would let someone learn whether they're close) — and must never log the configured password or the attempted one.
- A `diverged=true` filter on `GET /api/decisions` must use the stored `diverged` column (already computed and written by milestone 6's `runCycle`) rather than recomputing divergence at query time — recomputing would risk drifting from whatever logic actually ran when the decision was made, especially after future changes to that logic.

---

## Task 1: Link trades to their candidate (`candidate_id`)

**Files:**
- Modify: `src/data/db.js`
- Modify: `src/broker/paper.js`
- Test: `test/data-db-candidate-id-migration.test.js`
- Test: `test/broker-paper.test.js` (existing file — add assertions)

**Interfaces:**
- Produces: `trades` rows now carry `candidateId` (camelCase on read, via `getTrades`'s existing aliasing pattern). `tryOpenPosition`'s built position object gains `candidateId: candidate.id` (`undefined` for a candidate with no `id` — e.g. the backtest's candidates, which are never assigned one).
- Consumed by: Task 4's `GET /api/decisions/:cycleId` (joins a `take` decision's candidate to its real trade) and Task 5's scorecard (same join, aggregated).

- [ ] **Step 1: Write the failing migration test**

Create `test/data-db-candidate-id-migration.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb, insertTrade, getTrades } = require('../src/data/db');

test('openDb adds candidate_id to a pre-existing trades table that predates this column', () => {
  // Uses a shared temp FILE (not :memory:) so the "pre-existing table" and the "migrated" connection
  // are provably the same database — a :memory: db is always fresh and can't distinguish "migration
  // ran" from "the column was in CREATE TABLE all along," which is exactly the bug this test exists
  // to catch (the real Pi database already has a trades table from milestone 5, without this column).
  const tmpPath = path.join(os.tmpdir(), `cryptodash-migration-test-${Date.now()}.db`);

  const raw = new Database(tmpPath);
  raw.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL, coin TEXT NOT NULL, setup TEXT NOT NULL,
      entry_ts INTEGER NOT NULL, exit_ts INTEGER NOT NULL,
      entry_price REAL NOT NULL, exit_price REAL NOT NULL,
      units REAL NOT NULL, risk_amount REAL NOT NULL,
      pnl REAL NOT NULL, r REAL NOT NULL, exit_reason TEXT NOT NULL
    );
  `);
  raw.close();

  const migrated = openDb(tmpPath);
  const columns = migrated.prepare("PRAGMA table_info(trades)").all().map((c) => c.name);
  assert.ok(columns.includes('candidate_id'));

  migrated.close();
  fs.unlinkSync(tmpPath);
  if (fs.existsSync(`${tmpPath}-wal`)) fs.unlinkSync(`${tmpPath}-wal`);
  if (fs.existsSync(`${tmpPath}-shm`)) fs.unlinkSync(`${tmpPath}-shm`);
});

test('insertTrade accepts a candidateId and getTrades returns it back out', () => {
  const db = openDb(':memory:');
  insertTrade(db, {
    mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 0, exitTs: 3600,
    entryPrice: 100, exitPrice: 110, units: 1, riskAmount: 5, pnl: 10, r: 2, exitReason: 'target',
    candidateId: 'c_20261118_10_BTC_trend_pullback',
  });
  const trades = getTrades(db, 'paper');
  assert.equal(trades[0].candidateId, 'c_20261118_10_BTC_trend_pullback');
});

test('insertTrade with no candidateId stores null (backtest trades never had one)', () => {
  const db = openDb(':memory:');
  insertTrade(db, {
    mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 0, exitTs: 3600,
    entryPrice: 100, exitPrice: 110, units: 1, riskAmount: 5, pnl: 10, r: 2, exitReason: 'target',
  });
  const trades = getTrades(db, 'paper');
  assert.equal(trades[0].candidateId, null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-db-candidate-id-migration.test.js`
Expected: FAIL — the first test fails because `openDb` has no migration yet (the pre-existing `trades` table on the shared file has no `candidate_id` column, and `CREATE TABLE IF NOT EXISTS` doesn't touch it). The other two tests fail because `insertTrade`'s SQL doesn't accept a `candidateId`/`candidate_id` field at all yet.

- [ ] **Step 3: Implement the migration and threading**

In `src/data/db.js`, inside `openDb`, right after the existing `db.exec(\`...\`)` schema block (after all the `CREATE TABLE IF NOT EXISTS` statements), add:

```js
  const tradeColumns = db.prepare("PRAGMA table_info(trades)").all().map((c) => c.name);
  if (!tradeColumns.includes('candidate_id')) {
    db.exec('ALTER TABLE trades ADD COLUMN candidate_id TEXT');
  }
```

Update `insertTrade`:

```js
function insertTrade(db, trade) {
  db.prepare(`
    INSERT INTO trades (mode, coin, setup, entry_ts, exit_ts, entry_price, exit_price, units, risk_amount, pnl, r, exit_reason, candidate_id)
    VALUES (@mode, @coin, @setup, @entryTs, @exitTs, @entryPrice, @exitPrice, @units, @riskAmount, @pnl, @r, @exitReason, @candidateId)
  `).run({ candidateId: null, ...trade });
}
```

Update `getTrades`:

```js
function getTrades(db, mode) {
  return db.prepare(`
    SELECT id, mode, coin, setup,
      entry_ts AS entryTs, exit_ts AS exitTs,
      entry_price AS entryPrice, exit_price AS exitPrice,
      units, risk_amount AS riskAmount, pnl, r, exit_reason AS exitReason,
      candidate_id AS candidateId
    FROM trades WHERE mode = ? ORDER BY exit_ts ASC
  `).all(mode);
}
```

In `src/broker/paper.js`'s `tryOpenPosition`, add `candidateId: candidate.id` to the built `position` object (alongside the existing `coin`, `setup`, `entryTs`, etc. fields) — `closePosition`'s `state.closedTrades.push({ ...position, ... })` already spreads the whole position, so this flows through automatically with no change to `closePosition`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-db-candidate-id-migration.test.js test/broker-paper.test.js`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS (all tests unchanged elsewhere)

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js src/broker/paper.js test/data-db-candidate-id-migration.test.js test/broker-paper.test.js
git commit -m "feat(data): link trades to their originating candidate via candidate_id"
```

---

## Task 2: Express app skeleton with password middleware

**Files:**
- Create: `src/server/app.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `createApp(db, { password } = {})` → an Express `app`. Every route under `/api/*` requires header `X-Dashboard-Password` to match `password` (or, if `password` is falsy/undefined, allows all requests and the caller is expected to have logged a warning — this factory itself doesn't log; the root launcher does, per the Interpretation decision). A bare health route `GET /api/health` returns `{ ok: true }` and is itself gated by the same middleware (deliberately — "the API listens only on the Pi's local network, with a single password," design §8.7, doesn't carve out an exception for a health check).
- Consumed by: Tasks 3-5 (add routes to this same app) and the root launcher (Task 6).

- [ ] **Step 1: Write the failing tests**

Create `test/server-app.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/data/db');
const { createApp } = require('../src/server/app');

function startTestServer(password) {
  const db = openDb(':memory:');
  const app = createApp(db, { password });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port, db }));
  });
}

test('a request with the correct password header succeeds', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('a request with no password header is rejected with 401', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('a request with the wrong password header is rejected with 401, same as no header', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Dashboard-Password': 'wrong' } });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('with no password configured, every request is allowed through', async () => {
  const { server, port } = await startTestServer(undefined);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `Cannot find module '../src/server/app'`

- [ ] **Step 3: Implement**

Create `src/server/app.js`:

```js
'use strict';
const express = require('express');

function createApp(db, { password } = {}) {
  const app = express();
  app.use(express.json());

  app.use('/api', (req, res, next) => {
    if (!password) return next();
    const provided = req.get('X-Dashboard-Password');
    if (provided !== password) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  return app;
}

module.exports = { createApp };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/app.js test/server-app.test.js
git commit -m "feat(server): add Express app skeleton with password-gated /api routes"
```

---

## Task 3: `GET /api/decisions`

**Files:**
- Modify: `src/server/app.js`
- Modify: `src/data/db.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `getDecisionsFiltered(db, { mode, from, to, coin, setup, diverged })` in `src/data/db.js` (query-building, separate from the Express route so it's testable without HTTP — but the route itself is still proven over real HTTP in this task's tests, per this plan's stated testing philosophy; the split just avoids duplicating SQL-building logic if a future non-HTTP caller needs it). `GET /api/decisions?mode=&from=&to=&coin=&setup=&diverged=` → `200` with a JSON array of decisions, each joined with its candidate's `coin`/`setup`/`regime` (decisions already store `candidateId`, but not coin/setup directly — the join makes the response self-contained for a UI table row, per design §8.3's "timeline with one row per hourly cycle: time, regime, number of candidates, actions taken").

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:

```js
const { insertCandidate, insertDecision } = require('../src/data/db');

function seedCandidate(db, overrides = {}) {
  insertCandidate(db, {
    id: 'c_20261118_10_SOL_trend_pullback', ts: 1700000000, mode: 'paper', coin: 'SOL', setup: 'trend_pullback', regime: 'trend_up',
    entry: 98.40, atr: 3.10,
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
    context: { rsi14: 47.2, adx4h: 26.1 },
    ...overrides,
  });
}

function seedDecision(db, overrides = {}) {
  insertDecision(db, {
    candidateId: 'c_20261118_10_SOL_trend_pullback', ts: 1700000000, mode: 'paper', action: 'take',
    size: 1.0, stopAtr: 1.5, trailAtr: 2.5, reason: 'r', plainReason: 'p',
    defaultAction: 'take', diverged: false, model: 'claude-sonnet-5', latencyMs: 1200, rawResponse: '{}',
    ...overrides,
  });
}

test('GET /api/decisions returns decisions for the default mode (paper), joined with coin/setup/regime', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db);
    seedDecision(db);
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].coin, 'SOL');
    assert.equal(body[0].setup, 'trend_pullback');
    assert.equal(body[0].regime, 'trend_up');
    assert.equal(body[0].action, 'take');
  } finally {
    server.close();
  }
});

test('GET /api/decisions does not mix modes when mode is unspecified (defaults to paper)', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { id: 'c_live_1' });
    seedDecision(db, { candidateId: 'c_live_1', mode: 'live' });
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.length, 0); // the 'live' decision must not appear under the implicit paper default
  } finally {
    server.close();
  }
});

test('GET /api/decisions?diverged=true filters to the stored diverged column', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { id: 'c_a' });
    seedCandidate(db, { id: 'c_b' });
    seedDecision(db, { candidateId: 'c_a', diverged: false });
    seedDecision(db, { candidateId: 'c_b', diverged: true });
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions?diverged=true`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].candidateId, 'c_b');
  } finally {
    server.close();
  }
});

test('GET /api/decisions?coin=&setup= filters correctly', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { id: 'c_sol', coin: 'SOL' });
    seedCandidate(db, { id: 'c_btc', coin: 'BTC' });
    seedDecision(db, { candidateId: 'c_sol' });
    seedDecision(db, { candidateId: 'c_btc' });
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions?coin=BTC`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].coin, 'BTC');
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` (no such route) for all 4 new tests.

- [ ] **Step 3: Implement**

In `src/data/db.js`, add:

```js
function getDecisionsFiltered(db, { mode = 'paper', from, to, coin, setup, diverged } = {}) {
  const clauses = ['d.mode = @mode'];
  const params = { mode };
  if (from !== undefined) { clauses.push('d.ts >= @from'); params.from = from; }
  if (to !== undefined) { clauses.push('d.ts <= @to'); params.to = to; }
  if (coin !== undefined) { clauses.push('c.coin = @coin'); params.coin = coin; }
  if (setup !== undefined) { clauses.push('c.setup = @setup'); params.setup = setup; }
  if (diverged !== undefined) { clauses.push('d.diverged = @diverged'); params.diverged = diverged ? 1 : 0; }

  return db.prepare(`
    SELECT d.candidate_id AS candidateId, d.ts, d.mode, d.action,
      d.size, d.stop_atr AS stopAtr, d.trail_atr AS trailAtr,
      d.reason, d.plain_reason AS plainReason, d.default_action AS defaultAction,
      d.diverged, d.model, d.latency_ms AS latencyMs,
      c.coin, c.setup, c.regime
    FROM decisions d JOIN candidates c ON c.id = d.candidate_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY d.ts DESC
  `).all(params).map((row) => ({ ...row, diverged: !!row.diverged }));
}
```

Add `getDecisionsFiltered` to `module.exports`.

In `src/server/app.js`, add the route (after the existing `/api/health` route, before `return app;`):

```js
  const { getDecisionsFiltered } = require('../data/db');

  app.get('/api/decisions', (req, res) => {
    const { mode, from, to, coin, setup, diverged } = req.query;
    const rows = getDecisionsFiltered(db, {
      mode: mode || 'paper',
      from: from !== undefined ? Number(from) : undefined,
      to: to !== undefined ? Number(to) : undefined,
      coin, setup,
      diverged: diverged !== undefined ? diverged === 'true' : undefined,
    });
    res.json(rows);
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS (all tests, including Task 2's 4 and this task's 4 new ones)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/app.js src/data/db.js test/server-app.test.js
git commit -m "feat(server): add GET /api/decisions (filterable, mode-scoped, joined with candidate)"
```

---

## Task 4: `GET /api/decisions/:cycleId`

**Files:**
- Modify: `src/server/app.js`
- Modify: `src/data/db.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `getCycleLogByTs(db, mode, ts)` and `getCandidatesByTs(db, mode, ts)` in `src/data/db.js`. `GET /api/decisions/:cycleId?mode=paper` → `200` with `{ cycle, candidates }` where `cycle` is the `cycle_log` row (or `null` if that `ts` has no cycle at all — a real 404 case, distinct from "a cycle ran but had zero candidates") and `candidates` is an array of `{ ...candidate fields, decision, trade }` — `decision` is that candidate's `decisions` row (or `null`, e.g. if the cycle itself fell back before any decision was recorded... though milestone 6's `runCycle` does write a `skip`/`fallback` decision row for every candidate even on fallback, so `null` here should be rare but is handled, not assumed impossible) and `trade` is the real `trades` row joined by `candidate_id` (or `null` if the candidate was never taken, in which case its shadow outcome — already present on the candidate's own `shadow_*` fields — is the only outcome available).

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:

```js
const { insertCycleLog, insertTrade } = require('../src/data/db');

test('GET /api/decisions/:cycleId returns the cycle_log row plus its candidates, decisions, and linked trades', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1700000000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 500 });
    seedCandidate(db);
    seedDecision(db);
    insertTrade(db, {
      mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: 1700000000, exitTs: 1700050000,
      entryPrice: 98.40, exitPrice: 102.0, units: 1, riskAmount: 5, pnl: 3.6, r: 0.72, exitReason: 'target',
      candidateId: 'c_20261118_10_SOL_trend_pullback',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/decisions/1700000000`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cycle.regimeLabel, 'trend_up');
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].decision.action, 'take');
    assert.equal(body.candidates[0].trade.r, 0.72);
  } finally {
    server.close();
  }
});

test('GET /api/decisions/:cycleId for a cycle with zero candidates returns an empty array, not an error', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1700003600, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 200 });
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions/1700003600`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cycle.regimeLabel, 'risk_off');
    assert.deepEqual(body.candidates, []);
  } finally {
    server.close();
  }
});

test('GET /api/decisions/:cycleId for a ts with no cycle_log row at all returns 404', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions/9999999999`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` for all 3 (no such route yet; the third test's "expected 404" would coincidentally match Express's own no-route 404, so check its failure is actually about the route not existing, not a false pass — the first two tests, which expect `200`, make this unambiguous).

- [ ] **Step 3: Implement**

In `src/data/db.js`, add:

```js
function getCycleLogByTs(db, mode, ts) {
  return db.prepare(`
    SELECT ts, mode, regime_label AS regimeLabel, candidates_count AS candidatesCount,
      opened_count AS openedCount, closed_count AS closedCount, duration_ms AS durationMs, error
    FROM cycle_log WHERE mode = ? AND ts = ?
  `).get(mode, ts) || null;
}

function getCandidatesByTs(db, mode, ts) {
  return db.prepare('SELECT * FROM candidates WHERE mode = ? AND ts = ?').all(mode, ts).map(rowToCandidate);
}

function getTradeByCandidateId(db, candidateId) {
  const row = db.prepare(`
    SELECT id, mode, coin, setup, entry_ts AS entryTs, exit_ts AS exitTs,
      entry_price AS entryPrice, exit_price AS exitPrice, units, risk_amount AS riskAmount,
      pnl, r, exit_reason AS exitReason, candidate_id AS candidateId
    FROM trades WHERE candidate_id = ?
  `).get(candidateId);
  return row || null;
}

function getDecisionByCandidateId(db, candidateId) {
  const row = db.prepare(`
    SELECT candidate_id AS candidateId, ts, mode, action, size, stop_atr AS stopAtr, trail_atr AS trailAtr,
      reason, plain_reason AS plainReason, default_action AS defaultAction, diverged, model, latency_ms AS latencyMs
    FROM decisions WHERE candidate_id = ?
  `).get(candidateId);
  return row ? { ...row, diverged: !!row.diverged } : null;
}
```

Add all four to `module.exports`.

In `src/server/app.js`, add the route:

```js
  const { getCycleLogByTs, getCandidatesByTs, getTradeByCandidateId, getDecisionByCandidateId } = require('../data/db');

  app.get('/api/decisions/:cycleId', (req, res) => {
    const ts = Number(req.params.cycleId);
    const mode = req.query.mode || 'paper';
    const cycle = getCycleLogByTs(db, mode, ts);
    if (!cycle) return res.status(404).json({ error: 'no cycle at that ts' });

    const candidates = getCandidatesByTs(db, mode, ts).map((candidate) => ({
      ...candidate,
      decision: getDecisionByCandidateId(db, candidate.id),
      trade: getTradeByCandidateId(db, candidate.id),
    }));

    res.json({ cycle, candidates });
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/app.js src/data/db.js test/server-app.test.js
git commit -m "feat(server): add GET /api/decisions/:cycleId (expanded cycle view)"
```

---

## Task 5: `GET /api/scorecard`

**Files:**
- Modify: `src/server/app.js`
- Modify: `src/data/db.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `getScorecardData(db, mode, sinceTs)` in `src/data/db.js` — returns every candidate at or after `sinceTs` for `mode` whose `shadow_status = 'resolved'`, joined with its decision (if any) and trade (if any). `GET /api/scorecard?days=30&mode=paper` → `200` with `{ days, divergedCount, notEnoughData, claudeMeanR, defaultMeanR, confidenceRange: [low, high] }`. `notEnoughData` is `true` when `divergedCount < 100` (design §8.3: "reads 'not enough data yet' until about 100 overrides").

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:

```js
test('GET /api/scorecard reports notEnoughData when fewer than 100 diverged decisions exist', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db);
    seedDecision(db, { diverged: true });
    updateCandidateShadowForTest(db, 'c_20261118_10_SOL_trend_pullback', { status: 'resolved', exitTs: 1700050000, pnl: 5, r: 1.0, exitReason: 'target' });

    const res = await fetch(`http://127.0.0.1:${port}/api/scorecard?days=30`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.notEnoughData, true);
    assert.equal(body.divergedCount, 1);
  } finally {
    server.close();
  }
});

test('GET /api/scorecard compares real R (for a taken, diverged decision) against the shadow R', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db);
    seedDecision(db, { diverged: true, action: 'take' });
    updateCandidateShadowForTest(db, 'c_20261118_10_SOL_trend_pullback', { status: 'resolved', exitTs: 1700050000, pnl: 5, r: 1.0, exitReason: 'target' });
    insertTrade(db, {
      mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: 1700000000, exitTs: 1700050000,
      entryPrice: 98.40, exitPrice: 102.0, units: 0.5, riskAmount: 2.5, pnl: 1.8, r: 0.72, exitReason: 'target',
      candidateId: 'c_20261118_10_SOL_trend_pullback',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/scorecard?days=30`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.claudeMeanR, 0.72); // the real trade's R (Claude resized to 0.5x, taken)
    assert.equal(body.defaultMeanR, 1.0); // the shadow's R (what the untouched default would have made)
  } finally {
    server.close();
  }
});
```

Add this small test helper near the top of `test/server-app.test.js` (alongside `seedCandidate`/`seedDecision` — `updateCandidateShadow` is already exported from `src/data/db.js` since milestone 6):

```js
const { updateCandidateShadow: updateCandidateShadowForTest } = require('../src/data/db');
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` (no such route yet)

- [ ] **Step 3: Implement**

In `src/data/db.js`, add:

```js
function getScorecardData(db, mode, sinceTs) {
  return db.prepare(`
    SELECT c.id AS candidateId, c.shadow_r AS shadowR,
      d.diverged, d.action AS decisionAction,
      t.r AS tradeR
    FROM candidates c
    LEFT JOIN decisions d ON d.candidate_id = c.id
    LEFT JOIN trades t ON t.candidate_id = c.id
    WHERE c.mode = ? AND c.ts >= ? AND c.shadow_status = 'resolved'
  `).all(mode, sinceTs).map((row) => ({ ...row, diverged: !!row.diverged }));
}
```

Add `getScorecardData` to `module.exports`.

In `src/server/app.js`, add:

```js
  const { getScorecardData } = require('../data/db');

  app.get('/api/scorecard', (req, res) => {
    const days = Number(req.query.days) || 30;
    const mode = req.query.mode || 'paper';
    const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = getScorecardData(db, mode, sinceTs);

    const diverged = rows.filter((r) => r.diverged);
    const claudeRs = diverged.filter((r) => r.decisionAction === 'take' && r.tradeR !== null).map((r) => r.tradeR);
    const defaultRs = diverged.map((r) => r.shadowR).filter((r) => r !== null);

    const mean = (arr) => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length);
    const stderr = (arr) => {
      if (arr.length < 2) return 0;
      const m = mean(arr);
      const variance = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1);
      return Math.sqrt(variance / arr.length);
    };

    const claudeMeanR = mean(claudeRs);
    const se = stderr(claudeRs);

    res.json({
      days, divergedCount: diverged.length, notEnoughData: diverged.length < 100,
      claudeMeanR, defaultMeanR: mean(defaultRs),
      confidenceRange: [claudeMeanR - 1.96 * se, claudeMeanR + 1.96 * se],
    });
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/app.js src/data/db.js test/server-app.test.js
git commit -m "feat(server): add GET /api/scorecard (Claude vs default R comparison)"
```

---

## Task 6: Root launcher and real-run proof

**Files:**
- Create: `dashboard.js` (repo root)

**Interfaces:**
- Produces: a runnable entrypoint, `node dashboard.js`, that opens the real DB, loads the dashboard password via the same precedence pattern `src/config/env.js` uses for Kraken credentials, and listens on `127.0.0.1:3000` (design §8.7: "The Node app listens on `127.0.0.1:3000` only").

- [ ] **Step 1: Add a password loader to `src/config/env.js`**

In `src/config/env.js`, add (same pattern as `getKrakenCredentials`):

```js
function getDashboardPassword(filePath) {
  if (process.env.DASHBOARD_PASSWORD) return process.env.DASHBOARD_PASSWORD;
  const resolvedPath = filePath || process.env.CRYPTODASH_ENV_FILE || DEFAULT_PATH;
  return loadEnvFile(resolvedPath).DASHBOARD_PASSWORD;
}
```

Add `getDashboardPassword` to `module.exports`.

- [ ] **Step 2: Write `dashboard.js`**

Create `dashboard.js`:

```js
'use strict';
const { openDb } = require('./src/data/db');
const { getDashboardPassword } = require('./src/config/env');
const { createApp } = require('./src/server/app');

const db = openDb();
const password = getDashboardPassword();
if (!password) {
  console.warn('WARNING: no DASHBOARD_PASSWORD configured — the API is unauthenticated. Set it in ~/.config/cryptodash/env before exposing this beyond localhost.');
}

const app = createApp(db, { password });
app.listen(3000, '127.0.0.1', () => {
  console.log('Dashboard API listening on http://127.0.0.1:3000 (decisions endpoints only — Charts/Strategy tabs are later milestone-7 parts)');
});
```

- [ ] **Step 3: Prove it with a real run**

Run (in the background briefly, then verify with curl, then stop it):

```bash
timeout 5 node dashboard.js &
sleep 1
curl -s http://127.0.0.1:3000/api/decisions | head -c 200
echo
wait
```
Expected: the warning line about no `DASHBOARD_PASSWORD` (unless one is actually configured in `~/.config/cryptodash/env` on this machine, in which case add the header: `curl -s -H "X-Dashboard-Password: <the real password>" http://127.0.0.1:3000/api/decisions`), followed by a JSON array response (likely `[]`, since the real market has had very few candidates — an empty array is a correct, successful response, not a failure).

- [ ] **Step 4: Confirm the real cycle_log/candidates data is reachable end-to-end**

Run: `curl -s http://127.0.0.1:3000/api/decisions/<a-real-ts-from-cycle_log>` (pick a `ts` from `sqlite3 data/cryptodash-v2.db "SELECT ts FROM cycle_log ORDER BY ts DESC LIMIT 1;"`, with the password header if one is configured), confirming it returns `200` with a `cycle` object matching that row (not a 404) — this proves the whole chain (real DB file → `getCycleLogByTs` → Express route → HTTP response) works against the actual data this session's milestone 5/6 work produced, not just the seeded test fixtures.

- [ ] **Step 5: Commit**

```bash
git add dashboard.js src/config/env.js
git commit -m "feat(server): add dashboard.js root launcher (127.0.0.1:3000, password-gated)"
```

---

## Part A exit check

- [ ] `node --test test/` passes (all new tests green: 3 migration/linkage tests, 4 app-skeleton tests, 4 decisions-list tests, 3 expanded-cycle tests, 2 scorecard tests — 16 new tests total — plus every prior test unchanged).
- [ ] `dashboard.js` has been run for real and its endpoints confirmed against the actual Pi database (Task 6 Steps 3-4), not just `:memory:` fixtures.
- [ ] No UI exists yet — Part B builds the Decision log tab against this API. `server.js` (v1) is untouched; the new app is `dashboard.js`/`src/server/app.js` until all three milestone-7 tabs exist.
