import { fetchJson } from './api.mjs';
import { formatPct, escapeHtml } from './format.mjs';

function renderModeExamples() {
  const el = document.getElementById('mode-examples');
  el.innerHTML = `
    <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">How you can tell which mode you're in</h2>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="border-radius:8px;overflow:hidden;border:1px solid var(--border);"><div style="background:var(--header-bg);display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:10px 14px;"><span class="logo">CRYPTODASH <span>v2</span></span><span class="mode-pill">PAPER</span><span style="font-family:var(--mono);font-size:12px;color:#D1D5DB;">Paper balance — see card below</span></div></div>
      <div style="border-radius:8px;overflow:hidden;border:1px solid var(--border);"><div style="height:4px;background:var(--red-strong);"></div><div style="background:var(--header-bg);display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:10px 14px;"><span class="logo">CRYPTODASH <span>v2</span></span><span style="display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;background:var(--red-strong);color:#FFFFFF;">LIVE · REAL MONEY</span><span style="font-family:var(--mono);font-size:12px;color:#FECACA;">Kraken balance — not connected</span></div></div>
    </div>
    <p style="margin:10px 0 0 0;font-size:13px;color:var(--muted);">In live mode a red stripe sits across the top of every screen, and the header shows your real Kraken balance. Live mode has no switch-on path yet — see the checklist below.</p>
  `;
}

