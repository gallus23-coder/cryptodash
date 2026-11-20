# Config Versioning API (Milestone 8, Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the manual config-editing half of milestone 8: a `config_versions` table, and the draft → backtest → submit → approve/reject flow (design §8.2, §9). This is also what milestone 7's Strategy tab deferred ("Strategy controls") and gives a real mechanism for finally acting on the milestone-4 "revisit later" deferral on `trend_breakout`/`oversold_bounce` — through config versioning, not a code edit. The automated weekly Claude-driven review (design §5.5) is a separate, later part, deliberately deferred since there's essentially no real trade data yet for it to learn from.

**Architecture:** A draft is `{ riskLevel, disabledSetups, rangeOverrides }` — exactly the three editable things design §8.2 lists (risk level, per-setup on/off, stop/trail ranges) minus guardrail-cap editing (explicitly "only editable in Settings," which doesn't exist). "Backtest changes... deterministic, no Claude" (§8.2) means the draft's backtest only needs to vary what a *deterministic* backtest run actually uses: `riskLevel` (scales `baseRiskPct`/`maxOpenPositions`) and `disabledSetups` (removes entries from `SETUPS_BY_REGIME`) change what `runBacktest` produces; `rangeOverrides` do not — ranges only constrain what Claude may propose in a live/paper cycle, and the backtest never calls Claude, so a range edit has no effect on a 90-day deterministic replay. This isn't a shortcut; it's what the design's own "no Claude" framing implies. `runBacktest` gets one small, backward-compatible addition (an optional `setupsByRegime` parameter) rather than a parallel implementation, keeping "backtest and live run identical engine code" intact for the parts of the engine a draft can actually change. **This plan does not wire an approved config into the live `runCycle`** — see Interpretation decisions for why that's a deliberately separate follow-up, not an oversight.

**Tech Stack:** Express (existing API), `better-sqlite3`, `node --test` with real in-process HTTP requests.

**Spec:** `docs/v2-design.md` §8.2 (Strategy controls — risk level, setup toggles, range edits, backtest-then-pending flow), §7 (`config_versions` table), §9 (`POST /api/config/draft`, `/draft/backtest`, `/draft/submit`, `GET /api/config/pending`, `POST /api/config/:version/approve|reject`).

**Depends on:** milestone 4 (`runBacktest`, `computeExpectancy`), milestone 7 Part E (`DEFAULT_RISK_CONFIG`, `SETUPS`/`SETUPS_BY_REGIME`, the Strategy API's `RANGES` exports).

## Global Constraints

- No ORM — `better-sqlite3` prepared statements only.
- A draft never touches guardrail caps (`maxTotalRiskPct`, `maxCoinExposurePct`, `maxTotalExposurePct`, `dailyLossLimitPct`, `weeklyKillSwitchPct`, cooldowns) — design explicitly reserves those for a Settings screen that doesn't exist yet.
- Every config-version row is scoped by `mode` (`paper`/`live`), same discipline as every other table this session.

## Interpretation decisions

- **Risk level scaling: `cautious` = 0.5× `baseRiskPct`, `maxOpenPositions` reduced by 1 (floor 1) — a genuine, safe reduction needing no new validation. `normal` = `DEFAULT_RISK_CONFIG` unchanged. `bold` is currently a documented no-op, identical to `normal`.** Design says risk level "scales stake and max positions, always within the guardrail caps" — but `DEFAULT_RISK_CONFIG`'s existing values (`maxOpenPositions: 3`, `maxTotalRiskPct: 0.015`, etc.) are *already* the enforced guardrail ceiling in this codebase (`checkGuardrails` uses them directly as hard limits), not a separate "normal setting" sitting below a higher cap. Scaling `bold` *up* would mean inventing new, larger risk numbers nobody has backtested or asked for — a real live-trading-safety decision this plan isn't positioned to make unilaterally. Scaling `cautious` *down* is safe by construction (it only ever reduces exposure) and needs no new validation, so it's built for real. `bold` is left as a named, selectable, но functionally-identical-to-`normal` option, with this exact limitation documented in the API response (`note` field) so the UI (Part B) can say so honestly rather than imply a feature that doesn't exist. A future milestone that wants a real "bold" needs someone to pick and validate actual larger numbers — that's a deliberate decision for a human, not an inference this plan should make.
- **`rangeOverrides` are stored and returned, but do not affect `POST /api/config/draft/backtest`'s result** — see Architecture. The backtest response includes a note making this explicit, so approving a draft whose backtest only reflects `riskLevel`/`disabledSetups` doesn't look like the system silently ignored the range edits; it's telling the approver exactly what was and wasn't tested.
- **Approving a config version does not change what `runCycle` does.** Wiring `runCycle` to read the active `config_versions` row (instead of the hardcoded `DEFAULT_RISK_CONFIG`/`SETUPS_BY_REGIME` imports) is real, separate integration work — it means `runCycle` resolving a config every cycle instead of importing a constant, a change to the live scheduler that deserves its own task and its own real-run proof on the Pi, not a late addition folded into this already-large plan. This plan builds the full draft→backtest→submit→approve mechanism and makes it durable and correct; a follow-up part makes an approved version actually govern live trading.
- **Only one `pending` version exists at a time per mode** — submitting a new draft while one is already pending supersedes it (the old pending row's status becomes `superseded`), rather than stacking multiple pending proposals design never describes a UI for.
- **If no `config_versions` row has ever been marked `active` for a mode** (true for every real mode today — this plan is the first thing that ever writes to this table), `GET /api/config/pending`'s "active" side is a synthetic default (`{riskLevel: 'normal', disabledSetups: [], rangeOverrides: {}}`, `id: null`) representing "today's hardcoded defaults, never formally versioned" — not an error, not a fabricated DB row.

## Review Focus

- A draft naming a setup that isn't one of the four real setups (`trendBreakout`/`trendPullback`/`rangeReversion`/`oversoldBounce`'s registered names) in `disabledSetups` must be rejected (`400`), not silently accepted and silently ignored later — a typo'd setup name should surface immediately, not produce a draft that looks accepted but changes nothing.
- `POST /api/config/draft/backtest` must actually produce a *different* result when a setup is disabled versus not — not run the exact same backtest regardless of the draft's content (this would be the "a configuration flag that doesn't do anything" failure mode).
- Submitting a second draft while one is already pending must supersede the first, not create two simultaneously-pending rows that `GET /api/config/pending` would have to arbitrarily choose between.
- Approving a pending version must demote the previously-active version (if a real DB row exists) to `superseded`, never leaving two rows simultaneously marked `active` for the same mode.
- Rejecting a version must be a dead end (status `rejected`, no further transition) — approving or rejecting a version that's already been decided (not `pending`) must be a `409`, not silently re-apply.

---

## Task 1: `config_versions` table and version-management functions

**Files:**
- Modify: `src/data/db.js`
- Test: `test/data-db-config-versions.test.js`

**Interfaces:**
- Produces: `insertConfigVersion(db, { mode, configJson, backtestJson })` → the new row's `id` (status always starts `pending`). `getActiveConfigVersion(db, mode)` → the real active row, or the synthetic default if none exists. `getPendingConfigVersion(db, mode)` → the real pending row, or `null`. `approveConfigVersion(db, mode, id)` → demotes the old active row (if real) to `superseded`, promotes `id` to `active`; throws if `id` isn't currently `pending` for that mode. `rejectConfigVersion(db, mode, id)` → sets status to `rejected`; throws if `id` isn't currently `pending`. `supersedePendingConfigVersions(db, mode)` → sets every current `pending` row for that mode to `superseded` (used right before inserting a new one, enforcing "only one pending at a time").

- [ ] **Step 1: Write the failing tests**

Create `test/data-db-config-versions.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  openDb, insertConfigVersion, getActiveConfigVersion, getPendingConfigVersion,
  approveConfigVersion, rejectConfigVersion, supersedePendingConfigVersions,
} = require('../src/data/db');

function sampleConfigJson(overrides = {}) {
  return { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {}, ...overrides };
}

test('getActiveConfigVersion returns a synthetic default when nothing has ever been marked active', () => {
  const db = openDb(':memory:');
  const active = getActiveConfigVersion(db, 'paper');
  assert.equal(active.id, null);
  assert.equal(active.config.riskLevel, 'normal');
  assert.deepEqual(active.config.disabledSetups, []);
});

test('insertConfigVersion creates a pending row; getPendingConfigVersion finds it', () => {
  const db = openDb(':memory:');
  const id = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'cautious' }), backtestJson: { summary: 'x' } });
  const pending = getPendingConfigVersion(db, 'paper');
  assert.equal(pending.id, id);
  assert.equal(pending.config.riskLevel, 'cautious');
  assert.equal(pending.status, 'pending');
});

test('submitting a second draft supersedes the first pending one', () => {
  const db = openDb(':memory:');
  const firstId = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'cautious' }), backtestJson: {} });
  supersedePendingConfigVersions(db, 'paper');
  const secondId = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'normal' }), backtestJson: {} });

  const pending = getPendingConfigVersion(db, 'paper');
  assert.equal(pending.id, secondId);
  assert.notEqual(firstId, secondId);
});

test('approveConfigVersion promotes a pending version to active and demotes the previous active one', () => {
  const db = openDb(':memory:');
  const firstId = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'cautious' }), backtestJson: {} });
  approveConfigVersion(db, 'paper', firstId);

  const secondId = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'normal' }), backtestJson: {} });
  approveConfigVersion(db, 'paper', secondId);

  const active = getActiveConfigVersion(db, 'paper');
  assert.equal(active.id, secondId);
  assert.equal(getPendingConfigVersion(db, 'paper'), null);
});

test('approveConfigVersion throws if the version is not currently pending', () => {
  const db = openDb(':memory:');
  const id = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson(), backtestJson: {} });
  approveConfigVersion(db, 'paper', id);
  assert.throws(() => approveConfigVersion(db, 'paper', id));
});

test('rejectConfigVersion sets status to rejected and is a dead end', () => {
  const db = openDb(':memory:');
  const id = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson(), backtestJson: {} });
  rejectConfigVersion(db, 'paper', id);
  assert.equal(getPendingConfigVersion(db, 'paper'), null);
  assert.throws(() => approveConfigVersion(db, 'paper', id));
  assert.throws(() => rejectConfigVersion(db, 'paper', id));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-db-config-versions.test.js`
Expected: FAIL — `insertConfigVersion is not a function`

- [ ] **Step 3: Implement**

In `src/data/db.js`, add to the schema inside `openDb` (alongside the other `CREATE TABLE IF NOT EXISTS` statements):

```js
    CREATE TABLE IF NOT EXISTS config_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      config_json TEXT NOT NULL, backtest_json TEXT,
      created_ts INTEGER NOT NULL, decided_ts INTEGER
    );
```

Add:

```js
const DEFAULT_CONFIG_VERSION = { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} };

function rowToConfigVersion(row) {
  if (!row) return null;
  return {
    id: row.id, mode: row.mode, status: row.status,
    config: JSON.parse(row.config_json),
    backtest: row.backtest_json ? JSON.parse(row.backtest_json) : null,
    createdTs: row.created_ts, decidedTs: row.decided_ts,
  };
}

function insertConfigVersion(db, { mode, configJson, backtestJson }) {
  const result = db.prepare(`
    INSERT INTO config_versions (mode, status, config_json, backtest_json, created_ts)
    VALUES (@mode, 'pending', @configJson, @backtestJson, @createdTs)
  `).run({
    mode, configJson: JSON.stringify(configJson), backtestJson: JSON.stringify(backtestJson), createdTs: Date.now(),
  });
  return result.lastInsertRowid;
}

function getActiveConfigVersion(db, mode) {
  const row = db.prepare("SELECT * FROM config_versions WHERE mode = ? AND status = 'active' ORDER BY decided_ts DESC LIMIT 1").get(mode);
  if (row) return rowToConfigVersion(row);
  return { id: null, mode, status: 'active', config: DEFAULT_CONFIG_VERSION, backtest: null, createdTs: null, decidedTs: null };
}

function getPendingConfigVersion(db, mode) {
  const row = db.prepare("SELECT * FROM config_versions WHERE mode = ? AND status = 'pending' ORDER BY created_ts DESC LIMIT 1").get(mode);
  return rowToConfigVersion(row);
}

function supersedePendingConfigVersions(db, mode) {
  db.prepare("UPDATE config_versions SET status = 'superseded' WHERE mode = ? AND status = 'pending'").run(mode);
}

function approveConfigVersion(db, mode, id) {
  const row = db.prepare('SELECT * FROM config_versions WHERE id = ? AND mode = ?').get(id, mode);
  if (!row || row.status !== 'pending') throw new Error(`config version ${id} is not pending`);
  db.transaction(() => {
    db.prepare("UPDATE config_versions SET status = 'superseded' WHERE mode = ? AND status = 'active'").run(mode);
    db.prepare("UPDATE config_versions SET status = 'active', decided_ts = ? WHERE id = ?").run(Date.now(), id);
  })();
}

function rejectConfigVersion(db, mode, id) {
  const row = db.prepare('SELECT * FROM config_versions WHERE id = ? AND mode = ?').get(id, mode);
  if (!row || row.status !== 'pending') throw new Error(`config version ${id} is not pending`);
  db.prepare("UPDATE config_versions SET status = 'rejected', decided_ts = ? WHERE id = ?").run(Date.now(), id);
}
```

Add all six new functions to `module.exports`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-db-config-versions.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js test/data-db-config-versions.test.js
git commit -m "feat(data): add config_versions table and version lifecycle functions"
```

---

## Task 2: Risk-level scaling

**Files:**
- Modify: `src/engine/config.js`
- Test: `test/engine-config.test.js`

**Interfaces:**
- Produces: `applyRiskLevel(baseConfig, riskLevel)` → a new config object with `baseRiskPct`/`maxOpenPositions` adjusted for `cautious`, unchanged for `normal`/`bold`. Throws on an unrecognized `riskLevel`.

- [ ] **Step 1: Write the failing tests**

Add to `test/engine-config.test.js`:

```js
const { applyRiskLevel } = require('../src/engine/config');

test('applyRiskLevel("cautious") halves baseRiskPct and reduces maxOpenPositions by 1', () => {
  const scaled = applyRiskLevel(DEFAULT_RISK_CONFIG, 'cautious');
  assert.equal(scaled.baseRiskPct, DEFAULT_RISK_CONFIG.baseRiskPct * 0.5);
  assert.equal(scaled.maxOpenPositions, DEFAULT_RISK_CONFIG.maxOpenPositions - 1);
});

test('applyRiskLevel("normal") returns the base config unchanged', () => {
  const scaled = applyRiskLevel(DEFAULT_RISK_CONFIG, 'normal');
  assert.equal(scaled.baseRiskPct, DEFAULT_RISK_CONFIG.baseRiskPct);
  assert.equal(scaled.maxOpenPositions, DEFAULT_RISK_CONFIG.maxOpenPositions);
});

test('applyRiskLevel("bold") is currently a documented no-op, identical to normal', () => {
  const scaled = applyRiskLevel(DEFAULT_RISK_CONFIG, 'bold');
  assert.equal(scaled.baseRiskPct, DEFAULT_RISK_CONFIG.baseRiskPct);
  assert.equal(scaled.maxOpenPositions, DEFAULT_RISK_CONFIG.maxOpenPositions);
});

test('applyRiskLevel throws on an unrecognized risk level', () => {
  assert.throws(() => applyRiskLevel(DEFAULT_RISK_CONFIG, 'extreme'));
});

test('applyRiskLevel never reduces maxOpenPositions below 1', () => {
  const tinyConfig = { ...DEFAULT_RISK_CONFIG, maxOpenPositions: 1 };
  const scaled = applyRiskLevel(tinyConfig, 'cautious');
  assert.equal(scaled.maxOpenPositions, 1);
});
```

(Add `applyRiskLevel` to the existing `require('../src/engine/config')` import line at the top of the test file.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-config.test.js`
Expected: FAIL — `applyRiskLevel is not a function`

- [ ] **Step 3: Implement**

In `src/engine/config.js`, add:

```js
function applyRiskLevel(baseConfig, riskLevel) {
  if (!['cautious', 'normal', 'bold'].includes(riskLevel)) {
    throw new Error(`unrecognized risk level: ${riskLevel}`);
  }
  if (riskLevel === 'cautious') {
    return {
      ...baseConfig,
      baseRiskPct: baseConfig.baseRiskPct * 0.5,
      maxOpenPositions: Math.max(1, baseConfig.maxOpenPositions - 1),
    };
  }
  // 'normal' and 'bold' are currently identical — see this plan's Interpretation decisions for why
  // 'bold' doesn't yet scale up: DEFAULT_RISK_CONFIG's values are the enforced guardrail ceiling in
  // this codebase, not a baseline sitting below a separate, larger cap — scaling past them means
  // picking new risk numbers nobody has validated, a decision for a human, not this function.
  return { ...baseConfig };
}
```

Add `applyRiskLevel` to `module.exports`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-config.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/engine/config.js test/engine-config.test.js
git commit -m "feat(engine): add applyRiskLevel (cautious scales down; bold is a documented no-op)"
```

---

## Task 3: `POST /api/config/draft` and `POST /api/config/draft/backtest`

**Files:**
- Modify: `src/backtest/run.js`
- Modify: `src/server/app.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Modifies: `runBacktest(db, config = DEFAULT_RISK_CONFIG, fromTs = 0, setupsByRegime = SETUPS_BY_REGIME)` — one new optional parameter, backward-compatible (every existing call site keeps working unchanged). **Not unit-tested against synthetic fixtures** — proving this parameter actually changes which trades fire needs real multi-month candle history (the same reason `runBacktest` itself has never had a synthetic-fixture test all session); Task 5's real run proves it against the real Pi database instead, matching this project's established convention for backtest-level orchestration.
- Produces: `POST /api/config/draft` (body: `{ riskLevel, disabledSetups, rangeOverrides }`) → `200` with the validated/normalized draft, or `400` if `disabledSetups` names an unknown setup or `riskLevel` isn't one of `cautious`/`normal`/`bold`. `POST /api/config/draft/backtest` (body: the draft) → `200` with `{ draft, backtestSummary: { totalTrades, finalBalance, bySetup: {...} }, note }` — `note` explicitly states that `rangeOverrides` don't affect this backtest.

- [ ] **Step 1: Write the failing tests**

`test/server-app.test.js`'s `startTestServer` opens `openDb(':memory:')` — an empty database with zero candles. That makes it the wrong place to prove "disabling a setup changes which real trades fire" (there's no real history to produce trades from at all), but the right place to prove the *endpoint's wiring and shape* are correct regardless of data. Add to `test/server-app.test.js`:

```js
test('POST /api/config/draft validates and echoes back a well-formed draft', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/draft`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ riskLevel: 'cautious', disabledSetups: ['trend_breakout'], rangeOverrides: {} }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.riskLevel, 'cautious');
    assert.deepEqual(body.disabledSetups, ['trend_breakout']);
  } finally {
    server.close();
  }
});

