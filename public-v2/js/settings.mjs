import { fetchJson } from './api.mjs';
import { formatPct, escapeHtml } from './format.mjs';

async function renderPaperSettings() {
  const el = document.getElementById('paper-settings');
  try {
    const s = await fetchJson('/api/settings/paper', {});
    const since = s.runningSinceTs === null ? 'not yet started' : new Date(s.runningSinceTs * 1000).toISOString().slice(0, 10);
    el.innerHTML = `
      <h3>Paper (pretend money)</h3>
      <div>Starting balance: £${s.startingBalance === null ? '—' : s.startingBalance.toFixed(2)}</div>
      <div>Balance now: £${s.balanceNow === null ? '—' : s.balanceNow.toFixed(2)}</div>
      <div>Return since start: ${s.returnPct === null ? '—' : formatPct(s.returnPct)}</div>
      <div>Running since: ${escapeHtml(since)}</div>
      <div>Trades so far: ${s.tradesSoFar}</div>
      <div style="margin-top:10px;">
        <label>New starting balance: <input type="number" id="reset-starting-balance" value="1000" min="1" /></label>
        <button id="reset-paper-button">Reset paper account</button>
      </div>
      <div id="reset-paper-result"></div>
    `;
    document.getElementById('reset-paper-button').addEventListener('click', resetPaperAccount);
  } catch (err) {
    el.textContent = `Could not load paper settings: ${err.message}`;
  }
}

async function resetPaperAccount() {
  const typed = window.prompt('This wipes the paper balance and open positions (trade history is kept). Type RESET to confirm:');
  if (typed !== 'RESET') return;
  const resultEl = document.getElementById('reset-paper-result');
  const startingBalance = Number(document.getElementById('reset-starting-balance').value) || 1000;
  try {
    await fetchJson('/api/control/reset-account', {}, { method: 'POST', body: { startingBalance } });
    resultEl.textContent = 'Paper account reset.';
    await renderPaperSettings();
  } catch (err) {
    resultEl.textContent = `Reset failed: ${err.message}`;
  }
}

function renderLiveSettings() {
  const el = document.getElementById('live-settings');
  el.innerHTML = `
    <h3>Live (real money)</h3>
    <div>Not connected — no live credentials configured.</div>
    <div>Switch to live: unavailable until every go-live checklist item passes.</div>
  `;
}

async function renderGuardrailCaps() {
  const el = document.getElementById('guardrail-caps');
  try {
    const caps = await fetchJson('/api/settings/guardrail-caps', {});
    const rows = [
      ['Base risk per trade', formatPct(caps.paper.baseStakePct), `£${caps.live.baseStake} flat stake`],
      ['Max open positions', caps.paper.maxOpenPositions, caps.live.maxOpenPositions],
      ['Max per coin exposure', formatPct(caps.paper.maxCoinExposurePct), formatPct(caps.live.maxCoinExposurePct)],
      ['Max total exposure', formatPct(caps.paper.maxTotalExposurePct), formatPct(caps.live.maxTotalExposurePct)],
      ['Daily loss limit', formatPct(caps.paper.dailyLossLimitPct), formatPct(caps.live.dailyLossLimitPct)],
      ['Weekly kill switch', formatPct(caps.paper.weeklyKillSwitchPct), formatPct(caps.live.weeklyKillSwitchPct)],
    ];
    el.innerHTML = `
      <h3>Guardrail caps</h3>
      <table>
        <thead><tr><th>Limit</th><th>Paper</th><th>Live</th></tr></thead>
        <tbody>
          ${rows.map(([label, paper, live]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(String(paper))}</td><td>${escapeHtml(String(live))}</td></tr>`).join('')}
        </tbody>
      </table>
      <div><em>${escapeHtml(caps.liveNote)}</em></div>
    `;
  } catch (err) {
    el.textContent = `Could not load guardrail caps: ${err.message}`;
  }
}

export async function renderSettingsTab() {
  await renderPaperSettings();
  renderLiveSettings();
  await renderGuardrailCaps();
}

renderSettingsTab();
