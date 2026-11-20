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