test('POST /api/config/draft rejects an unknown setup name in disabledSetups with 400', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/draft`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ riskLevel: 'normal', disabledSetups: ['not_a_real_setup'], rangeOverrides: {} }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /api/config/draft/backtest returns a well-shaped summary even against an empty database', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/draft/backtest`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ riskLevel: 'normal', disabledSetups: ['trend_pullback'], rangeOverrides: {} }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.backtestSummary.totalTrades, 0); // no candles seeded — no history to trade on
    assert.deepEqual(body.backtestSummary.bySetup, {});
    assert.match(body.note, /range/i);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` for all three (no such route yet).

- [ ] **Step 3: Implement**

In `src/backtest/run.js`, change the signature and its one internal use:

```js
function runBacktest(db, config = DEFAULT_RISK_CONFIG, fromTs = 0, setupsByRegime = SETUPS_BY_REGIME) {
```

and inside the walk-forward loop, change `for (const setupName of SETUPS_BY_REGIME[regimeLabel] || [])` to `for (const setupName of setupsByRegime[regimeLabel] || [])`.

In `src/server/app.js`, add:

```js
  const { applyRiskLevel } = require('../engine/config');
  const { runBacktest } = require('../backtest/run');
  const { computeExpectancy } = require('../backtest/stats');

  function validateDraft(body) {
    const { riskLevel, disabledSetups, rangeOverrides } = body || {};
    if (!['cautious', 'normal', 'bold'].includes(riskLevel)) return { error: `invalid riskLevel: ${riskLevel}` };
    const validSetupNames = Object.keys(SETUPS);
    for (const name of disabledSetups || []) {
      if (!validSetupNames.includes(name)) return { error: `unknown setup in disabledSetups: ${name}` };
    }
    return { draft: { riskLevel, disabledSetups: disabledSetups || [], rangeOverrides: rangeOverrides || {} } };
  }

  app.post('/api/config/draft', (req, res) => {
    const { error, draft } = validateDraft(req.body);
    if (error) return res.status(400).json({ error });
    res.json(draft);
  });

  app.post('/api/config/draft/backtest', (req, res) => {
    const { error, draft } = validateDraft(req.body);
    if (error) return res.status(400).json({ error });

    const scaledConfig = applyRiskLevel(DEFAULT_RISK_CONFIG, draft.riskLevel);
    const setupsByRegimeForDraft = Object.fromEntries(
      Object.entries(SETUPS_BY_REGIME).map(([regime, names]) => [regime, names.filter((n) => !draft.disabledSetups.includes(n))])
    );

    const nowTs = Math.floor(Date.now() / 1000);
    const result = runBacktest(db, scaledConfig, nowTs - 90 * 86400, setupsByRegimeForDraft);

    const bySetupTrades = {};
    for (const trade of result.state.closedTrades) {
      (bySetupTrades[trade.setup] = bySetupTrades[trade.setup] || []).push(trade);
    }
    const bySetup = Object.fromEntries(Object.entries(bySetupTrades).map(([name, trades]) => [name, computeExpectancy(trades)]));

    res.json({
      draft,
      backtestSummary: {
        totalTrades: result.state.closedTrades.length,
        finalBalance: result.state.balance,
        bySetup,
      },
      note: 'rangeOverrides do not affect this backtest — the backtest is deterministic and never calls Claude, so Claude\'s adjustment ranges have nothing to act on here. Only riskLevel and disabledSetups change this result.',
    });
  });
```

(`SETUPS`, `SETUPS_BY_REGIME`, `DEFAULT_RISK_CONFIG` are already imported earlier in `createApp`'s body from Part E — reuse those bindings directly, don't re-`require` them.)

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/backtest/run.js src/server/app.js test/server-app.test.js
git commit -m "feat(server): add POST /api/config/draft and /api/config/draft/backtest"
```

---

## Task 4: `POST /api/config/draft/submit`, `GET /api/config/pending`, approve/reject

**Files:**
- Modify: `src/server/app.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `POST /api/config/draft/submit` (body: `{ draft, backtestSummary }`) → `200` with the new pending version's `id`, after superseding any existing pending version. `GET /api/config/pending?mode=` → `200` with `{ active, pending }` (each the shape `getActiveConfigVersion`/`getPendingConfigVersion` return, `pending` possibly `null`). `POST /api/config/:id/approve` / `POST /api/config/:id/reject` → `200` on success, `404` if the id doesn't exist for that mode, `409` if it's not currently `pending`.

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:

```js
test('POST /api/config/draft/submit creates a pending version, superseding any existing one', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const firstRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/submit`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {} }, backtestSummary: { totalTrades: 0 } }),
    });
    const firstBody = await firstRes.json();

    const secondRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/submit`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { riskLevel: 'normal', disabledSetups: ['trend_breakout'], rangeOverrides: {} }, backtestSummary: { totalTrades: 5 } }),
    });
    const secondBody = await secondRes.json();

    const pendingRes = await fetch(`http://127.0.0.1:${port}/api/config/pending`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const pendingBody = await pendingRes.json();
    assert.equal(pendingBody.pending.id, secondBody.id);
    assert.notEqual(firstBody.id, secondBody.id);
  } finally {
    server.close();
  }
});

