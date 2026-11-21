# Live Config Integration (Milestone 8, Part C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap Part A/B deliberately left open: make `runCycle` actually read the active `config_versions` row for its mode and apply its `riskLevel` scaling and `disabledSetups` filtering, instead of always using the hardcoded `DEFAULT_RISK_CONFIG`/`SETUPS_BY_REGIME` imports. After this, approving a config version through the Strategy tab actually changes what the live (paper) scheduler does on its next cycle.

**Architecture:** The resolution logic itself — "given a base config, an active version's settings, and the base setup registry, produce the config and setup registry to actually use this cycle" — is small and pure, so it's extracted as `resolveEffectiveConfig` in `src/engine/config.js` right next to `applyRiskLevel` (which it calls), and unit-tested directly. `runCycle` itself gets one new line near its top (`getActiveConfigVersion` + `resolveEffectiveConfig`) and then every place it already used `config`/`SETUPS_BY_REGIME` switches to the resolved versions — no new control flow, just swapping which object those existing references point at. Claude's own, separate, regime-scoped `disable_setup` mechanism (`state.disabledSetups`, built in milestone 6) is untouched and composes naturally: a setup disabled by the active config version never even appears in the filtered `setupsByRegime[regimeLabel]` list for the loop to iterate, so there's nothing for the existing per-cycle Claude-disable check to conflict with.

**Tech Stack:** Existing Node.js scheduler/engine code, `node --test` for the one new pure helper, a real run against the actual Pi database for everything `runCycle`-level (same established convention as every prior change to this function).

**Spec:** `docs/v2-design.md` §8.2 (approving a config version is supposed to actually take effect — this plan is what makes that true for the live cycle, where Part A/B stopped at "the mechanism exists and is correct in isolation").

**Depends on:** `docs/superpowers/plans/2026-11-20-config-versioning-api.md` (Part A — `getActiveConfigVersion`, `applyRiskLevel`), milestone 6 (`runCycle`, `state.disabledSetups`).

## Global Constraints

- No behavior change for a mode that has never had a config version approved — `getActiveConfigVersion`'s synthetic default (`riskLevel: 'normal', disabledSetups: []`) resolves to exactly `DEFAULT_RISK_CONFIG`/`SETUPS_BY_REGIME` unchanged, so every real cycle run so far (all of them, on the live Pi service) continues to behave identically until someone actually approves a version.
- This plan changes the file the live, currently-running `cryptodash-paper.service` executes. The service needs restarting to pick up the change — same disclosed, separate step every prior `cycle.js` change in this session has required, asked about explicitly at the end, not bundled into "implement the plan."

## Interpretation decisions

