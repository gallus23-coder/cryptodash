import { fetchJson } from './api.mjs';
import { buildConfigDiff, escapeHtml } from './format.mjs';

const SETUP_NAMES = ['trend_breakout', 'trend_pullback', 'range_reversion', 'oversold_bounce'];
let lastBacktestedDraft = null;
let lastBacktestSummary = null;
// setupParamsInfo[name] = { params, paramBounds } — fetched from /api/strategy (the server is the
// single source of truth for DEFAULT_SETUP_PARAMS/SETUP_PARAM_BOUNDS; this module can't import
// src/engine/setupParams.js directly, since that's a CommonJS file and this runs in the browser).
let setupParamsInfo = {};
// Incremented on every form change. runBacktest captures the value at the start of its two
// awaited round-trips and checks it again before committing — if the user toggled a setting
// while the backtest was in flight, the generation no longer matches and the stale result is
// discarded instead of silently re-enabling "Save as pending" for settings that no longer match
// what's on screen.
let formGeneration = 0;

function readParamInputsFor(name) {
  return Object.fromEntries(
    Object.keys(setupParamsInfo[name].params).map((key) => [key, Number(document.getElementById(`param-${name}-${key}`).value)])
  );
}

function currentDraft() {
  const riskLevel = document.getElementById('risk-level-select').value;
  const disabledSetups = SETUP_NAMES.filter((name) => !document.getElementById(`toggle-setup-${name}`).checked);
  const setupParams = SETUP_NAMES.reduce((acc, name) => ({ ...acc, [name]: readParamInputsFor(name) }), {});
  return { riskLevel, disabledSetups, rangeOverrides: {}, setupParams };
}

function invalidateBacktest() {
  formGeneration += 1;
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

async function renderSetupParamInputs() {
  const el = document.getElementById('setup-param-inputs');
  try {
    const strategy = await fetchJson('/api/strategy', {});
    setupParamsInfo = Object.fromEntries(strategy.setups.map((s) => [s.name, { params: s.params, paramBounds: s.paramBounds }]));
  } catch (err) {
    el.textContent = `Could not load setup parameters: ${err.message}`;
    return;
  }
  el.innerHTML = SETUP_NAMES.map((name) => `
    <div style="margin-top: 10px;">
      <div style="font-family: var(--mono); font-size: 12px; color: var(--muted);">${escapeHtml(name)}</div>
      <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 4px;">
        ${Object.entries(setupParamsInfo[name].params).map(([key, defaultValue]) => {
          const [min, max] = setupParamsInfo[name].paramBounds[key];
          return `<label style="display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted);">${escapeHtml(key)}<input type="number" step="0.1" id="param-${name}-${key}" value="${defaultValue}" min="${min}" max="${max}"></label>`;
        }).join('')}
      </div>
    </div>
  `).join('');
  SETUP_NAMES.forEach((name) => {
    Object.keys(setupParamsInfo[name].params).forEach((key) => {
      document.getElementById(`param-${name}-${key}`).addEventListener('change', invalidateBacktest);
    });
  });
}

async function runBacktest() {
  const startGeneration = formGeneration;
  const draft = currentDraft();
  const resultEl = document.getElementById('backtest-result');
  resultEl.textContent = 'Running 90-day backtest…';
  try {
    const validated = await fetchJson('/api/config/draft', {}, { method: 'POST', body: draft });
    const result = await fetchJson('/api/config/draft/backtest', {}, { method: 'POST', body: validated });
    if (formGeneration !== startGeneration) {
      // The form changed while the backtest was running — this result no longer matches what's
      // on screen. Discard it rather than committing a stale draft as "backtested."
      resultEl.textContent = 'Settings changed while the backtest was running — please run it again.';
      return;
    }
    lastBacktestedDraft = draft;
    lastBacktestSummary = result.backtestSummary;
    const bySetupLines = Object.entries(result.backtestSummary.bySetup)
      .map(([name, stats]) => `${escapeHtml(name)}: ${stats.count} trades, ${(stats.winRate * 100).toFixed(0)}% win rate`)
      .join('<br>');

    const formatCell = (summary) => summary.tooFewToJudge
      ? 'too few to judge'
      : `${summary.trades} trades, ${(summary.winRate * 100).toFixed(0)}% win, ${summary.expectancy.toFixed(2)}R, worst DD ${(summary.worstDrawdownPct * 100).toFixed(1)}%, vs BTC ${(summary.vsBtc.returnPct * 100).toFixed(1)}%`;
    const walkForwardRows = ['active', 'draft'].map((which) => `
      <tr><td>${escapeHtml(which)}</td><td>${formatCell(result.walkForward[which].earlier)}</td><td>${formatCell(result.walkForward[which].later)}</td></tr>
    `).join('');
    const walkForwardTable = `
      <table>
        <thead><tr><th></th><th>earlier (60d)</th><th>later (30d)</th></tr></thead>
        <tbody>${walkForwardRows}</tbody>
      </table>
    `;

    resultEl.innerHTML = `
      ${walkForwardTable}
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
  await renderSetupParamInputs();
  document.getElementById('risk-level-select').addEventListener('change', invalidateBacktest);
  document.getElementById('backtest-button').addEventListener('click', runBacktest);
  document.getElementById('submit-button').addEventListener('click', submitDraft);
  await renderPendingProposal();
}

renderConfigEditor();
