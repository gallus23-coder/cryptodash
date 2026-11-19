# Claude Decision Layer, Part B (Milestone 6, Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real `claude -p` call, wire it into `runCycle` so every 4h-boundary candidate is persisted, decided on, and acted on through the exact same guardrail-checked path real trades already use, and prove the milestone-6 gate ("Decision log filling up; fallbacks tested") against the real Pi — the real authenticated CLI for the success path, a deliberately broken config for the failure path.

**Architecture:** `callClaudeCli` is a thin, real-run-proven wrapper around `child_process.execFile('claude', ...)`; everything around it (`buildCliArgs`, fence-stripping, `decide()`'s try/catch-to-fallback orchestration) is pure and unit-tested with an injected stub, so the safety-critical "any failure → skip the cycle" behavior doesn't depend on the real binary being reachable in a test run. `runCycle` grows to do what `runBacktest` already does for defaults, but through Claude: evaluate setups on 4h boundaries, persist every candidate, open a shadow position for it unconditionally (so the scorecard has a default-action baseline regardless of what Claude decides), call `decide()` once per cycle, and apply only the validated decisions it gets back.

**Tech Stack:** Node.js 20, `child_process.execFile`, Claude Code CLI (`claude -p`, OAuth/claude.ai Pro-plan session — already authenticated in this environment and on the Pi), `better-sqlite3`, `node --test`.

**Spec:** `docs/v2-design.md` §5.3 (Claude decides), §5.6 (cost controls, provider switch), §7 (database); `CLAUDE.md`'s "Claude can't exceed limits" and "any failure → skip the cycle" hard rules.

**Depends on:** `docs/superpowers/plans/2026-11-19-claude-decision-layer-part-a.md` (candidates/decisions tables, `buildDecisionPrompt`/`parseDecisionResponse`, shadow-outcome engine — all merged, none yet wired into `runCycle`).

## Global Constraints

- "Claude can't exceed limits" / "any failure → skip the cycle (never trade on a bad response)" — every path from a `decide()` call to a real order must go through Part A's `parseDecisionResponse` clamping, and any thrown error anywhere in that chain must resolve to `fallback: true`, zero real positions opened from candidates that cycle.
- "One call per cycle" (design §5.6) — all of a cycle's candidates and open positions go into a single `decide()` call, never one per coin.
- Every decision/candidate tagged `mode` (`paper`/`live`).
- `src/engine/` layout: `decide.js`'s pure functions (`buildCliArgs`, `stripMarkdownFences`, `decide`) stay free of DB/clock access; only `callClaudeCli` does I/O, and it's isolated and proven separately from the pure logic (established in Part A's Interpretation decisions).

## Interpretation decisions

- **`claude -p` is invoked with `--system-prompt` (full override), not `--append-system-prompt`.** Tested directly against the real CLI in this environment: `--append-system-prompt` adds the prompt on top of Claude Code's full default system prompt, inflating a single decision call to ~20k input tokens; `--system-prompt` replaces it entirely. Design §5.6 wants "compact input... under 4k input tokens" — `--append-system-prompt` would blow through that by 5x before the actual decision payload is even counted.
- **`--allowedTools ""` disables all tool use.** A decision call never needs to read a file or run a command — it's handed everything it needs as the prompt payload — so there's nothing for a tool call to do except burn turns or (worse) attempt something unexpected. Verified empirically that an empty list is accepted and the call completes normally.
- **`--bare` is NOT used**, even though it would reduce harness overhead further. Tested directly: `--bare` requires `ANTHROPIC_API_KEY` or `apiKeyHelper` — "OAuth and keychain are never read" per the CLI's own help text. That's exactly the auth design §5.6 says `claude-cli` must avoid ("the owner is on the Pro plan, which has no API credits" — the whole point of the `claude-cli` provider is to draw on the OAuth-authenticated subscription, not an API key).
- **The CLI's own harness overhead (~11k cache-creation input tokens per call, even with `--system-prompt` and `--disable-slash-commands`) is accepted, not fought further.** This is Claude Code's built-in tool-definition payload, present in every call regardless of `--allowedTools`. Design §5.6's $1-9/month cost estimate assumed a bare Anthropic API call with ~4k tokens; going through the CLI costs more in equivalent tokens. This doesn't matter for the stated default: the Pro-plan subscription bills in usage/quota, not the `$`-denominated `total_cost_usd` the CLI reports for display — that field is a notional API-equivalent, not an actual charge against the subscription. If `claude-cli` is ever switched to the `api` provider, this overhead is the first thing to revisit.
- **Markdown code fences around the JSON response are stripped defensively (`stripMarkdownFences`), not just prevented by prompt wording.** Tested directly: even with an explicit "no markdown code fences" system-prompt instruction, the model fenced its output in one of two real test calls and didn't in the other — nondeterministic, so the parser must tolerate it rather than trust the instruction alone.
- **No separate Haiku market-note-only call.** Design §5.6 describes a secondary Haiku call for "the market note on regime change" as a cost optimization. This plan's `marketNote`/`plainNote` already come from the one `decide()` call per §5.3's own output example — the dual-model split is a refinement for later, not required for milestone 6's gate.
- **Model IDs are `claude-sonnet-5` (decisions) — design's "Sonnet 5.5"/"Haiku 5.5" predate the real released model names** (confirmed against this environment's current model list: Sonnet 5, Opus 4.8, Haiku 4.5). `claudeModel` is a config value (per design §5.6: "Model is a config value"), so changing it later is a one-line config edit, not a code change.
- **`decide()` is called only when `candidates.length > 0 || openPositions.length > 0`** — design §5.6's full "call only when needed" rule also includes "or the regime changed," which would need tracking last cycle's regime label purely to decide whether to make a market-note-only call with no candidates and no positions. That refinement is deferred; the two conditions kept here cover the overwhelming majority of cycles where a call has any decision to make.
- **`scheduler_state`'s existing JSON blob (already live on the Pi from milestone 5) gets two new fields on load — `shadowPositions: []`, `disabledSetups: {}`, `lastRegimeLabel: null` — defaulted in code, not migrated.** `scheduler_state` is "deliberately not normalized" (one JSON blob per mode, documented in milestone 5's plan); evolving its shape means the loader defaults missing fields rather than running a migration, consistent with how the table was designed.