async function renderPaperSettings() {
  const el = document.getElementById('paper-settings');
  try {
    const s = await fetchJson('/api/settings/paper', {});
    const since = s.runningSinceTs === null ? 'not yet started' : new Date(s.runningSinceTs * 1000).toISOString().slice(0, 10);
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;"><h3 style="margin:0;font-size:17px;">Paper (pretend money)</h3><span style="font-size:12px;font-weight:600;color:#FFFFFF;background:#111827;border-radius:999px;padding:3px 10px;">Current</span></div>
      <p style="margin:8px 0 0 0;font-size:13px;line-height:1.5;color:#374151;">Real Kraken prices, simulated orders. Fees and slippage are included so results are realistic. Nothing touches your Kraken account.</p>
      <div style="margin-top:10px;">
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F3F4F6;"><span style="color:var(--muted);">Starting balance</span><span style="font-family:var(--mono);">${s.startingBalance === null ? '—' : `£${s.startingBalance.toFixed(2)}`}</span></div>
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F3F4F6;"><span style="color:var(--muted);">Balance now</span><span style="font-family:var(--mono);">${s.balanceNow === null ? '—' : `£${s.balanceNow.toFixed(2)}`}</span></div>
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F3F4F6;"><span style="color:var(--muted);">Return since start</span><span style="font-family:var(--mono);">${s.returnPct === null ? '—' : formatPct(s.returnPct)}</span></div>
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F3F4F6;"><span style="color:var(--muted);">Running since</span><span style="font-family:var(--mono);">${escapeHtml(since)}</span></div>
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F3F4F6;"><span style="color:var(--muted);">Trades so far</span><span style="font-family:var(--mono);">${s.tradesSoFar}</span></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center;">
        <label style="font-size:12px;color:var(--muted);">New starting balance: <input type="number" id="reset-starting-balance" value="1000" min="1" style="width:100px;"></label>
        <button id="reset-paper-button" style="font-size:13px;font-weight:600;color:var(--red);background:var(--panel);border:1px solid #FCA5A5;border-radius:6px;padding:8px 14px;min-height:40px;cursor:pointer;">Reset paper account</button>
      </div>
      <div id="reset-paper-result" style="margin-top:6px;"></div>
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
    <h3 style="margin:0;font-size:17px;">Live (real money)</h3>
    <p style="margin:8px 0 0 0;font-size:13px;line-height:1.5;color:#374151;">Real orders on your Kraken account. Every entry places a stop-loss order on Kraken straight away.</p>
    <div style="margin-top:10px;">
      <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F3F4F6;"><span style="color:var(--muted);">API key</span><span style="font-family:var(--mono);">Not connected</span></div>
      <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F3F4F6;"><span style="color:var(--muted);">Withdraw permission</span><span style="font-family:var(--mono);">Unconfirmed — manual check</span></div>
      <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F3F4F6;"><span style="color:var(--muted);">Starting stake</span><span style="font-family:var(--mono);">25% of paper stake</span></div>
    </div>
    <button type="button" disabled style="margin-top:12px;font-size:14px;font-weight:600;color:var(--muted);background:#F3F4F6;border:1px solid var(--border);border-radius:6px;padding:10px 16px;min-height:44px;cursor:not-allowed;">Switch to live</button>
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
      <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">Guardrail caps</h2>
      <table>
        <thead><tr><th>Limit</th><th>Paper</th><th style="color:var(--red);">Live</th></tr></thead>
        <tbody>
          ${rows.map(([label, paper, live]) => `<tr><td>${escapeHtml(label)}</td><td style="font-family:var(--mono);">${escapeHtml(String(paper))}</td><td style="font-family:var(--mono);">${escapeHtml(String(live))}</td></tr>`).join('')}
        </tbody>
      </table>
      <div style="margin-top:10px;font-size:12px;color:var(--muted);"><em>${escapeHtml(caps.liveNote)}</em> — editing and saving caps isn't built yet, this table is read-only.</div>
    `;
  } catch (err) {
    el.textContent = `Could not load guardrail caps: ${err.message}`;
  }
}

function renderSwitchingInfo() {
  const el = document.getElementById('switching-info');
  el.innerHTML = `
    <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">Switching to live: what happens</h2>
    <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.7;color:#1F2937;">
      <li>You type <span style="font-family:var(--mono);background:#F3F4F6;padding:1px 6px;border-radius:4px;">LIVE</span> and re-enter the dashboard password.</li>
      <li>Open paper trades stay paper and finish on their own. Only new trades use real money.</li>
      <li>Stakes start at 25% of paper size and go up only when you raise them here.</li>
      <li>Live guardrail caps apply. They are tighter than paper's.</li>
    </ol>
    <p style="margin:14px 0 0 0;font-size:12px;color:var(--muted);">None of this flow exists yet — no mode switcher is built. Shown here as a description of the intended flow, not a working control.</p>
    <h2 style="margin:20px 0 12px 0;font-size:15px;font-weight:600;">Going back to paper</h2>
    <div role="radiogroup" aria-label="Open live trades" style="display:flex;flex-direction:column;gap:8px;">
      <label style="display:flex;align-items:center;gap:10px;font-size:14px;min-height:36px;color:var(--muted);"><input type="radio" name="back" disabled>Leave them open with their Kraken stops in place</label>
      <label style="display:flex;align-items:center;gap:10px;font-size:14px;min-height:36px;color:var(--muted);"><input type="radio" name="back" disabled>Close them all at market now</label>
    </div>
    <h2 style="margin:20px 0 12px 0;font-size:15px;font-weight:600;">Keeping the money separate</h2>
    <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7;color:#1F2937;">
      <li>Every trade, order and decision is tagged <span style="font-family:var(--mono);">paper</span> or <span style="font-family:var(--mono);">live</span>.</li>
      <li>P&amp;L, the scorecard and charts never mix the two.</li>
      <li>Live trade markers on charts are drawn with a red outline (not built — no live trades exist yet).</li>
    </ul>
  `;
}

function renderTelegramSettings() {
  const el = document.getElementById('telegram-settings');
  const events = ['Trade opened', 'Trade closed', 'Stop hit', 'Guardrail or kill switch hit', 'Claude fallback or error', 'Config change waiting for approval', 'Regime change', 'Daily summary at 21:00'];
  el.innerHTML = `
    <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">Notifications (Telegram)</h2>
    <div style="display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:13px;"><span>Bot: <span style="font-family:var(--mono);color:var(--muted);">not built yet</span></span><button type="button" disabled style="font-size:13px;font-weight:600;color:var(--muted);background:#F3F4F6;border:1px solid var(--border);border-radius:6px;padding:6px 12px;min-height:36px;cursor:not-allowed;">Send test message</button></div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;margin-top:10px;">
      ${events.map((e) => `<label style="display:flex;align-items:center;gap:10px;font-size:14px;min-height:36px;color:var(--muted);"><input type="checkbox" disabled>${escapeHtml(e)}</label>`).join('')}
    </div>
    <p style="margin:10px 0 0 0;font-size:12px;color:var(--muted);">Telegram notifications aren't built yet — these toggles are shown disabled per the design, not wired to anything.</p>
  `;
}

export async function renderSettingsTab() {
  renderModeExamples();
  await renderPaperSettings();
  renderLiveSettings();
  await renderGuardrailCaps();
  renderSwitchingInfo();
  renderTelegramSettings();
}

renderSettingsTab();
