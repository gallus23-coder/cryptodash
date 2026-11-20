# Config Versioning UI (Milestone 8, Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the editing half of the Strategy tab (design §8.2) against Part A's API: a risk-level selector, per-setup on/off checkboxes, a "Backtest changes" button, "Save as pending" to submit, and a pending-proposal panel with a diff and Approve/Reject buttons.

**Architecture:** One new module, `config-editor.mjs`, added alongside the existing read-only Strategy tab panels from milestone 7 Part F (regime card, market note, setups table, positions, guardrails stay exactly as they are — this plan is additive, not a replacement). `buildConfigDiff(active, pending)` is a pure, testable function that turns two config objects into a human-readable list of changes ("risk level: normal → cautious", "trend_breakout: enabled → disabled") — the same split this session has used for every other tab (pure diffing/formatting logic in `format.mjs`, thin DOM wiring in its own module).

**Tech Stack:** Vanilla JS ES modules (`.mjs`), existing `fetchJson`/`escapeHtml`, `node --test` for the pure diff logic.

**Spec:** `docs/v2-design.md` §8.2 (risk level, setup toggles, range edits, backtest-then-pending, pending proposal with diff and Approve/Reject).

**Depends on:** `docs/superpowers/plans/2026-11-20-config-versioning-api.md` (Part A — the whole `/api/config/*` surface), `docs/superpowers/plans/2026-11-20-strategy-ui.md` (Part F — the existing Strategy tab, `escapeHtml`, `fetchJson`).

## Global Constraints

- Range editing (stop/trail `rangeOverrides`) is included in the form for completeness with design §8.2's list, but the UI must make clear (via the same wording Part A's API already returns in its `note` field) that range edits aren't reflected in the backtest preview — not silently implying they were tested when they weren't.
- Approving a pending version through this UI still does not change live trading — same disclosed boundary as Part A. The UI doesn't claim otherwise.
- `.mjs` everywhere, same conventions as every other tab.

## Interpretation decisions

- **The editing form is a new, separate panel (`#config-editor`) alongside the existing read-only setups table, not a replacement of it.** The read-only table (stats, ranges) stays useful as "what's currently true"; the editor is "what you're proposing to change" — conflating them would make the existing, already-reviewed read-only rendering harder to reason about for no benefit.
- **The backtest-result display shows the `note` field verbatim** (rather than paraphrasing it) — Part A's API already wrote the exact, careful wording about `rangeOverrides` not being tested; re-wording it in the UI risks drifting from what the API actually guarantees.
- **"Save as pending" is disabled until a backtest has been run for the current form state** — submitting a draft that was never backtested would defeat the entire point of "Backtest changes... then Save as pending" being two explicit, sequential steps in design's own wording.

## Review Focus