- **`resolveEffectiveConfig` is exported from `src/engine/config.js`, not `src/scheduler/cycle.js`** — it's pure (no DB, no clock), so it belongs with `applyRiskLevel` in the engine layer per `CLAUDE.md`'s "`src/engine/` is pure" rule; `cycle.js` is only the caller that supplies the DB-sourced `activeVersionConfig` argument.
- **`appliedConfig` is added to `runCycle`'s success-path return value** (`{ riskLevel, disabledSetups }` from the resolved active version) purely for observability — this is what makes Task 2's real-run proof possible without needing a real candidate to fire (which the current `risk_off` market won't produce), and it costs nothing to leave in permanently: a caller that doesn't care about it just ignores the extra field.

## Review Focus

- A mode with no config version ever approved must produce identical behavior to before this plan — the synthetic default must resolve to the exact same `baseRiskPct`/`maxOpenPositions`/`SETUPS_BY_REGIME` the hardcoded constants already provide, not a subtly different value that happens to look similar.
- A setup disabled by an approved config version must be completely absent from that regime's candidate-evaluation loop for the rest of that cycle — not merely skipped after already being evaluated (wasted work is a performance nit, but evaluating a disabled setup's `evaluate()` and then discarding the result risks a candidate accidentally slipping through if a future refactor moves the disable-check to the wrong place relative to candidate creation).
- Claude's own regime-scoped `disable_setup` action (already built in milestone 6) must keep working exactly as before, composing with the new config-version disable rather than being replaced or short-circuited by it.
- A forced-fallback or error cycle (the existing milestone-6/7 real-run proofs that pass a deliberately-broken config) must still work after this change — `resolveEffectiveConfig` spreading over whatever `config` object is passed (including a test's deliberately-mangled one) must preserve fields it doesn't itself touch (`claudeModel`, etc.), not silently drop them.

---

## Task 1: `resolveEffectiveConfig`

**Files:**
- Modify: `src/engine/config.js`
- Test: `test/engine-config.test.js`

**Interfaces:**
- Produces: `resolveEffectiveConfig(baseConfig, activeVersionConfig, baseSetupsByRegime)` → `{ config, setupsByRegime }` — `config` is `applyRiskLevel(baseConfig, activeVersionConfig.riskLevel)`; `setupsByRegime` is `baseSetupsByRegime` with every setup in `activeVersionConfig.disabledSetups` filtered out of every regime's list.
- Consumed by: Task 2's `runCycle` wiring.

- [ ] **Step 1: Write the failing tests**

Add to `test/engine-config.test.js` (`applyRiskLevel` is already imported from the top-of-file line added in the config-versioning API plan — add `resolveEffectiveConfig` to that same import):

```js
test('resolveEffectiveConfig with the synthetic-default active version (normal, nothing disabled) changes nothing', () => {
  const baseSetupsByRegime = { trend_up: ['trend_breakout', 'trend_pullback'], range: ['range_reversion'], downtrend: ['oversold_bounce'], risk_off: [] };
  const { config, setupsByRegime } = resolveEffectiveConfig(DEFAULT_RISK_CONFIG, { riskLevel: 'normal', disabledSetups: [] }, baseSetupsByRegime);
  assert.equal(config.baseRiskPct, DEFAULT_RISK_CONFIG.baseRiskPct);
  assert.equal(config.maxOpenPositions, DEFAULT_RISK_CONFIG.maxOpenPositions);
  assert.deepEqual(setupsByRegime, baseSetupsByRegime);
});

test('resolveEffectiveConfig applies cautious scaling to the config', () => {
  const baseSetupsByRegime = { trend_up: ['trend_breakout', 'trend_pullback'] };
  const { config } = resolveEffectiveConfig(DEFAULT_RISK_CONFIG, { riskLevel: 'cautious', disabledSetups: [] }, baseSetupsByRegime);
  assert.equal(config.baseRiskPct, DEFAULT_RISK_CONFIG.baseRiskPct * 0.5);
});

test('resolveEffectiveConfig removes a disabled setup from every regime that lists it', () => {
  const baseSetupsByRegime = { trend_up: ['trend_breakout', 'trend_pullback'], range: ['range_reversion'] };
  const { setupsByRegime } = resolveEffectiveConfig(DEFAULT_RISK_CONFIG, { riskLevel: 'normal', disabledSetups: ['trend_breakout'] }, baseSetupsByRegime);
  assert.deepEqual(setupsByRegime.trend_up, ['trend_pullback']);
  assert.deepEqual(setupsByRegime.range, ['range_reversion']); // untouched regime unaffected
});

test('resolveEffectiveConfig preserves fields on baseConfig it does not itself touch', () => {
  const customConfig = { ...DEFAULT_RISK_CONFIG, claudeModel: 'a-test-model' };
  const { config } = resolveEffectiveConfig(customConfig, { riskLevel: 'normal', disabledSetups: [] }, {});
  assert.equal(config.claudeModel, 'a-test-model');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-config.test.js`
Expected: FAIL — `resolveEffectiveConfig is not a function`

- [ ] **Step 3: Implement**

In `src/engine/config.js`, add after `applyRiskLevel`:

```js
function resolveEffectiveConfig(baseConfig, activeVersionConfig, baseSetupsByRegime) {
  const config = applyRiskLevel(baseConfig, activeVersionConfig.riskLevel);
  const setupsByRegime = Object.fromEntries(
    Object.entries(baseSetupsByRegime).map(([regime, names]) => [
      regime, names.filter((n) => !activeVersionConfig.disabledSetups.includes(n)),
    ])
  );
  return { config, setupsByRegime };
}
```

Add `resolveEffectiveConfig` to `module.exports`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-config.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/engine/config.js test/engine-config.test.js
git commit -m "feat(engine): add resolveEffectiveConfig (applies an active config version's riskLevel + disabledSetups)"
```

---

## Task 2: Wire `runCycle` to the active config version

**Files:**
- Modify: `src/scheduler/cycle.js`

**Interfaces:**
- Modifies: `runCycle`'s success-path return value gains `appliedConfig: { riskLevel, disabledSetups }`. Internally, every existing use of the `config` parameter and the module-level `SETUPS_BY_REGIME` constant inside the function body is replaced with the resolved `effectiveConfig`/`effectiveSetupsByRegime`.
- No new unit test — this is a change to `runCycle` itself, proven by a real run against the real Pi database, same established convention as every prior change to this function this session.

- [ ] **Step 1: Add the imports and resolve the effective config at the top of the try block**

In `src/scheduler/cycle.js`, add `getActiveConfigVersion` to the existing `require('../data/db')` destructuring line, and `resolveEffectiveConfig` to the existing `require('../engine/config')` destructuring line:

```js
const { getCandles, loadSchedulerState, saveSchedulerState, insertTrade, insertCycleLog, insertCandidate, updateCandidateShadow, insertDecision, getTrades, getActiveConfigVersion } = require('../data/db');
```
```js
const { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS, resolveEffectiveConfig } = require('../engine/config');
```

Right after `await ingestAllCoins(db, krakenClient, COIN_ALTNAMES, now);` inside the `try` block, add:

```js
    const activeVersion = getActiveConfigVersion(db, mode);
    const { config: effectiveConfig, setupsByRegime: effectiveSetupsByRegime } = resolveEffectiveConfig(config, activeVersion.config, SETUPS_BY_REGIME);
```

- [ ] **Step 2: Replace every use of `config` and `SETUPS_BY_REGIME` inside the function body with the resolved versions**

Change each of the following (all already present in the function, just swapping which identifier they reference):

- `closePosition(state, position, exit, config);` (position-management loop) → `closePosition(state, position, exit, effectiveConfig);`
- `isKillSwitchTriggered(weeklyDrawdownPct, config)` → `isKillSwitchTriggered(weeklyDrawdownPct, effectiveConfig)`
- `isDailyLossLimitHit(state.dailyPnl / balanceAtDayStart, config)` → `isDailyLossLimitHit(state.dailyPnl / balanceAtDayStart, effectiveConfig)`
- `for (const setupName of SETUPS_BY_REGIME[regimeLabel] || [])` → `for (const setupName of effectiveSetupsByRegime[regimeLabel] || [])`
- `openPositionsRemaining: config.maxOpenPositions - ...` and `totalRiskPctRemaining: config.maxTotalRiskPct - ...` (inside `guardrailHeadroom`) → `effectiveConfig.maxOpenPositions` / `effectiveConfig.maxTotalRiskPct`
- `const result = await decide(decisionInput, config);` → `const result = await decide(decisionInput, effectiveConfig);`
- `model: config.claudeModel` (both occurrences, in the `take`-decision `insertDecision` call and the not-decided-candidate `insertDecision` call) → `model: effectiveConfig.claudeModel`
- `tryOpenPosition(state, adjustedCandidate, data, i, config);` → `tryOpenPosition(state, adjustedCandidate, data, i, effectiveConfig);`
- `closePosition(state, position, { exitTs: nowHour, exitPrice: closingBar.close, reason: 'claude_close' }, config);` (inside the `positionActions` loop) → same with `effectiveConfig`

Leave every other reference (e.g. `SETUPS` itself, used for `SETUPS[setupName].evaluate(...)` and `Object.keys(SETUPS)`) unchanged — the setup *registry* (what a setup named `X` does) isn't affected by config versioning, only which setup *names* are available per regime.

- [ ] **Step 3: Add `appliedConfig` to the success return**

Change:

```js
    return { regimeLabel, candidatesCount, openedCount, closedCount };
```

to:

```js
    return {
      regimeLabel, candidatesCount, openedCount, closedCount,
      appliedConfig: { riskLevel: activeVersion.config.riskLevel, disabledSetups: activeVersion.config.disabledSetups },
    };
```

- [ ] **Step 4: Prove it with a real run — baseline (no version ever approved for this exact mode) behaves unchanged**

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
Expected: same shape as every prior real run this session (`{regimeLabel, candidatesCount, openedCount, closedCount}`), now also including `appliedConfig: { riskLevel: 'normal', disabledSetups: [] }` — since no config version has ever actually been approved for `paper` mode on this real database (every "approve" test this session ran against a `:memory:` test database, not the real one), confirming the synthetic default is what's genuinely in effect right now, matching the Global Constraints' "no behavior change" requirement.

- [ ] **Step 5: Prove it with a real run — approve a real version and watch `appliedConfig` change**

One coherent Node script (not curl+bash+node string round-tripping, which is fragile — JSON containing quotes doesn't survive being re-embedded into a shell variable cleanly) that starts `dashboard.js`'s app in-process, drives the real draft→backtest→submit→approve HTTP flow against it with the real Pi database, then calls the real `runCycle`:

```bash
node -e "
const { openDb } = require('./src/data/db');
const { createApp } = require('./src/server/app');
const { createRestClient } = require('./src/kraken/rest');
const { runCycle } = require('./src/scheduler/cycle');

(async () => {
  const db = openDb();
  const app = createApp(db, {});
  const server = app.listen(0);
  const port = server.address().port;
  const base = \`http://127.0.0.1:\${port}\`;

  const draftRes = await fetch(\`\${base}/api/config/draft\`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ riskLevel: 'cautious', disabledSetups: ['trend_breakout'], rangeOverrides: {} }),
  });
  const draft = await draftRes.json();

  const backtestRes = await fetch(\`\${base}/api/config/draft/backtest\`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
  });
  const { backtestSummary } = await backtestRes.json();

  const submitRes = await fetch(\`\${base}/api/config/draft/submit\`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft, backtestSummary }),
  });
  const { id } = await submitRes.json();

  const approveRes = await fetch(\`\${base}/api/config/\${id}/approve\`, { method: 'POST' });
  console.log('approve status:', approveRes.status);

  server.close();

  const client = createRestClient({});
  const result = await runCycle(db, client, 'paper');
  console.log(JSON.stringify(result, null, 2));
})();
"
```
Expected: `approve status: 200`, and the printed `runCycle` result now includes `appliedConfig: { riskLevel: 'cautious', disabledSetups: ['trend_breakout'] }` — proving the live cycle genuinely reads and applies whatever is currently approved, not a cached or ignored value.

- [ ] **Step 6: Restore the real `paper` mode's active config to the prior default**

Step 5 deliberately changed real, live production state (`paper` mode's active config version) purely to prove the wiring — that's a real, lasting change to the actual database, not a disposable test artifact, and shouldn't be left in place without a separate, deliberate decision to keep it. Restore it in the same real session:

```bash
node -e "
const { openDb } = require('./src/data/db');
const { createApp } = require('./src/server/app');

(async () => {
  const db = openDb();
  const app = createApp(db, {});
  const server = app.listen(0);
  const port = server.address().port;
  const base = \`http://127.0.0.1:\${port}\`;

  const draft = { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} };
  const backtestRes = await fetch(\`\${base}/api/config/draft/backtest\`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
  });
  const { backtestSummary } = await backtestRes.json();

  const submitRes = await fetch(\`\${base}/api/config/draft/submit\`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft, backtestSummary }),
  });
  const { id } = await submitRes.json();

  const approveRes = await fetch(\`\${base}/api/config/\${id}/approve\`, { method: 'POST' });
  console.log('restore approve status:', approveRes.status);
  server.close();
})();
"
```
Expected: `restore approve status: 200`. After this, the real `paper` mode's active config version is back to `{riskLevel: 'normal', disabledSetups: []}` — functionally identical to before Step 5 ran, with the only lasting trace being the version-history rows in `config_versions` (which is exactly what that table is for — an auditable history, not something this step should try to erase).

- [ ] **Step 7: Run the full test suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/cycle.js
git commit -m "feat(scheduler): apply the active config version's riskLevel and disabledSetups in runCycle"
```

---

## Task 3: Restart the live service (explicit confirmation required)

**Files:** none — operational step only.

- [ ] **Step 1: Stop here and ask before restarting**

`cycle.js` is the file `cryptodash-paper.service` (enabled and running continuously on this Pi since milestone 5) executes every hour. This plan's change has no effect on the live service until it's restarted. Tell the user the code is ready and ask explicitly before running:

```bash
sudo systemctl restart cryptodash-paper.service
sudo systemctl status cryptodash-paper.service --no-pager
```

Do not run this without the user's explicit go-ahead, consistent with every prior restart of this same service this session.

## Part C exit check

- [ ] `node --test test/` passes (4 new `resolveEffectiveConfig` tests, plus every prior test unchanged).
- [ ] A real run confirmed the "no version ever approved" baseline is unchanged (`appliedConfig: {riskLevel:'normal', disabledSetups:[]}`), and a second real run confirmed approving a real version changes what the next cycle actually applies.
- [ ] **Live note:** Task 2 Step 5's real-run proof genuinely changed the real, currently-active `paper` config version on the production database, and Step 6 restored it to the prior default immediately after — the only lasting trace is an auditable row in `config_versions`' history, not a left-over production change.
- [ ] The live `cryptodash-paper.service` is not restarted by this plan — that's Task 3's separate, explicit-confirmation-gated step.