test('GET /api/config/pending returns a synthetic default active version when nothing has ever been approved', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/pending`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.active.id, null);
    assert.equal(body.active.config.riskLevel, 'normal');
    assert.equal(body.pending, null);
  } finally {
    server.close();
  }
});

test('POST /api/config/:id/approve promotes a pending version to active', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const submitRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/submit`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {} }, backtestSummary: {} }),
    });
    const { id } = await submitRes.json();

    const approveRes = await fetch(`http://127.0.0.1:${port}/api/config/${id}/approve`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(approveRes.status, 200);

    const pendingRes = await fetch(`http://127.0.0.1:${port}/api/config/pending`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await pendingRes.json();
    assert.equal(body.active.id, id);
    assert.equal(body.pending, null);
  } finally {
    server.close();
  }
});

test('POST /api/config/:id/approve on an already-decided version returns 409', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const submitRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/submit`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {} }, backtestSummary: {} }),
    });
    const { id } = await submitRes.json();
    await fetch(`http://127.0.0.1:${port}/api/config/${id}/approve`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });

    const secondApprove = await fetch(`http://127.0.0.1:${port}/api/config/${id}/approve`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(secondApprove.status, 409);
  } finally {
    server.close();
  }
});

test('POST /api/config/:id/reject on a nonexistent id returns 404', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/999999/reject`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` for all new routes.

- [ ] **Step 3: Implement**

In `src/server/app.js`, add:

```js
  const {
    insertConfigVersion, getActiveConfigVersion, getPendingConfigVersion,
    approveConfigVersion, rejectConfigVersion, supersedePendingConfigVersions,
  } = require('../data/db');

  app.post('/api/config/draft/submit', (req, res) => {
    const mode = req.query.mode || 'paper';
    const { draft, backtestSummary } = req.body || {};
    if (!draft) return res.status(400).json({ error: 'missing draft' });

    supersedePendingConfigVersions(db, mode);
    const id = insertConfigVersion(db, { mode, configJson: draft, backtestJson: backtestSummary });
    res.json({ id });
  });

  app.get('/api/config/pending', (req, res) => {
    const mode = req.query.mode || 'paper';
    res.json({ active: getActiveConfigVersion(db, mode), pending: getPendingConfigVersion(db, mode) });
  });

  app.post('/api/config/:id/approve', (req, res) => {
    const mode = req.query.mode || 'paper';
    const id = Number(req.params.id);
    try {
      approveConfigVersion(db, mode, id);
      res.json({ ok: true });
    } catch (err) {
      const exists = db.prepare('SELECT 1 FROM config_versions WHERE id = ? AND mode = ?').get(id, mode);
      res.status(exists ? 409 : 404).json({ error: err.message });
    }
  });

  app.post('/api/config/:id/reject', (req, res) => {
    const mode = req.query.mode || 'paper';
    const id = Number(req.params.id);
    try {
      rejectConfigVersion(db, mode, id);
      res.json({ ok: true });
    } catch (err) {
      const exists = db.prepare('SELECT 1 FROM config_versions WHERE id = ? AND mode = ?').get(id, mode);
      res.status(exists ? 409 : 404).json({ error: err.message });
    }
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
git add src/server/app.js test/server-app.test.js
git commit -m "feat(server): add POST /api/config/draft/submit, GET /api/config/pending, approve/reject"
```

---

## Task 5: Real-run verification

**Files:** none modified — verification only.

- [ ] **Step 1: Prove `runBacktest`'s new parameter actually changes real results**

This is the one proof this plan defers from Task 3's unit tests to a real run, per that task's own note — `:memory:` has no real history to produce a measurable difference from, the real Pi database does.

```bash
timeout 10 node dashboard.js &
sleep 1
echo "--- backtest with all setups enabled ---"
curl -s -X POST -H "Content-Type: application/json" -d '{"riskLevel":"normal","disabledSetups":[],"rangeOverrides":{}}' http://127.0.0.1:3000/api/config/draft/backtest | head -c 400
echo
echo "--- backtest with trend_pullback disabled ---"
curl -s -X POST -H "Content-Type: application/json" -d '{"riskLevel":"normal","disabledSetups":["trend_pullback"],"rangeOverrides":{}}' http://127.0.0.1:3000/api/config/draft/backtest | head -c 400
echo
wait 2>/dev/null
```
Expected: the first call's `backtestSummary.bySetup` includes a real `trend_pullback` entry with a real trade count (matching the kind of result milestone 4's gate run already found passing for this setup); the second call's `bySetup` has no `trend_pullback` key at all, and `totalTrades` is correspondingly lower — proving `setupsByRegime` is genuinely read, not silently ignored. `timeout 10` gives two sequential 90-day backtests room to run (slower than the other real-run checks this session).