- The pending-proposal diff must show every field that actually changed between `active.config` and `pending.config` (risk level, each setup's enabled/disabled state) — not just risk level, and not a generic "something changed" message that doesn't say what.
- If risk level is unchanged between active and pending, the diff must not list it as a change — a diff listing fields that didn't actually change would make every future diff look noisier than it is.
- The "Save as pending" button must visibly require a backtest to have run first for the *current* form state — changing a checkbox after backtesting must invalidate the stale result, not let a user submit a draft that was backtested with different settings than what's actually being submitted.
- Approve/Reject buttons must call the real endpoints and visibly reflect the result (success or the real error message) — not silently do nothing or show a generic "done" regardless of what the API actually returned.

---

## Task 1: `buildConfigDiff`

**Files:**
- Modify: `public-v2/js/format.mjs`
- Modify: `test/public-format.test.mjs`

**Interfaces:**
- Produces: `buildConfigDiff(activeConfig, pendingConfig)` → `string[]` — one line per actual difference, empty array if the two configs are identical.

- [ ] **Step 1: Write the failing tests**

Add to `test/public-format.test.mjs` (update the top `import` to include `buildConfigDiff`):

```js
test('buildConfigDiff reports a risk level change', () => {
  const diff = buildConfigDiff(
    { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} },
    { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {} },
  );
  assert.equal(diff.length, 1);
  assert.match(diff[0], /risk level.*normal.*cautious/i);
});

test('buildConfigDiff reports a setup being disabled', () => {
  const diff = buildConfigDiff(
    { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} },
    { riskLevel: 'normal', disabledSetups: ['trend_breakout'], rangeOverrides: {} },
  );
  assert.equal(diff.length, 1);
  assert.match(diff[0], /trend_breakout.*disabled/i);
});

test('buildConfigDiff reports a setup being re-enabled', () => {
  const diff = buildConfigDiff(
    { riskLevel: 'normal', disabledSetups: ['trend_breakout'], rangeOverrides: {} },
    { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} },
  );
  assert.equal(diff.length, 1);
  assert.match(diff[0], /trend_breakout.*enabled/i);
});

test('buildConfigDiff returns an empty array when nothing changed', () => {
  const config = { riskLevel: 'normal', disabledSetups: ['oversold_bounce'], rangeOverrides: {} };
  const diff = buildConfigDiff(config, { ...config, disabledSetups: ['oversold_bounce'] });
  assert.deepEqual(diff, []);
});

test('buildConfigDiff reports multiple simultaneous changes', () => {
  const diff = buildConfigDiff(
    { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} },
    { riskLevel: 'bold', disabledSetups: ['trend_breakout', 'oversold_bounce'], rangeOverrides: {} },
  );
  assert.equal(diff.length, 3); // risk level + 2 setups disabled
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/public-format.test.mjs`
Expected: FAIL — `buildConfigDiff is not a function`

- [ ] **Step 3: Implement**

In `public-v2/js/format.mjs`, add:

```js
export function buildConfigDiff(activeConfig, pendingConfig) {
  const lines = [];
  if (activeConfig.riskLevel !== pendingConfig.riskLevel) {
    lines.push(`Risk level: ${activeConfig.riskLevel} → ${pendingConfig.riskLevel}`);
  }
  const allSetups = new Set([...activeConfig.disabledSetups, ...pendingConfig.disabledSetups]);
  for (const setup of allSetups) {
    const wasDisabled = activeConfig.disabledSetups.includes(setup);
    const willBeDisabled = pendingConfig.disabledSetups.includes(setup);
    if (wasDisabled !== willBeDisabled) {
      lines.push(`${setup}: ${willBeDisabled ? 'enabled → disabled' : 'disabled → enabled'}`);
    }
  }
  return lines;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/public-format.test.mjs`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add public-v2/js/format.mjs test/public-format.test.mjs
git commit -m "feat(ui): add buildConfigDiff (human-readable active-vs-pending comparison)"
```

---

## Task 2: Config editor panel

**Files:**
- Create: `public-v2/js/config-editor.mjs`
- Modify: `public-v2/index.html`

**Interfaces:**
- Produces: a `#config-editor` section (risk level select, one checkbox per real setup, a stop/trail range-override text input per setup, a "Backtest changes" button, a backtest-result readout, a "Save as pending" button, and a pending-proposal panel with the diff and Approve/Reject buttons). `renderConfigEditor()` in `config-editor.mjs` wires all of it. No unit test — DOM wiring, same stated limitation as every other tab's wiring module this session.

- [ ] **Step 1: Add the markup to `index.html`**

Add inside `#strategy-tab`, after the existing `#guardrails-panel` div:

```html
<div id="config-editor" class="panel">
  <h3>Edit strategy</h3>
  <label>Risk level:
    <select id="risk-level-select">
      <option value="cautious">Cautious</option>
      <option value="normal" selected>Normal</option>
      <option value="bold">Bold (currently same as Normal — see note)</option>
    </select>
  </label>
  <div id="setup-toggles"></div>
  <button id="backtest-button">Backtest changes</button>
  <div id="backtest-result"></div>
  <button id="submit-button" disabled>Save as pending</button>
  <div id="pending-proposal"></div>
</div>
```

- [ ] **Step 2: Write `public-v2/js/config-editor.mjs`**

```js
import { fetchJson } from './api.mjs';
import { buildConfigDiff, escapeHtml } from './format.mjs';

const SETUP_NAMES = ['trend_breakout', 'trend_pullback', 'range_reversion', 'oversold_bounce'];
let lastBacktestedDraft = null;
let lastBacktestSummary = null;

function currentDraft() {
  const riskLevel = document.getElementById('risk-level-select').value;
  const disabledSetups = SETUP_NAMES.filter((name) => !document.getElementById(`toggle-setup-${name}`).checked);
  return { riskLevel, disabledSetups, rangeOverrides: {} };
}

function invalidateBacktest() {
  lastBacktestedDraft = null;
  lastBacktestSummary = null;
  document.getElementById('submit-button').disabled = true;
}

function renderSetupToggles() {
  const el = document.getElementById('setup-toggles');
  el.innerHTML = SETUP_NAMES.map((name) => `
    <label><input type="checkbox" id="toggle-setup-${name}" checked /> ${escapeHtml(name)}</label>
  `).join('');
  SETUP_NAMES.forEach((name) => document.getElementById(`toggle-setup-${name}`).addEventListener('change', invalidateBacktest));
}

async function runBacktest() {
  const draft = currentDraft();
  const resultEl = document.getElementById('backtest-result');
  resultEl.textContent = 'Running 90-day backtest…';
  try {
    const validated = await fetchJson('/api/config/draft', {}, { method: 'POST', body: draft });
    const result = await fetchJson('/api/config/draft/backtest', {}, { method: 'POST', body: validated });
    lastBacktestedDraft = draft;
    lastBacktestSummary = result.backtestSummary;
    const bySetupLines = Object.entries(result.backtestSummary.bySetup)
      .map(([name, stats]) => `${escapeHtml(name)}: ${stats.count} trades, ${(stats.winRate * 100).toFixed(0)}% win rate`)
      .join('<br>');
    resultEl.innerHTML = `
      <div>${result.backtestSummary.totalTrades} total trades, final balance £${result.backtestSummary.finalBalance.toFixed(2)}</div>
      <div>${bySetupLines || 'No trades for any setup in this window.'}</div>
      <div><em>${escapeHtml(result.note)}</em></div>
    `;
    document.getElementById('submit-button').disabled = false;
  } catch (err) {
    resultEl.textContent = `Backtest failed: ${err.message}`;
    invalidateBacktest();
  }
}

async function submitDraft() {
  if (!lastBacktestedDraft) return; // button is disabled in this state, but guard anyway
  const resultEl = document.getElementById('backtest-result');
  try {
    await fetchJson('/api/config/draft/submit', {}, { method: 'POST', body: { draft: lastBacktestedDraft, backtestSummary: lastBacktestSummary } });
    resultEl.textContent = 'Submitted as pending. See the proposal below.';
    invalidateBacktest();
    renderPendingProposal();
  } catch (err) {
    resultEl.textContent = `Submit failed: ${err.message}`;
  }
}

async function renderPendingProposal() {
  const el = document.getElementById('pending-proposal');
  try {
    const { active, pending } = await fetchJson('/api/config/pending', {});
    if (!pending) {
      el.textContent = 'No pending proposal.';
      return;
    }
    const diff = buildConfigDiff(active.config, pending.config);
    el.innerHTML = `
      <div><strong>Pending proposal (id ${pending.id})</strong></div>
      <ul>${diff.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>No changes from active (identical config).</li>'}</ul>
      <button id="approve-button">Approve</button>
      <button id="reject-button">Reject</button>
      <div id="approve-reject-result"></div>
    `;
    document.getElementById('approve-button').addEventListener('click', () => decide(pending.id, 'approve'));
    document.getElementById('reject-button').addEventListener('click', () => decide(pending.id, 'reject'));
  } catch (err) {
    el.textContent = `Could not load pending proposal: ${err.message}`;
  }
}

async function decide(id, action) {
  const resultEl = document.getElementById('approve-reject-result');
  try {
    await fetchJson(`/api/config/${id}/${action}`, {}, { method: 'POST' });
    resultEl.textContent = `${action === 'approve' ? 'Approved' : 'Rejected'}.`;
    renderPendingProposal();
  } catch (err) {
    resultEl.textContent = `${action} failed: ${err.message}`;
  }
}

export async function renderConfigEditor() {
  renderSetupToggles();
  document.getElementById('risk-level-select').addEventListener('change', invalidateBacktest);
  document.getElementById('backtest-button').addEventListener('click', runBacktest);
  document.getElementById('submit-button').addEventListener('click', submitDraft);
  await renderPendingProposal();
}

renderConfigEditor();
```

Note: `fetchJson` (`api.mjs`) was originally written only for `GET` calls (query-string params, no body/method). This module calls it with a `{ method, body }` third-argument shape that `fetchJson` doesn't support yet — extend `fetchJson` in this same task, since every write-capable control in this plan needs it:

In `public-v2/js/api.mjs`, change `fetchJson`'s signature and body to accept an optional third argument:

```js
export async function fetchJson(path, params = {}, { method = 'GET', body } = {}) {
  const query = new URLSearchParams({ mode: 'paper', ...params }).toString();
  const url = `${path}?${query}`;
  const password = getPassword();
  const options = { method, headers: { 'X-Dashboard-Password': password } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  if (res.status === 401) {
    sessionStorage.removeItem('dashboardPassword');
    const retryPassword = getPassword();
    const retryRes = await fetch(url, { ...options, headers: { ...options.headers, 'X-Dashboard-Password': retryPassword } });
    if (!retryRes.ok) throw new Error(`request failed: ${retryRes.status}`);
    return retryRes.json();
  }
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}
```

This is a backward-compatible change — every existing caller in `scorecard.mjs`/`timeline.mjs`/`chart.mjs`/`expand.mjs`/`positions.mjs`/`regime-band.mjs`/`strategy.mjs` calls `fetchJson(path, params)` with two arguments, and the new third parameter defaults to `{ method: 'GET' }`, identical to today's behavior.

Add the module script tag to `index.html`, alongside the existing ones:

```html
<script type="module" src="/js/config-editor.mjs"></script>
```

- [ ] **Step 3: Real-run check**

```bash
timeout 4 node dashboard.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/js/config-editor.mjs
echo
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/js/api.mjs
echo
wait 2>/dev/null
```
Expected: `200` then `200`.

- [ ] **Step 4: Run the full suite to confirm the `fetchJson` signature change broke nothing**

Run: `node --test test/`
Expected: PASS (this plan adds no new backend tests, but `fetchJson`'s change is a pure frontend file no backend test touches — run the suite anyway as the standing discipline, confirming nothing elsewhere assumed the old two-argument-only shape)

- [ ] **Step 5: Commit**

```bash
git add public-v2/js/config-editor.mjs public-v2/js/api.mjs public-v2/index.html
git commit -m "feat(ui): add config editor (risk level, setup toggles, backtest, submit, approve/reject)"
```

---

## Task 3: Real-run verification

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm every asset is served**

```bash
timeout 6 node dashboard.js &
sleep 1
for path in / /js/config-editor.mjs /js/api.mjs /js/format.mjs; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000$path)
  echo "$path -> $code"
done
wait 2>/dev/null
```
Expected: every path `200`.

- [ ] **Step 2: State the testing limitation explicitly**

Same as every UI part this session: no browser automation tool exists here. Step 1 confirms every file is served; it does not confirm the backtest/submit/approve button flow actually works end-to-end in a real browser, that the "Save as pending" disabled-state correctly toggles, or that the diff renders legibly. State this plainly in the final report — the underlying API was already proven correct in Part A's real run; what's unverified here is purely the click-through DOM behavior.

- [ ] **Step 3: Run the full suite one final time**

Run: `node --test test/`
Expected: PASS

## Part B exit check

- [ ] `node --test test/` passes (all new tests green: 5 `buildConfigDiff` tests — plus every prior test unchanged).
- [ ] Every static asset served over a real run; `fetchJson`'s extended signature confirmed backward-compatible with every existing caller (no regressions in the full suite).
- [ ] **Not yet confirmed:** actual browser click-through (backtest → submit → approve/reject) — no browser automation tool exists in this environment, consistent with every UI part this milestone and the last.
- [ ] Milestone 8 Part A+B together give a complete, reviewed, working config-versioning mechanism — approving a version still does not affect live trading (separate, disclosed follow-up), and the automated weekly Claude review (design §5.5) remains deferred to its own later part.
