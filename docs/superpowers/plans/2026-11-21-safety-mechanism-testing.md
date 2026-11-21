# Safety Mechanism Testing + Kill Switch Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliberately prove the kill switch and daily loss limit actually gate new entries and recover correctly (go-live criteria §11: "Reconcile, kill switch and daily loss limit all tested deliberately"), and close a real gap found while scoping this: once the kill switch trips, nothing in the codebase can ever clear it — not even a `cryptodash-paper.service` restart, since `killSwitchActive` is persisted in `scheduler_state` and reloaded on every cycle. Build the missing reset path (DB function, API endpoint, dashboard button).

**Architecture:** The two safety gates currently live as one large inline boolean in `runCycle` (`src/scheduler/cycle.js`), which is why they've never been tested as gates — only their underlying pure predicates (`isKillSwitchTriggered`, `isDailyLossLimitHit`) have unit tests, and those only prove the math, not that `runCycle` actually skips the candidate loop. This plan extracts the gate itself, and the daily-rollover logic next to it, into two new pure functions in `src/engine/risk.js` (same file that already owns `isKillSwitchTriggered`/`isDailyLossLimitHit`), each directly unit-tested against every input that matters — no fabricated candle/regime fixtures needed, because the gate only needs `regimeLabel`, a boolean, and `state`, not real market data. `runCycle` then calls them instead of repeating the inline logic, proven safe by the full suite plus one real-run regression check against the actual Pi database (same convention as every prior `cycle.js` change this session). The reset mechanism is a new `resetKillSwitch` DB function, a dedicated `POST /api/guardrails/reset-kill-switch` endpoint (inherits the existing `/api/*` password middleware automatically), and a confirm-gated button in the Strategy tab's guardrails panel, visible only while the kill switch is active.

**Tech Stack:** Existing Node.js engine/scheduler/server code, `node --test` for the new pure helpers and DB/API tests, a real run against the actual Pi database for the `cycle.js` regression check (established convention — see `docs/superpowers/plans/2026-11-20-live-config-integration.md` for the identical pattern).