- [ ] **Step 2: Confirm the full draft→backtest→submit→approve cycle against real data**

```bash
timeout 8 node dashboard.js &
sleep 1
echo "--- draft ---"
curl -s -X POST -H "Content-Type: application/json" -d '{"riskLevel":"cautious","disabledSetups":["trend_breakout","oversold_bounce"],"rangeOverrides":{}}' http://127.0.0.1:3000/api/config/draft
echo
echo "--- pending (before submit) ---"
curl -s http://127.0.0.1:3000/api/config/pending
echo
wait 2>/dev/null
```
Expected: `draft` echoes the input; `pending` shows the synthetic default active version and `pending: null` (nothing submitted in this run — the full submit/approve lifecycle is already proven against `:memory:` by Task 4's own tests, so this step just confirms the read-side endpoints work against the real production database too, not a second lifecycle run against real data).

- [ ] **Step 3: Run the full suite one final time**

Run: `node --test test/`
Expected: PASS

## Part A exit check

- [ ] `node --test test/` passes (all new tests green: 6 config-version lifecycle tests, 5 risk-level tests, 3 draft/backtest tests, 5 submit/pending/approve/reject tests — 19 new tests — plus every prior test unchanged).
- [ ] `runBacktest`'s new `setupsByRegime` parameter proven to genuinely change results against the real Pi database (Task 5 Step 1) — the one correctness proof this plan deliberately defers from the synthetic-fixture suite.
- [ ] The full draft→backtest→submit→approve→active cycle proven against `:memory:` (Task 4's tests) and the read-side endpoints additionally confirmed against the real production database (Task 5 Step 2).
- [ ] No UI yet — Part B builds the Strategy tab's editing controls against this API. **An approved config version still does not affect live trading** — that wiring is explicitly separate follow-up work, not silently included here.
