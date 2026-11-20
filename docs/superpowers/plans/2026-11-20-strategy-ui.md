# Strategy UI (Milestone 7, Part F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Strategy tab (design §8.2), read-only, against Part E's API: regime card, market note (plain vs technical side by side), active setups with their ranges and 30/90-day stats, open positions, and guardrail headroom. This is the third and final milestone-7 tab — once this lands, all three tabs (Decision log, Charts, Strategy) exist on live paper data.

**Architecture:** One new `.mjs` module (`strategy.mjs`) renders five sections from two API calls (`GET /api/strategy`, `GET /api/regime/history` — already fetched for the Charts tab's regime band, reused here to compute "how long the current regime has held"). `buildRegimeSegments` (already built and tested for the Charts tab) is reused directly rather than reimplemented — the same segment-collapsing logic answers both "what color strip to draw" and "how long has the current segment been active." Pure formatting helpers (duration string, guardrail usage bar text) go in `format.mjs` alongside every other tab's pure logic; DOM wiring is untested per this session's stated, unavoidable limitation (no browser automation tool exists here).

**Tech Stack:** Vanilla JS ES modules (`.mjs`), existing `public-v2/js/api.mjs`'s `fetchJson`, `node --test` for the pure helpers.

**Spec:** `docs/v2-design.md` §8.2 (Current strategy tab).

**Depends on:** `docs/superpowers/plans/2026-11-20-strategy-api.md` (Part E — `GET /api/strategy`, `GET /api/regime/history`/`current`, `GET /api/positions`), `docs/superpowers/plans/2026-11-20-charts-ui.md` (Part D — `buildRegimeSegments`, the `.mjs`-everywhere convention, `fetchJson`).

## Global Constraints

- Read-only — no button on this tab calls a write endpoint, because none of the write endpoints (`POST /api/control/*`, `POST /api/config/*`) exist yet. This includes design's "manual pause button" under Guardrails — pausing is a control action with no backing `POST /api/control/pause`, so it's deferred alongside everything else design puts under "Strategy controls," not built as a dead button that does nothing when clicked.
- No CDN, `.mjs` everywhere, same conventions as the other two tabs.

## Interpretation decisions

- **"How long it's held" (design's regime card) is computed client-side from `GET /api/regime/history`'s existing data** (`buildRegimeSegments`'s last segment, `now - segment.fromTs`), not a new API field — the data to answer this is already being fetched for the Charts tab's regime band, and duration-since-fromTs is a one-line computation, not worth a new endpoint.
- **"Market note in two versions, side by side"** renders `plainNote` (mood/bullets/botAction) and `marketNote` (the technical string) in two adjacent panels when `GET /api/strategy`'s `marketNote` field is non-null; when it's `null` (every real cycle so far — `risk_off` throughout, no real `decide()` call has happened), the section shows "No market note yet — Claude hasn't been consulted this session" rather than two empty panels that look broken.
- **Setup stats show 30d and 90d side by side**, both already computed server-side by Part E; no client-side date-window logic needed.
- **Guardrail usage is shown as "`used` / `max`" text plus a simple percentage bar**, not a chart — this is a status readout, not something that needs `lightweight-charts`.

## Review Focus

- A setup with `stats30d.count === 0` must render "no trades yet" or equivalent, not `0%` win rate presented as if it were a meaningful (bad) statistic — `0/0` and "0 wins out of a real sample" are different facts, same distinction Part E's API itself already protects (`computeExpectancy`'s `count: 0` field exists precisely so callers can tell the difference).
- The regime card's "how long it's held" must handle the case where `GET /api/regime/history` returns zero rows (a fresh install with no cycles logged yet) without throwing — "not yet known," not a crash or a negative duration.
- The guardrail bars must render correctly when `used > max` is impossible by construction (guardrails are enforced in code before a position opens) but also must not break visually if `used` ever equals `max` exactly (100% bar, not an overflow).
- Every fetch on this tab must use the same password-prompt `fetchJson` path the other two tabs use — no separate, unauthenticated fetch calls bypassing the established auth flow.
- The "pause button" and all other write-action controls design describes for this tab must be visibly absent or clearly marked unavailable, not present-but-nonfunctional — a button that does nothing when clicked is worse than no button, since it implies a feature exists when it doesn't.

---

## Task 1: Pure formatting helpers

**Files:**
- Modify: `public-v2/js/format.mjs`
- Modify: `test/public-format.test.mjs`

**Interfaces:**
- Produces: `formatRegimeDuration(historyRows, nowTs)` → string (e.g. `"held for 3h"`, `"not yet known"` for empty history) using `buildRegimeSegments` internally. `formatSetupStats(stats)` → string (e.g. `"12 trades, 58% win rate, +0.34R expectancy"` or `"No trades yet"` for `count === 0`). `formatGuardrailUsage({ used, max })` → `{ text, pct }` (e.g. `{ text: "1 / 3", pct: 33 }`).

- [ ] **Step 1: Write the failing tests**

Add to `test/public-format.test.mjs` (update the top `import` to include the three new names):

```js
test('formatRegimeDuration reports "not yet known" when there is no regime history at all', () => {
  assert.equal(formatRegimeDuration([], 10000), 'not yet known');
});

test('formatRegimeDuration reports how long the current (last) segment has been active', () => {
  const rows = [{ ts: 0, label: 'risk_off' }, { ts: 3600, label: 'risk_off' }, { ts: 7200, label: 'trend_up' }];
  const nowTs = 7200 + 3600; // 1h into the trend_up segment
  const result = formatRegimeDuration(rows, nowTs);
  assert.match(result, /1h/);
});

test('formatSetupStats reports "No trades yet" for a zero-count stat, not a 0% win rate', () => {
  const result = formatSetupStats({ count: 0, winRate: 0, expectancy: 0, pass: false });
  assert.match(result, /no trades yet/i);
  assert.doesNotMatch(result, /0%/);
});

test('formatSetupStats reports count/winRate/expectancy for a real sample', () => {
  const result = formatSetupStats({ count: 12, winRate: 0.58, expectancy: 0.34, pass: false });
  assert.match(result, /12/);
  assert.match(result, /58%/);
  assert.match(result, /\+0\.34R/);
});

test('formatGuardrailUsage reports a "used / max" text and a percentage, capped at 100', () => {
  assert.deepEqual(formatGuardrailUsage({ used: 1, max: 3 }), { text: '1 / 3', pct: 33 });
  assert.deepEqual(formatGuardrailUsage({ used: 0.015, max: 0.015 }), { text: '0.015 / 0.015', pct: 100 });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/public-format.test.mjs`
Expected: FAIL — `formatRegimeDuration is not a function`

- [ ] **Step 3: Implement**

In `public-v2/js/format.mjs`, add:

```js
export function formatRegimeDuration(historyRows, nowTs) {
  const segments = buildRegimeSegments(historyRows);
  if (segments.length === 0) return 'not yet known';
  const current = segments[segments.length - 1];
  const heldSeconds = nowTs - current.fromTs;
  const hours = Math.floor(heldSeconds / 3600);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${current.label}, held for ${days}d ${hours % 24}h`;
  return `${current.label}, held for ${hours}h`;
}

export function formatSetupStats(stats) {
  if (stats.count === 0) return 'No trades yet.';
  return `${stats.count} trades, ${Math.round(stats.winRate * 100)}% win rate, ${formatR(stats.expectancy)} expectancy`;
}

export function formatGuardrailUsage({ used, max }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return { text: `${used} / ${max}`, pct };
}
```

(`buildRegimeSegments` is already defined earlier in this same file from the Charts tab plan — no new import needed, just a direct call.)

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/public-format.test.mjs`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add public-v2/js/format.mjs test/public-format.test.mjs
git commit -m "feat(ui): add regime-duration, setup-stats, and guardrail-usage formatters"
```

---

## Task 2: Strategy tab rendering

**Files:**
- Create: `public-v2/js/strategy.mjs`
- Modify: `public-v2/index.html`

**Interfaces:**
- Produces: a `#strategy-tab` section in `index.html` (regime card, market note, setups table, open positions, guardrails); `renderStrategyTab()` in `strategy.mjs` fetching `GET /api/strategy`, `GET /api/regime/current`, `GET /api/regime/history`, and `GET /api/positions`, rendering each section. No unit test — DOM wiring, same stated limitation as the other two tabs' chart/timeline modules.

- [ ] **Step 1: Add the markup to `index.html`**

Add a new section to `<main>`, after the existing `#charts-tab` section:

```html
<section id="strategy-tab">
  <div id="regime-card" class="panel">Loading regime…</div>
  <div id="market-note" class="panel">Loading market note…</div>
  <div id="setups-table" class="panel">Loading setups…</div>
  <div id="open-positions" class="panel">Loading positions…</div>
  <div id="guardrails-panel" class="panel">Loading guardrails…</div>
</section>
```

Add these rules inside the existing `<head>` `<style>` block (the one already holding `#scorecard`/`#chart-controls`/etc. rules from the earlier two tabs) — not a new, separate `<style>` tag:

```css
  .panel { border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 14px; margin-bottom: 14px; }
  .panel table { width: 100%; border-collapse: collapse; }
  .panel td, .panel th { padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  .guardrail-bar-track { background: var(--border); border-radius: 4px; height: 8px; overflow: hidden; margin-top: 4px; }
  .guardrail-bar-fill { background: var(--accent); height: 100%; }
```

Add the module script tag alongside the other two:

```html
<script type="module" src="/js/strategy.mjs"></script>
```

- [ ] **Step 2: Write `public-v2/js/strategy.mjs`**

```js
import { fetchJson } from './api.mjs';
import { formatRegimeDuration, formatSetupStats, formatGuardrailUsage, formatR, escapeHtml } from './format.mjs';

async function renderRegimeCard() {
  const el = document.getElementById('regime-card');
  try {
    const [current, history] = await Promise.all([
      fetchJson('/api/regime/current', {}),
      fetchJson('/api/regime/history', {}),
    ]);
    const duration = formatRegimeDuration(history, Math.floor(Date.now() / 1000));
    const metricsLine = current.metrics
      ? `ADX ${current.metrics.adx?.toFixed(1) ?? '—'} · breadth ${current.metrics.breadthPct ?? '—'}% · vol rank ${current.metrics.volatilityRankPct?.toFixed(0) ?? '—'}%`
      : 'No metrics yet.';
    el.innerHTML = `<strong>Regime: ${current.label ?? 'unknown'}</strong><div>${duration}</div><div>${metricsLine}</div>`;
  } catch (err) {
    el.textContent = `Could not load regime: ${err.message}`;
  }
}

async function renderMarketNote(strategy) {
  const el = document.getElementById('market-note');
  if (!strategy.marketNote) {
    el.textContent = 'No market note yet — Claude hasn\'t been consulted this session.';
    return;
  }
  const { marketNote, plainNote } = strategy.marketNote;
  const bullets = plainNote?.bullets?.map((b) => `<li>${escapeHtml(b)}</li>`).join('') || '';
  el.innerHTML = `
    <div style="display:flex;gap:16px;">
      <div style="flex:1;"><strong>Plain English</strong><div>${escapeHtml(plainNote?.mood || '')}</div><ul>${bullets}</ul><div>${escapeHtml(plainNote?.botAction || '')}</div></div>
      <div style="flex:1;"><strong>Technical</strong><div>${escapeHtml(marketNote)}</div></div>
    </div>
  `;
}

function renderSetupsTable(strategy) {
  const el = document.getElementById('setups-table');
  el.innerHTML = `
    <table>
      <thead><tr><th>Setup</th><th>Ranges</th><th>30d</th><th>90d</th></tr></thead>
      <tbody>
        ${strategy.setups.map((s) => `
          <tr>
            <td>${escapeHtml(s.name)}</td>
            <td>size ${JSON.stringify(s.ranges.size)}, stop ${JSON.stringify(s.ranges.stopAtr)}${s.ranges.trailAtr ? `, trail ${JSON.stringify(s.ranges.trailAtr)}` : ''}</td>
            <td>${escapeHtml(formatSetupStats(s.stats30d))}</td>
            <td>${escapeHtml(formatSetupStats(s.stats90d))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderOpenPositions(positions) {
  const el = document.getElementById('open-positions');
  if (positions.length === 0) {
    el.textContent = 'No open positions.';
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Coin</th><th>Setup</th><th>Entry</th><th>Stop</th></tr></thead>
      <tbody>
        ${positions.map((p) => `<tr><td>${escapeHtml(p.coin)}</td><td>${escapeHtml(p.setup)}</td><td>${p.entryPrice}</td><td>${p.initialStopPrice}</td></tr>`).join('')}
      </tbody>
    </table>
  `;
}

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
    <div>${g.killSwitchActive ? '<strong style="color:#ef4444;">KILL SWITCH ACTIVE</strong>' : 'Kill switch: inactive'}</div>
    ${rows.map(([label, { text, pct }]) => `
      <div>${escapeHtml(label)}: ${escapeHtml(text)}
        <div class="guardrail-bar-track"><div class="guardrail-bar-fill" style="width:${pct}%;"></div></div>
      </div>
    `).join('')}
  `;
}

export async function renderStrategyTab() {
  await renderRegimeCard();
  try {
    const [strategy, positions] = await Promise.all([
      fetchJson('/api/strategy', {}),
      fetchJson('/api/positions', {}),
    ]);
    await renderMarketNote(strategy);
    renderSetupsTable(strategy);
    renderOpenPositions(positions);
    renderGuardrails(strategy);
  } catch (err) {
    document.getElementById('setups-table').textContent = `Could not load strategy data: ${err.message}`;
  }
}

renderStrategyTab();
```

- [ ] **Step 3: Real-run check**

```bash
timeout 4 node dashboard.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/js/strategy.mjs
echo
wait 2>/dev/null
```
Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add public-v2/index.html public-v2/js/strategy.mjs
git commit -m "feat(ui): add Strategy tab (regime card, market note, setups, positions, guardrails)"
```

---

## Task 3: Real-run verification

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm every asset is served**

```bash
timeout 6 node dashboard.js &
sleep 1
for path in / /js/strategy.mjs /js/format.mjs; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000$path)
  echo "$path -> $code"
done
wait 2>/dev/null
```
Expected: every path `200`.

- [ ] **Step 2: Confirm the underlying data one more time, end to end**

```bash
timeout 4 node dashboard.js &
sleep 1
curl -s "http://127.0.0.1:3000/api/strategy" | head -c 300
echo
curl -s "http://127.0.0.1:3000/api/regime/history?limit=3" | head -c 300
echo
wait 2>/dev/null
```
Expected: real setups/stats/guardrails data, real regime history rows — same real data Part E's own real-run already confirmed, now also what this tab's rendering code reads.

- [ ] **Step 3: State the testing limitation explicitly**

Same as both earlier tabs: no browser automation tool exists here. This step confirms every file is served and the data is real and correctly shaped — it does not confirm the page actually renders correctly, that the two-column market-note layout looks right, or that the guardrail bars display sensibly. State this plainly in the final report.

- [ ] **Step 4: Run the full suite one final time**

Run: `node --test test/`
Expected: PASS

## Part F exit check

- [ ] `node --test test/` passes (all new tests green: 5 new formatter tests — plus every prior test unchanged).
- [ ] Every static asset and every API call this tab makes confirmed against real data over a real run.
- [ ] All three milestone-7 tabs (Decision log, Charts, Strategy) now exist, read-only on live paper data, matching the milestone's "Done when" gate: "All three tabs working on live paper data."
- [ ] **Not yet confirmed:** actual browser rendering — no browser automation tool exists in this environment, consistent with every UI part this milestone.