## Review Focus

- A cycle where `decide()` throws or returns `fallback: true` must open zero real positions from that cycle's candidates — shadow positions (which don't touch real balance) must still open and track normally, since they exist precisely to measure what *would* have happened regardless of whether Claude's call worked.
- A `positionAction` of `tighten_stop` must only ever raise a real position's `initialStopPrice`, matching Part A's `parseDecisionResponse` validation — `runCycle`'s application of an already-validated tighten must not re-derive or re-check the direction (that's done once, in Part A), but it also must not apply a stale/duplicate tighten if the same position is still open next cycle and Claude proposes the same price again (idempotent: setting `initialStopPrice` to the same value it already is is harmless, so no special-casing needed — just don't let a *lower* value through, which Part A already guarantees).
- `setupToggles`' "disable for the rest of the current regime" must actually clear when the regime changes, not persist forever — a stuck disabled setup after a regime flip would silently stop a setup from ever firing again.
- The forced-fallback real run (Task 5) must prove the cycle still writes a `cycle_log` row and completes without throwing, exactly like milestone 5's crash-safety guarantee — a Claude-layer failure is not allowed to be a *worse* failure mode than milestone 5's own `runCycle` try/catch already handles.
- Shadow positions opened this cycle and real positions opened this cycle must never be the same object reference or accidentally double-booked against the same `candidateId` — a bug here would silently double-count one candidate's outcome in both `trades` (real) and `candidates.shadow_*` (shadow) columns in a way that looks like two independent trades instead of one real trade and its would-have-been-default comparison point.

---

## Task 1: `decide.js` — `callClaudeCli`

**Files:**
- Modify: `src/engine/decide.js`
- Test: `test/engine-decide-cli.test.js`

**Interfaces:**
- Produces: `buildCliArgs(promptPair, config)` → `string[]` (pure). `stripMarkdownFences(text)` → `string` (pure). `callClaudeCli(promptPair, config)` → `Promise<string>` (the raw decision JSON text, fence-stripped), rejecting with a descriptive `Error` on any CLI failure (non-zero exit, timeout, non-JSON stdout, or `is_error: true` in the CLI's own JSON wrapper).
- Consumed by: Task 2's `decide()` (same file) and Task 5's real dry run.

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `test/engine-decide-cli.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCliArgs, stripMarkdownFences, callClaudeCli } = require('../src/engine/decide');

function sampleConfig() {
  return { claudeModel: 'claude-sonnet-5', claudeEffort: 'low', claudeTimeoutMs: 30000 };
}

test('buildCliArgs puts the system prompt in --system-prompt and the user prompt as the final positional arg', () => {
  const args = buildCliArgs({ system: 'SYS', user: 'USER' }, sampleConfig());
  assert.ok(args.includes('--system-prompt'));
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'SYS');
  assert.equal(args[args.length - 1], 'USER');
});

test('buildCliArgs always disables tool use with an empty --allowedTools', () => {
  const args = buildCliArgs({ system: 'SYS', user: 'USER' }, sampleConfig());
  assert.ok(args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], '');
});

test('buildCliArgs passes the configured model and effort through', () => {
  const args = buildCliArgs({ system: 'SYS', user: 'USER' }, { claudeModel: 'claude-haiku-4-5-20251001', claudeEffort: 'medium', claudeTimeoutMs: 1000 });
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
});

test('stripMarkdownFences removes a ```json fence wrapping the response', () => {
  assert.equal(stripMarkdownFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test('stripMarkdownFences removes a plain ``` fence (no language tag)', () => {
  assert.equal(stripMarkdownFences('```\n{"a":1}\n```'), '{"a":1}');
});

test('stripMarkdownFences passes unfenced text through unchanged (aside from trimming)', () => {
  assert.equal(stripMarkdownFences('  {"a":1}  '), '{"a":1}');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-decide-cli.test.js`
Expected: FAIL — `buildCliArgs is not a function`

- [ ] **Step 3: Implement**

Append to `src/engine/decide.js` (after the existing `parseDecisionResponse` block, before `module.exports`):

```js
const { execFile } = require('child_process');

function buildCliArgs(promptPair, config) {
  return [
    '-p', '--output-format', 'json',
    '--model', config.claudeModel,
    '--effort', config.claudeEffort,
    '--allowedTools', '',
    '--system-prompt', promptPair.system,
    promptPair.user,
  ];
}

function stripMarkdownFences(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\n([\s\S]*)\n```$/);
  return match ? match[1] : trimmed;
}

function callClaudeCli(promptPair, config) {
  return new Promise((resolve, reject) => {
    execFile('claude', buildCliArgs(promptPair, config), { timeout: config.claudeTimeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`claude cli failed: ${err.message}`));
      let wrapper;
      try {
        wrapper = JSON.parse(stdout);
      } catch (parseErr) {
        return reject(new Error(`claude cli returned non-JSON output: ${parseErr.message}`));
      }
      if (wrapper.is_error) return reject(new Error(`claude cli reported an error: ${wrapper.result}`));
      resolve(stripMarkdownFences(wrapper.result));
    });
  });
}
```

Update `module.exports` at the bottom of the file to include `buildCliArgs, stripMarkdownFences, callClaudeCli`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-decide-cli.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Prove `callClaudeCli` against the real, already-authenticated CLI**

This is the one real-I/O call in this task — proven by a real run, not mocked, per the project's established convention for I/O-touching orchestration.

Run:
```bash
node -e "
const { callClaudeCli } = require('./src/engine/decide');
(async () => {
  const result = await callClaudeCli(
    { system: 'Respond with strict JSON only, no markdown fences: {\"ok\":true}', user: 'Confirm you understood.' },
    { claudeModel: 'claude-haiku-4-5-20251001', claudeEffort: 'low', claudeTimeoutMs: 30000 }
  );
  console.log('RESULT:', result);
  JSON.parse(result); // must not throw
  console.log('Valid JSON confirmed.');
})();
"
```
Expected: prints `RESULT: ...` with something parseable as JSON (the model's exact wording may vary — the check that matters is `JSON.parse(result)` not throwing), then `Valid JSON confirmed.`. If this fails with "claude cli failed," confirm `claude` is on `PATH` and authenticated (`claude -p "hi"` should work standalone) before treating this as a code bug.

- [ ] **Step 6: Commit**

```bash
git add src/engine/decide.js test/engine-decide-cli.test.js
git commit -m "feat(engine): add callClaudeCli (real claude -p wrapper, OAuth/Pro-plan auth)"
```

---

## Task 2: `decide.js` — `decide()` orchestration

**Files:**
- Modify: `src/engine/decide.js`
- Test: `test/engine-decide-orchestration.test.js`

**Interfaces:**
- Produces: `decide(input, config, deps = { callClaudeCli })` → `Promise<{ decisions, positionActions, setupToggles, marketNote, plainNote, fallback, error? }>` — same shape `parseDecisionResponse` returns. Any rejection from `deps.callClaudeCli` resolves to `fallback: true` rather than propagating.
- Consumes: `buildDecisionPrompt`, `parseDecisionResponse`, `callClaudeCli` (all same file, Tasks 1 and Part A).
- Consumed by: Task 4's `runCycle` wiring (not this plan's task) and Task 5's real dry run.

- [ ] **Step 1: Write the failing tests**

Create `test/engine-decide-orchestration.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/engine/decide');

function sampleInput() {
  return {
    regime: 'trend_up', regimeMetrics: {}, openPositions: [], recentTrades: [], setupConfig: {}, guardrailHeadroom: {},
    candidates: [{
      id: 'c_20261118_10_SOL_trend_pullback', coin: 'SOL', setup: 'trend_pullback',
      default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
      ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
    }],
    setupNames: ['trend_pullback'],
  };
}

test('decide() returns a valid decision set when the CLI call succeeds with well-formed JSON', async () => {
  const fakeDeps = { callClaudeCli: async () => JSON.stringify({
    decisions: [{ candidateId: 'c_20261118_10_SOL_trend_pullback', action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5, reason: 'r', plainReason: 'p' }],
    positionActions: [], setupToggles: [], marketNote: 'note', plainNote: null,
  }) };

  const result = await decide(sampleInput(), {}, fakeDeps);
  assert.equal(result.fallback, false);
  assert.equal(result.decisions.length, 1);
});

test('decide() falls back to skip-all when the CLI call rejects (timeout, auth failure, etc)', async () => {
  const fakeDeps = { callClaudeCli: async () => { throw new Error('claude cli failed: timeout'); } };

  const result = await decide(sampleInput(), {}, fakeDeps);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.decisions, []);
  assert.match(result.error, /timeout/);
});

test('decide() falls back to skip-all when the CLI returns unparseable text', async () => {
  const fakeDeps = { callClaudeCli: async () => 'not json' };

  const result = await decide(sampleInput(), {}, fakeDeps);
  assert.equal(result.fallback, true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/engine-decide-orchestration.test.js`
Expected: FAIL — `decide is not a function`

- [ ] **Step 3: Implement**

Append to `src/engine/decide.js` (before `module.exports`):

```js
async function decide(input, config, deps = { callClaudeCli }) {
  const promptPair = buildDecisionPrompt(input);
  let rawText;
  try {
    rawText = await deps.callClaudeCli(promptPair, config);
  } catch (err) {
    return { decisions: [], positionActions: [], setupToggles: [], marketNote: '', plainNote: null, fallback: true, error: err.message };
  }
  return parseDecisionResponse(rawText, { candidates: input.candidates, openPositions: input.openPositions, setupNames: input.setupNames });
}
```

Update `module.exports` to include `decide`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/engine-decide-orchestration.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS (all prior tests, plus these 3 and Task 1's 6)

- [ ] **Step 6: Commit**

```bash
git add src/engine/decide.js test/engine-decide-orchestration.test.js
git commit -m "feat(engine): add decide() orchestration (CLI call -> parse -> fallback on any failure)"
```

---

## Task 3: `runCycle` — persist candidates and manage shadow positions

**Files:**
- Modify: `src/scheduler/cycle.js`

**Interfaces:**
- Modifies `freshState()`'s shape: adds `shadowPositions: []`, `disabledSetups: {}`, `lastRegimeLabel: null`.
- Modifies `runCycle`: every candidate found on a 4h boundary is now persisted via `insertCandidate` and gets a shadow position opened via `openShadowPosition` (Part A); every cycle (not just 4h boundaries), pending shadow positions are resolved via `resolveShadowPositions` and written back via `updateCandidateShadow`. Real position-opening behavior (currently "always take the default") is *not* changed in this task — that's Task 4.
- No test file for this task — `runCycle` is proven by a real dry run (established convention; see Task 3's Step 2 below), matching how Part A's and milestone 5's orchestration-layer changes were verified.

- [ ] **Step 1: Update `freshState` and migrate on load**

In `src/scheduler/cycle.js`, change `freshState`:

```js
function freshState(startingBalance = 1000) {
  return {
    balance: startingBalance, dailyPnl: 0, currentDay: null,
    weeklyPeakBalance: startingBalance, killSwitchActive: false,
    openPositions: [], cooldowns: {}, closedTrades: [],
    shadowPositions: [], disabledSetups: {}, lastRegimeLabel: null,
  };
}
```

In `runCycle`, right after `const state = loadSchedulerState(db, mode) || freshState();`, add defaults for a state loaded from before this plan (milestone 5's persisted blob won't have the three new fields):

```js
const state = loadSchedulerState(db, mode) || freshState();
state.shadowPositions = state.shadowPositions || [];
state.disabledSetups = state.disabledSetups || {};
if (state.lastRegimeLabel === undefined) state.lastRegimeLabel = null;
```

- [ ] **Step 2: Persist every candidate and open its shadow position**

In `runCycle`'s 4h-boundary candidate loop (the block starting `if (regimeLabel && isFourHourBoundary(nowHour) && ...)`), import the new helpers at the top of the file, from `../engine/candidates` and `../broker/shadow` (both already exist from Part A):

```js
const { buildCandidateId, attachContext } = require('../engine/candidates');
const { openShadowPosition, resolveShadowPositions } = require('../broker/shadow');
```

Add these to the existing `require` block at the top of `src/scheduler/cycle.js`, alongside the other Part A/B imports.

Inside the candidate loop, immediately after `const candidate = SETUPS[setupName].evaluate(...)` and its `if (!candidate) continue;` check, before the existing `candidatesCount += 1;` line, insert:

```js
if (state.disabledSetups[setupName] === regimeLabel) continue; // setup disabled for the rest of this regime
const withContext = attachContext(candidate, data.indicators, i);
const fullCandidate = { ...withContext, id: buildCandidateId(nowHour, coin, setupName), mode, regime: regimeLabel, ts: nowHour };
insertCandidate(db, fullCandidate);

const alreadyHasShadow = state.shadowPositions.some((p) => p.candidateId === fullCandidate.id);
if (!alreadyHasShadow) {
  state.shadowPositions.push(openShadowPosition(fullCandidate, data, i));
}
```

(Task 4 replaces the rest of this loop body — the part that currently calls `tryOpenPosition` directly on every candidate — with the `decide()`-gated version. This task only adds persistence and shadow-opening; it does not yet change what happens to real positions.)

Add `insertCandidate` to the `require('../data/db')` destructuring at the top of the file (it already imports `getCandles, loadSchedulerState, saveSchedulerState, insertTrade, insertCycleLog` — add `insertCandidate, updateCandidateShadow` to that same line).

- [ ] **Step 3: Resolve pending shadow positions every cycle**

After the existing "manage open real positions" loop (the block that calls `evaluateExit`/`closePosition` on `state.openPositions`), and before the `state.weeklyPeakBalance = ...` line, add:

```js
const { stillOpen, resolved } = resolveShadowPositions(state.shadowPositions, coinData);
state.shadowPositions = stillOpen;
for (const outcome of resolved) {
  updateCandidateShadow(db, outcome.candidateId, {
    status: 'resolved', exitTs: outcome.exitTs, pnl: outcome.pnl, r: outcome.r, exitReason: outcome.exitReason,
  });
}
```

- [ ] **Step 4: Track regime changes and clear stale setup disables**

Right after the `const dayKey = utcDayKey(nowHour);` daily-reset block, add:

```js
if (state.lastRegimeLabel !== regimeLabel) {
  state.disabledSetups = {}; // "disable for the rest of the current regime" — a new regime clears it
  state.lastRegimeLabel = regimeLabel;
}
```

- [ ] **Step 5: Prove it with a real dry run**

Run (same style as milestone 5's and Part A's real-run proofs — against the actual DB and actual Kraken API, in paper mode):

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
Expected: no `error` field in the result (same shape as before — `{regimeLabel, candidatesCount, openedCount, closedCount}`). If the current real regime is `risk_off` or not a 4h boundary at run time, `candidatesCount` will legitimately be 0 and no candidates/shadows are created this run — that's a correct result, not a failure of this task. Confirm via `sqlite3 data/cryptodash-v2.db "SELECT COUNT(*) FROM candidates;"` that the table exists and is queryable (count may be 0).

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS (all tests unchanged — this task adds no new unit tests of its own, per the Interfaces note; `runCycle`'s existing behavior for everything this task didn't touch must still pass).

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/cycle.js
git commit -m "feat(scheduler): persist candidates and manage shadow positions in runCycle"
```

---

## Task 4: `runCycle` — call `decide()` and apply validated decisions

**Files:**
- Modify: `src/scheduler/cycle.js`
- Modify: `src/engine/config.js`

**Interfaces:**
- Modifies `DEFAULT_RISK_CONFIG` (`src/engine/config.js`): adds `claudeModel: 'claude-sonnet-5'`, `claudeEffort: 'low'`, `claudeTimeoutMs: 30000`.
- Modifies `runCycle`: replaces the current "every candidate is opened via `tryOpenPosition` automatically" behavior with "every candidate is collected, `decide()` is called once if there are any candidates or open positions, and only validated `take` decisions open real positions." Applies `positionActions` (tighten/close) and `setupToggles` (disable) to `state`. Persists one `decisions` row per candidate this cycle (including a synthetic `model: 'fallback'` row for every candidate when `decide()` returns `fallback: true`).
- No test file — proven by Task 5's real dry runs (success and forced-failure), per the same established convention.

- [ ] **Step 1: Add the three new config fields**

In `src/engine/config.js`, add to `DEFAULT_RISK_CONFIG`:

```js
const DEFAULT_RISK_CONFIG = {
  baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
  maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6,
  dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08,
  roundTripFeePct: 0.65,
  claudeModel: 'claude-sonnet-5', claudeEffort: 'low', claudeTimeoutMs: 30000,
};
```

- [ ] **Step 2: Restructure the candidate loop to collect candidates before deciding**

In `src/scheduler/cycle.js`, replace the per-setup immediate-open logic from Task 3 (the block that currently ends in pushing a shadow position, with no real-position call) so that it also collects candidates into a cycle-scoped array, and move the "take" logic to run once after the loop, gated on `decide()`. Replace the entire 4h-boundary block — from `if (regimeLabel && isFourHourBoundary(nowHour) && ...)` through its closing brace — with:

```js
if (regimeLabel && isFourHourBoundary(nowHour) && !state.killSwitchActive && !dailyLossHit && regimeLabel !== 'risk_off') {
  const cycleCandidates = [];
  const candidateContextById = new Map(); // candidateId -> { data, i }, so tryOpenPosition's args are available later without recomputing findIndex
  for (const coin of COINS) {
    const data = coinData[coin];
    const i = data.candles4h.findIndex((c) => c.ts === nowHour);
    if (i === -1) continue;
    for (const setupName of SETUPS_BY_REGIME[regimeLabel] || []) {
      if (state.disabledSetups[setupName] === regimeLabel) continue;
      const candidate = SETUPS[setupName].evaluate(coin, data.candles4h, data.indicators, i, regimeLabel);
      if (!candidate) continue;

      const withContext = attachContext(candidate, data.indicators, i);
      const fullCandidate = { ...withContext, id: buildCandidateId(nowHour, coin, setupName), mode, regime: regimeLabel, ts: nowHour };
      insertCandidate(db, fullCandidate);
      candidatesCount += 1;

      const alreadyHasShadow = state.shadowPositions.some((p) => p.candidateId === fullCandidate.id);
      if (!alreadyHasShadow) state.shadowPositions.push(openShadowPosition(fullCandidate, data, i));

      candidateContextById.set(fullCandidate.id, { data, i });
      cycleCandidates.push(fullCandidate);
    }
  }

  if (cycleCandidates.length > 0 || state.openPositions.length > 0) {
    const recentTrades = getTrades(db, mode).slice(-20);
    const guardrailHeadroom = {
      openPositionsRemaining: config.maxOpenPositions - state.openPositions.length,
      totalRiskPctRemaining: config.maxTotalRiskPct - state.openPositions.reduce((sum, p) => sum + p.riskPct, 0),
    };
    const decisionInput = {
      regime: regimeLabel, regimeMetrics: {}, candidates: cycleCandidates,
      openPositions: state.openPositions.map((p) => ({ coin: p.coin, setup: p.setup, currentStopPrice: p.initialStopPrice })),
      recentTrades: recentTrades.map((t) => ({ coin: t.coin, setup: t.setup, r: t.r, exitReason: t.exitReason })),
      setupConfig: Object.keys(SETUPS).reduce((acc, name) => {
        acc[name] = state.disabledSetups[name] === regimeLabel ? 'disabled_this_regime' : 'active';
        return acc;
      }, {}),
      guardrailHeadroom, setupNames: Object.keys(SETUPS),
    };

    const result = await decide(decisionInput, config);
    const decidedIds = new Set();

    for (const decision of result.decisions) {
      decidedIds.add(decision.candidateId);
      const candidate = cycleCandidates.find((c) => c.id === decision.candidateId);
      if (!candidate) continue; // defensive: parseDecisionResponse already guarantees this won't happen
      const diverged = decision.action !== candidate.default.action
        || (decision.action === 'take' && (decision.size !== candidate.default.size || decision.stopAtr !== candidate.default.stopAtr));

      insertDecision(db, {
        candidateId: candidate.id, ts: nowHour, mode, action: decision.action,
        size: decision.size ?? null, stopAtr: decision.stopAtr ?? null, trailAtr: decision.trailAtr ?? null,
        reason: decision.reason, plainReason: decision.plainReason, defaultAction: candidate.default.action,
        diverged, model: config.claudeModel, latencyMs: 0, rawResponse: JSON.stringify(decision),
      });

      if (decision.action === 'take') {
        const adjustedCandidate = {
          ...candidate,
          default: { ...candidate.default, size: decision.size, stopAtr: decision.stopAtr, trailAtr: decision.trailAtr ?? candidate.default.trailAtr },
        };
        const { data, i } = candidateContextById.get(candidate.id);
        const before = state.openPositions.length;
        tryOpenPosition(state, adjustedCandidate, data, i, config);
        if (state.openPositions.length > before) openedCount += 1;
      }
    }

    for (const candidate of cycleCandidates) {
      if (decidedIds.has(candidate.id)) continue;
      insertDecision(db, {
        candidateId: candidate.id, ts: nowHour, mode, action: 'skip',
        size: null, stopAtr: null, trailAtr: null,
        reason: result.fallback ? (result.error || 'fallback') : 'not in decisions (unknown id or invalid action, dropped by parseDecisionResponse)',
        plainReason: result.fallback ? 'Sat out this hour after a problem talking to the decision model.' : 'Sat out.',
        defaultAction: candidate.default.action, diverged: false,
        model: result.fallback ? 'fallback' : config.claudeModel, latencyMs: 0, rawResponse: JSON.stringify(result),
      });
    }

    for (const action of result.positionActions) {
      const position = state.openPositions.find((p) => p.coin === action.coin && p.setup === action.setup);
      if (!position) continue;
      if (action.action === 'close') {
        const closingBar = coinData[position.coin].candles4h.find((c) => c.ts === nowHour);
        if (!closingBar) continue; // no 4h candle at this exact ts for this coin — skip rather than crash on undefined.close
        closePosition(state, position, { exitTs: nowHour, exitPrice: closingBar.close, reason: 'claude_close' }, config);
        closedCount += 1;
      } else if (action.action === 'tighten_stop') {
        position.initialStopPrice = Math.max(position.initialStopPrice, action.newStopPrice);
      }
    }

    for (const toggle of result.setupToggles) {
      if (toggle.action === 'disable_setup') state.disabledSetups[toggle.setup] = regimeLabel;
    }
  }
}
```

Add `decide` (from `../engine/decide`) and `insertDecision`, `getTrades` (from `../data/db` — `getTrades` is already exported from Part A's milestone-5 work, just not yet imported into this file) to the top-of-file `require`s.

- [ ] **Step 2: Run the full test suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS (all tests unchanged — no new unit tests in this task; `runCycle`'s correctness for this new branch is proven in Task 5)

- [ ] **Step 3: Commit**

```bash
git add src/scheduler/cycle.js src/engine/config.js
git commit -m "feat(scheduler): call decide() and apply validated take/skip/positionActions/setupToggles"
```

---

## Task 5: Prove the milestone-6 gate — real success run and forced-fallback run

**Files:** none modified — this task is verification only, against the real Pi-equivalent environment (this sandbox, already authenticated the same way the Pi is).

**Interfaces:** none produced — this task's output is the evidence the milestone-6 "Done when" gate requires: "Decision log filling up; fallbacks tested."

- [ ] **Step 1: Confirm current regime/candidate state so the real run's outcome is interpretable**

Run: `sqlite3 data/cryptodash-v2.db "SELECT regime_label, candidates_count, ts FROM cycle_log ORDER BY ts DESC LIMIT 3;"`
Expected: shows the most recent real cycles' regime and candidate counts (from the already-running Pi service or this session's own prior real runs) — use this to know whether the next real run below is likely to actually exercise the `decide()` call (needs `regimeLabel !== 'risk_off'` and a 4h boundary) or will legitimately skip it.

- [ ] **Step 2: Real success run**

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
Expected: no `error` field. If the regime at run time has candidates, confirm via `sqlite3 data/cryptodash-v2.db "SELECT * FROM decisions ORDER BY ts DESC LIMIT 5;"` that at least one `decisions` row was written with `model = 'claude-sonnet-5'` (not `'fallback'`) — this is the "decision log filling up" half of the gate. If the regime has no candidates and no open positions at run time, `decide()` is correctly never called (per this plan's cost-control rule) — in that case, prove the call path separately with a direct, synthetic-input call:

```bash
node -e "
const { decide } = require('./src/engine/decide');
(async () => {
  const result = await decide({
    regime: 'trend_up', regimeMetrics: {}, openPositions: [], recentTrades: [], setupConfig: {}, guardrailHeadroom: {},
    candidates: [{ id: 'c_test_BTC_trend_pullback', coin: 'BTC', setup: 'trend_pullback',
      default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
      ranges: { size: [0,1], stopAtr: [1.0,3.0], trailAtr: [1.5,4.0] } }],
    setupNames: ['trend_pullback'],
  }, { claudeModel: 'claude-sonnet-5', claudeEffort: 'low', claudeTimeoutMs: 30000 });
  console.log(JSON.stringify(result, null, 2));
})();
"
```
Expected: `fallback: false`, a `decisions` array (possibly empty if Claude chose to skip the synthetic candidate — that's a valid real decision, not a test failure).

- [ ] **Step 3: Forced-fallback run — prove "fallbacks tested"**

Run the same direct `decide()` call as Step 2, but with a deliberately invalid model name to force a real CLI failure:

```bash
node -e "
const { decide } = require('./src/engine/decide');
(async () => {
  const result = await decide({
    regime: 'trend_up', regimeMetrics: {}, openPositions: [], recentTrades: [], setupConfig: {}, guardrailHeadroom: {},
    candidates: [], setupNames: [],
  }, { claudeModel: 'not-a-real-model-id', claudeEffort: 'low', claudeTimeoutMs: 30000 });
  console.log(JSON.stringify(result, null, 2));
})();
"
```
Expected: `fallback: true`, a non-empty `error` string (the real CLI's actual rejection message for an invalid model). This is a real, not simulated, failure of the real call path.

- [ ] **Step 4: Confirm a forced-fallback `runCycle` still completes safely and logs the attempt**

Run (same as Step 2's `runCycle` call, but temporarily — for this one verification call only — pass a config with the bad model id, to force a real end-to-end fallback through the full cycle, not just the direct `decide()` call):

```bash
node -e "
const { openDb } = require('./src/data/db');
const { createRestClient } = require('./src/kraken/rest');
const { runCycle } = require('./src/scheduler/cycle');
const { DEFAULT_RISK_CONFIG } = require('./src/engine/config');
(async () => {
  const db = openDb();
  const client = createRestClient({});
  const badConfig = { ...DEFAULT_RISK_CONFIG, claudeModel: 'not-a-real-model-id' };
  const result = await runCycle(db, client, 'paper', badConfig);
  console.log(JSON.stringify(result, null, 2));
})();
"
```
Expected: no thrown exception reaches the shell (the command exits 0); the printed result has no top-level `error` field UNLESS something outside the Claude call itself also failed (ingestion, DB) — `runCycle`'s own try/catch (from milestone 5) still wraps the whole cycle, and a `decide()` fallback is handled *inside* that try block, not re-thrown. If this cycle had candidates, confirm via `sqlite3 data/cryptodash-v2.db "SELECT model, action, reason FROM decisions ORDER BY ts DESC LIMIT 5;"` that the rows from this run show `model = 'fallback'`. If this cycle legitimately had zero candidates and zero open positions (regime-dependent, same caveat as Step 2), this step still confirms the no-throw, clean-`cycle_log` behavior even though no `decisions` rows are produced — note which case occurred in the task's completion evidence.

- [ ] **Step 5: Run the full test suite one final time**

Run: `node --test test/`
Expected: PASS (unchanged from Task 4 — this task adds no code, only verification evidence)

---

## Part B exit check

- [ ] `node --test test/` passes throughout (no regressions from any task).
- [ ] A real `claude -p` call has succeeded at least once via `callClaudeCli`/`decide()` (Task 1 Step 5, Task 5 Step 2).
- [ ] A real `claude -p` call has been forced to fail and correctly produced `fallback: true` with no real position opened, at least once (Task 5 Step 3), and a full `runCycle` has absorbed that fallback without throwing (Task 5 Step 4) — satisfies milestone 6's "fallbacks tested."
- [ ] `candidates` and `decisions` tables have real rows from this plan's execution (not just Part A's unit-test `:memory:` databases) — satisfies "Decision log filling up."
- [ ] Shadow positions open and resolve against real candles, independent of whether Claude's real decision was `take` or `skip`.