**Spec:** `docs/v2-design.md` §6 (guardrail values, lines ~140-141: "Daily loss limit... hit it and nothing new opens until midnight UTC"; "Weekly drawdown kill switch... hit it and everything pauses until restarted by hand"), §9 (dashboard: "guardrails... plus the kill switch status and a manual pause button" — this plan builds that button for the reset direction), §11 (go-live criteria: "Reconcile, kill switch and daily loss limit all tested deliberately"), `CLAUDE.md` ("`src/engine/` is pure" — the new predicates belong there; "Guardrails live in code, not prompts" — the reset is a dedicated human action, never something Claude's decision JSON can trigger).

**Depends on:** milestone 5 (`runCycle`, `scheduler_state`), milestone 7 (Strategy tab, `renderGuardrails`), milestone 8 Part C (`resolveEffectiveConfig` — unrelated to this plan's changes, but the same file, `cycle.js`, so this plan's diff sits right after it).

## Global Constraints

- No behavior change for the common case (no kill switch, no daily loss hit) — the extraction is a pure refactor; the real-run regression check must show identical output to before.
- **Reconcile-on-startup is explicitly out of scope for this plan.** `CLAUDE.md` and `docs/v2-design.md` §4/§13 require it, but it compares the DB against *real Kraken orders* — and `src/broker/live.js` doesn't exist yet (the system is paper-only; paper trades never touch Kraken). There is nothing to reconcile against until milestone 10 builds the live broker. This plan does not stub or fake a reconcile check; it is deferred, not addressed.
- Guardrails live in code, not prompts (`CLAUDE.md`) — the reset button and endpoint are a deliberate, human-triggered write path, never reachable from Claude's decision JSON or any automated process.
- `/api/*` is already password-gated by existing middleware in `src/server/app.js` — the new endpoint needs no new auth code.

## Interpretation decisions

- **Resetting the kill switch also rebases `weeklyPeakBalance` to the current balance.** The design doc only says "pauses until restarted by hand," without saying what "restarted" does to the drawdown state. If `resetKillSwitch` only flipped `killSwitchActive` back to `false` and left `weeklyPeakBalance` untouched, the very next cycle would recompute the same ≥8% drawdown from the same stale peak and immediately re-trip it — making the reset a no-op in practice. Rebasing the peak to the current balance is the only interpretation under which a human who has reviewed the situation and decided to resume actually gets a resumed bot; this is called out explicitly because it's a judgment call the spec doesn't make for us.
- **`shouldEvaluateCandidates` and `rollDailyPnl` live in `src/engine/risk.js`, not `src/scheduler/cycle.js`.** Both are pure (no DB, no clock — `cycle.js` already computes `nowHour`/`dayKey`/`isFourHourBoundary(nowHour)` before calling them), so `CLAUDE.md`'s "`src/engine/` is pure" rule places them there, next to the predicates they compose (`isKillSwitchTriggered`, `isDailyLossLimitHit` already live in this file).

## Review Focus

- Resetting the kill switch without rebasing `weeklyPeakBalance` would make the reset silently useless (instant re-trip next cycle) — Task 4's test proves `weeklyDrawdownPct` is genuinely 0 immediately after reset, not just that the flag flipped.
- A mode with no `scheduler_state` row yet must get a clean 404 from the reset endpoint, not a crash on a null state — Task 4 and Task 5 both test this.
- `killSwitchActive` must survive unrelated state mutations (a day rolling over) until explicitly reset — Task 2's tests prove `rollDailyPnl` never touches `killSwitchActive`.
- The UI reset button is a safety-relevant, hard-to-reverse-in-spirit action (it resumes live trading decisions) and must require an explicit confirmation before firing, and must not even render when there's nothing to reset — Task 6 covers both.
- The two new gate predicates must compose with `regimeLabel === 'risk_off'` correctly — a kill switch trip during `risk_off` must not somehow unblock entries that `risk_off` itself already blocks, and vice versa — Task 1's tests exercise every combination, not just the kill-switch-alone case.

---

## Task 1: `shouldEvaluateCandidates` — the entry gate, extracted and tested

**Files:**
- Modify: `src/engine/risk.js`
- Test: `test/engine-risk.test.js`

**Interfaces:**
- Produces: `shouldEvaluateCandidates(regimeLabel, isBoundary, state, dailyLossHit)` → `boolean` — true only when `regimeLabel` is truthy, `isBoundary` is true, `state.killSwitchActive` is false, `dailyLossHit` is false, and `regimeLabel !== 'risk_off'`.
- Consumed by: Task 3's `runCycle` wiring.

- [ ] **Step 1: Write the failing tests**

Add to `test/engine-risk.test.js` (add `shouldEvaluateCandidates` to the existing `require('../src/engine/risk')` destructuring line at the top):

```js
function makeGateState(overrides = {}) {
  return { killSwitchActive: false, ...overrides };
}

test('shouldEvaluateCandidates is true when every gate is clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', true, makeGateState(), false), true);
});

test('shouldEvaluateCandidates is false when the kill switch is active, even with everything else clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', true, makeGateState({ killSwitchActive: true }), false), false);
});

test('shouldEvaluateCandidates is false when the daily loss limit is hit, even with everything else clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', true, makeGateState(), true), false);
});

test('shouldEvaluateCandidates is false during risk_off regardless of the kill switch or daily loss state', () => {
  assert.equal(shouldEvaluateCandidates('risk_off', true, makeGateState(), false), false);
  assert.equal(shouldEvaluateCandidates('risk_off', true, makeGateState({ killSwitchActive: true }), true), false);
});

test('shouldEvaluateCandidates is false when regimeLabel is not yet known (null)', () => {
  assert.equal(shouldEvaluateCandidates(null, true, makeGateState(), false), false);
});

test('shouldEvaluateCandidates is false off the 4h boundary even with every gate clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', false, makeGateState(), false), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-risk.test.js`
Expected: FAIL — `shouldEvaluateCandidates is not a function`

- [ ] **Step 3: Implement**

In `src/engine/risk.js`, add after `isKillSwitchTriggered`:

```js
function shouldEvaluateCandidates(regimeLabel, isBoundary, state, dailyLossHit) {
  return Boolean(regimeLabel) && isBoundary && !state.killSwitchActive && !dailyLossHit && regimeLabel !== 'risk_off';
}
```

Add `shouldEvaluateCandidates` to `module.exports`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-risk.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/risk.js test/engine-risk.test.js
git commit -m "feat(engine): extract shouldEvaluateCandidates, the kill-switch/daily-loss/risk_off entry gate, with direct tests for each blocking input"
```

---

## Task 2: `rollDailyPnl` — the midnight-UTC daily loss reset, extracted and tested

**Files:**
- Modify: `src/engine/risk.js`
- Test: `test/engine-risk.test.js`

**Interfaces:**
- Produces: `rollDailyPnl(state, dayKey)` → `{ currentDay, dailyPnl }` — resets `dailyPnl` to `0` and sets `currentDay` to `dayKey` when `state.currentDay !== dayKey`; otherwise returns `state.currentDay`/`state.dailyPnl` unchanged. Does not touch `killSwitchActive` or any other field.
- Consumed by: Task 3's `runCycle` wiring (via `Object.assign(state, rollDailyPnl(state, dayKey))`).

- [ ] **Step 1: Write the failing tests**

Add to `test/engine-risk.test.js` (add `rollDailyPnl` to the same import line as Task 1):

```js
test('rollDailyPnl resets dailyPnl to 0 and adopts the new dayKey when the day has changed', () => {
  const state = { currentDay: 5, dailyPnl: -30 };
  assert.deepEqual(rollDailyPnl(state, 6), { currentDay: 6, dailyPnl: 0 });
});

test('rollDailyPnl leaves dailyPnl and currentDay unchanged within the same day', () => {
  const state = { currentDay: 5, dailyPnl: -12 };
  assert.deepEqual(rollDailyPnl(state, 5), { currentDay: 5, dailyPnl: -12 });
});

test('rollDailyPnl genuinely clears a tripped daily loss limit at the day boundary — the design\'s "resets at midnight UTC" claim, proven against isDailyLossLimitHit', () => {
  const config = { dailyLossLimitPct: 0.03 };
  const balanceAtDayStart = 1000;
  const state = { currentDay: 5, dailyPnl: -40 }; // -4%, over the 3% limit
  assert.equal(isDailyLossLimitHit(state.dailyPnl / balanceAtDayStart, config), true);

  const rolled = rollDailyPnl(state, 6);
  assert.equal(isDailyLossLimitHit(rolled.dailyPnl / balanceAtDayStart, config), false);
});

test('rollDailyPnl never touches killSwitchActive — a day rollover must not silently clear a kill switch trip', () => {
  const state = { currentDay: 5, dailyPnl: -40, killSwitchActive: true };
  const rolled = rollDailyPnl(state, 6);
  assert.equal('killSwitchActive' in rolled, false); // caller Object.assign()s onto state, so an absent key here means killSwitchActive survives untouched
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-risk.test.js`
Expected: FAIL — `rollDailyPnl is not a function`

- [ ] **Step 3: Implement**

In `src/engine/risk.js`, add after `shouldEvaluateCandidates`:

```js
function rollDailyPnl(state, dayKey) {
  if (state.currentDay !== dayKey) {
    return { currentDay: dayKey, dailyPnl: 0 };
  }
  return { currentDay: state.currentDay, dailyPnl: state.dailyPnl };
}
```

Add `rollDailyPnl` to `module.exports`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-risk.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/risk.js test/engine-risk.test.js
git commit -m "feat(engine): extract rollDailyPnl, proving the daily loss limit clears at the UTC day boundary without touching killSwitchActive"
```

---

## Task 3: Wire both gates into `runCycle`

**Files:**
- Modify: `src/scheduler/cycle.js`

**Interfaces:**
- Consumes: `shouldEvaluateCandidates` and `rollDailyPnl` from Task 1/2, exact signatures above.
- No new unit test — this is a behavior-preserving swap of inline logic for the now-tested extracted functions, proven by the full suite plus a real-run regression check against the real Pi database (same convention as every prior change to this function this session).

- [ ] **Step 1: Import the new functions**

In `src/scheduler/cycle.js`, change:

```js
const { isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
```

to:

```js
const { isDailyLossLimitHit, isKillSwitchTriggered, shouldEvaluateCandidates, rollDailyPnl } = require('../engine/risk');
```

- [ ] **Step 2: Replace the day-rollover block**

Change:

```js
    const dayKey = utcDayKey(nowHour);
    if (state.currentDay !== dayKey) {
      state.currentDay = dayKey;
      state.dailyPnl = 0;
    }
```

to:

```js
    const dayKey = utcDayKey(nowHour);
    Object.assign(state, rollDailyPnl(state, dayKey));
```

- [ ] **Step 3: Replace the entry-gate condition**

Change:

```js
    if (regimeLabel && isFourHourBoundary(nowHour) && !state.killSwitchActive && !dailyLossHit && regimeLabel !== 'risk_off') {
```

to:

```js
    if (shouldEvaluateCandidates(regimeLabel, isFourHourBoundary(nowHour), state, dailyLossHit)) {
```

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 5: Real-run regression check against the real Pi database**

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
Expected: same shape and values as the most recent real run from the milestone 8 Part C plan (`regimeLabel: 'risk_off'`, `candidatesCount: 0`, `openedCount: 0`, `closedCount: 0`, `appliedConfig: {riskLevel:'normal', disabledSetups:[]}`) — confirming the extraction changed nothing about real behavior.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/cycle.js
git commit -m "refactor(scheduler): call the extracted, directly-tested shouldEvaluateCandidates/rollDailyPnl instead of repeating their logic inline"
```

---

## Task 4: `resetKillSwitch`

**Files:**
- Modify: `src/data/db.js`
- Test: `test/data-db.test.js`

**Interfaces:**
- Produces: `resetKillSwitch(db, mode)` → the updated state object — loads `scheduler_state` for `mode`, throws `no scheduler state for mode ${mode}` if none exists, otherwise sets `killSwitchActive: false` and rebases `weeklyPeakBalance` to the current `balance` (see Interpretation decisions), saves, and returns the updated state. Every other field (`openPositions`, `cooldowns`, `dailyPnl`, etc.) passes through unchanged.
- Consumed by: Task 5's API endpoint.

- [ ] **Step 1: Write the failing tests**

Add to `test/data-db.test.js`. The file has a second `require('../src/data/db')` line at line 68 (`const { insertTrade, getTrades, saveSchedulerState, loadSchedulerState, insertCycleLog, getCycleLog } = require('../src/data/db');`) — add `resetKillSwitch` to that line, not the top-of-file one (which only has candle functions):

```js
test('resetKillSwitch clears killSwitchActive and rebases weeklyPeakBalance to the current balance', () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'paper', {
    balance: 920, dailyPnl: 0, currentDay: 10, weeklyPeakBalance: 1000, killSwitchActive: true,
    openPositions: [], cooldowns: {}, closedTrades: [], shadowPositions: [], disabledSetups: {}, lastRegimeLabel: 'trend_up',
  });

  const result = resetKillSwitch(db, 'paper');

  assert.equal(result.killSwitchActive, false);
  assert.equal(result.weeklyPeakBalance, 920); // rebased to current balance, so weeklyDrawdownPct is 0 immediately — otherwise next cycle re-trips instantly
  assert.equal(loadSchedulerState(db, 'paper').killSwitchActive, false);
});

test('resetKillSwitch leaves every other state field untouched', () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'paper', {
    balance: 920, dailyPnl: -10, currentDay: 10, weeklyPeakBalance: 1000, killSwitchActive: true,
    openPositions: [{ coin: 'BTC', entryPrice: 100 }], cooldowns: { ETH: 123 }, closedTrades: [], shadowPositions: [], disabledSetups: { trend_breakout: 'trend_up' }, lastRegimeLabel: 'trend_up',
  });

  const result = resetKillSwitch(db, 'paper');

  assert.equal(result.dailyPnl, -10);
  assert.deepEqual(result.openPositions, [{ coin: 'BTC', entryPrice: 100 }]);
  assert.deepEqual(result.cooldowns, { ETH: 123 });
  assert.deepEqual(result.disabledSetups, { trend_breakout: 'trend_up' });
  assert.equal(result.lastRegimeLabel, 'trend_up');
});

test('resetKillSwitch throws when the mode has no scheduler state yet', () => {
  const db = openDb(':memory:');
  assert.throws(() => resetKillSwitch(db, 'paper'), /no scheduler state for mode paper/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-db.test.js`
Expected: FAIL — `resetKillSwitch is not a function`

- [ ] **Step 3: Implement**

In `src/data/db.js`, add after `loadSchedulerState`:

```js
function resetKillSwitch(db, mode) {
  const state = loadSchedulerState(db, mode);
  if (!state) throw new Error(`no scheduler state for mode ${mode}`);
  state.killSwitchActive = false;
  state.weeklyPeakBalance = state.balance; // rebase so weeklyDrawdownPct is 0 right away — otherwise the next cycle re-trips the same trigger instantly
  saveSchedulerState(db, mode, state);
  return state;
}
```

Add `resetKillSwitch` to `module.exports`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-db.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js test/data-db.test.js
git commit -m "feat(db): add resetKillSwitch (clears killSwitchActive, rebases weeklyPeakBalance so the reset doesn't instantly re-trip)"
```

---

## Task 5: `POST /api/guardrails/reset-kill-switch`

**Files:**
- Modify: `src/server/app.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Consumes: `resetKillSwitch(db, mode)` from Task 4.
- Produces: `POST /api/guardrails/reset-kill-switch?mode=<mode>` → `200 {ok: true}` on success, `404 {error: <message>}` when the mode has no scheduler state yet.

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`. The file's real helper is `startTestServer(password)` (defined near the top of the file) — it creates its own `:memory:` db and app, returns `{ server, port, db }` as a Promise, and every existing test calls `server.close()` in a `finally` block with the `X-Dashboard-Password` header set to `'sekrit'`. Add `loadSchedulerState` to the existing `require('../src/data/db')` destructuring line at the top of the file (it already imports `saveSchedulerState`), and follow that exact pattern:

```js
test('POST /api/guardrails/reset-kill-switch clears an active kill switch', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    saveSchedulerState(db, 'paper', {
      balance: 920, dailyPnl: 0, currentDay: 10, weeklyPeakBalance: 1000, killSwitchActive: true,
      openPositions: [], cooldowns: {}, closedTrades: [], shadowPositions: [], disabledSetups: {}, lastRegimeLabel: 'trend_up',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/guardrails/reset-kill-switch?mode=paper`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(loadSchedulerState(db, 'paper').killSwitchActive, false);
  } finally {
    server.close();
  }
});

test('POST /api/guardrails/reset-kill-switch returns 404 when the mode has no scheduler state', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/guardrails/reset-kill-switch?mode=paper`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' },
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — 404 (route doesn't exist) on the first test instead of the expected 200

- [ ] **Step 3: Implement**

In `src/server/app.js`, add `resetKillSwitch` to the existing `require('../data/db')` destructuring line that already pulls in `loadSchedulerState` (around line 171), and add the route right after the `/api/config/:id/reject` route (the last route before `return app;`):

```js
  app.post('/api/guardrails/reset-kill-switch', (req, res) => {
    const mode = req.query.mode || 'paper';
    try {
      resetKillSwitch(db, mode);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
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
git commit -m "feat(api): add POST /api/guardrails/reset-kill-switch"
```

---

## Task 6: Dashboard reset button

**Files:**
- Modify: `public-v2/js/strategy.mjs`

**Interfaces:**
- Consumes: `POST /api/guardrails/reset-kill-switch` from Task 5, via the existing `fetchJson(path, params, {method, body})` helper from `public-v2/js/api.mjs`.
- No new unit test — DOM-wiring modules are not unit-tested in this project (no browser automation tool available; established in every prior UI plan this session). This task is verified by a manual check against the real dashboard after deploy, described in Step 3.

- [ ] **Step 1: Add the button to `renderGuardrails`, only when the kill switch is active**

In `public-v2/js/strategy.mjs`, change the import line to pull in `fetchJson`:

```js
import { fetchJson } from './api.mjs';
import { formatRegimeDuration, formatSetupStats, formatGuardrailUsage, formatR, escapeHtml } from './format.mjs';
```

Change `renderGuardrails`:

```js
function renderGuardrails(strategy) {
  const el = document.getElementById('guardrails-panel');
  const g = strategy.guardrails;
  const rows = [
    ['Open positions', formatGuardrailUsage(g.openPositions)],
    ['Total risk', formatGuardrailUsage(g.totalRiskPct)],
    ['Total exposure', formatGuardrailUsage(g.totalExposurePct)],
    ['Daily loss', formatGuardrailUsage(g.dailyLossPct)],
    ['Weekly drawdown', formatGuardrailUsage(g.weeklyDrawdownPct)],
  ];
  el.innerHTML = `
    <div>${g.killSwitchActive
      ? '<strong style="color:#ef4444;">KILL SWITCH ACTIVE</strong> <button id="reset-kill-switch-button">Reset kill switch</button><div id="reset-kill-switch-result"></div>'
      : 'Kill switch: inactive'}</div>
    ${rows.map(([label, { text, pct }]) => `
      <div>${escapeHtml(label)}: ${escapeHtml(text)}
        <div class="guardrail-bar-track"><div class="guardrail-bar-fill" style="width:${pct}%;"></div></div>
      </div>
    `).join('')}
  `;
  if (g.killSwitchActive) {
    document.getElementById('reset-kill-switch-button').addEventListener('click', resetKillSwitch);
  }
}

async function resetKillSwitch() {
  if (!window.confirm('Reset the kill switch and resume trading decisions? Only do this after reviewing why it tripped.')) return;
  const resultEl = document.getElementById('reset-kill-switch-result');
  try {
    await fetchJson('/api/guardrails/reset-kill-switch', {}, { method: 'POST' });
    resultEl.textContent = 'Kill switch reset.';
    const strategy = await fetchJson('/api/strategy', {});
    renderGuardrails(strategy);
  } catch (err) {
    resultEl.textContent = `Reset failed: ${err.message}`;
  }
}
```

- [ ] **Step 2: Verify the file has no syntax errors**

Run: `node --check public-v2/js/strategy.mjs`
Expected: no output (exit code 0) — `--check` parses the file as a module without executing it, catching typos without needing a browser.

- [ ] **Step 3: Manual verification note**

This button cannot be exercised by `node --test` (no browser automation tool in this environment, per every prior UI plan this session). After this task is committed and the service restarted, confirm by hand on the real dashboard: with the kill switch inactive, the Strategy tab shows "Kill switch: inactive" and no button; forcing `killSwitchActive: true` via `resetKillSwitch`'s own test fixture pattern against the real DB (temporarily, then immediately resetting it back — same pattern as every real-DB proof this session) would show the button, and clicking it after confirming the dialog should clear it. This manual check is optional and left to the user's judgement; it is not a blocking step for `node --test`-based completion.

- [ ] **Step 4: Commit**

```bash
git add public-v2/js/strategy.mjs
git commit -m "feat(ui): add a confirm-gated kill switch reset button to the Strategy tab's guardrails panel"
```

## Exit check

- [ ] `node --test test/` passes (6 new `shouldEvaluateCandidates`/`rollDailyPnl` tests in `test/engine-risk.test.js`, 3 new `resetKillSwitch` tests in `test/data-db.test.js`, 2 new endpoint tests in `test/server-app.test.js`, plus every prior test unchanged).
- [ ] A real run against the real Pi database confirms the gate extraction changed nothing about current production behavior.
- [ ] **Reconcile note:** reconcile-on-startup remains unbuilt and out of scope — there is no live broker yet for it to reconcile against. This is a known, documented gap carried forward to milestone 10, not something this plan silently papered over.
- [ ] The live `cryptodash-paper.service` is not restarted by this plan automatically — ask explicitly before restarting, same as every prior `cycle.js`-touching change this session.
