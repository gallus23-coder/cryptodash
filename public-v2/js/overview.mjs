import { fetchJson } from './api.mjs';
import { computeNextCycleTs, formatUtcTime, escapeHtml } from './format.mjs';

async function renderBalanceCard() {
  const el = document.getElementById('overview-balance');
  try {
    const [settings, strategy, caps] = await Promise.all([
      fetchJson('/api/settings/paper', {}),
      fetchJson('/api/strategy', {}),
      fetchJson('/api/settings/guardrail-caps', {}),
    ]);
    const dailyLossLimitAmount = settings.balanceNow === null ? null : settings.balanceNow * caps.paper.dailyLossLimitPct;
    const nowTs = Math.floor(Date.now() / 1000);
    el.innerHTML = `
      <div class="watchlist-label">Paper balance</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:6px;">
        <span style="font-family:var(--mono);font-size:28px;font-weight:600;">${settings.balanceNow === null ? '—' : `£${settings.balanceNow.toFixed(2)}`}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px;">
        <div><div style="font-size:12px;color:var(--muted);">Open</div><div style="font-family:var(--mono);font-weight:600;">${strategy.guardrails.openPositions.used} / ${strategy.guardrails.openPositions.max}</div></div>
        <div><div style="font-size:12px;color:var(--muted);">Daily loss</div><div style="font-family:var(--mono);font-weight:600;">£0 / ${dailyLossLimitAmount === null ? '—' : `£${dailyLossLimitAmount.toFixed(0)}`}</div></div>
        <div><div style="font-size:12px;color:var(--muted);">Next cycle</div><div style="font-family:var(--mono);font-weight:600;">${formatUtcTime(computeNextCycleTs(nowTs))}</div></div>
      </div>
      <p style="margin:10px 0 0 0;font-size:11px;color:var(--muted);">Today's £ P&amp;L isn't exposed by any endpoint (only daily loss, clamped to zero on profitable days) — showing £0 as the floor, not a real "today" figure.</p>
    `;
  } catch (err) {
    el.textContent = `Could not load balance: ${err.message}`;
  }
}

async function renderMoodCard() {
  const el = document.getElementById('overview-mood');
  try {
    const [current, strategy] = await Promise.all([
      fetchJson('/api/regime/current', {}),
      fetchJson('/api/strategy', {}),
    ]);
    const plainNote = strategy.marketNote?.plainNote;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;"><div class="watchlist-label">Market right now</div><span style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--green-text);background:var(--green-bg);padding:2px 8px;border-radius:4px;">${escapeHtml(current.label ?? 'unknown')}</span></div>
      ${plainNote ? `
        <div style="display:flex;align-items:center;gap:8px;margin-top:10px;"><span style="font-weight:600;">${escapeHtml(plainNote.mood || '')}</span></div>
        <p style="margin:8px 0 0 0;font-size:14px;line-height:1.55;color:#374151;">${escapeHtml(plainNote.botAction || '')}</p>
      ` : '<p style="margin:8px 0 0 0;color:var(--muted);">No market note yet.</p>'}
    `;
  } catch (err) {
    el.textContent = `Could not load market mood: ${err.message}`;
  }
}

async function renderPositionsCard() {
  const el = document.getElementById('overview-positions');
  try {
    const positions = await fetchJson('/api/positions', {});
    if (positions.length === 0) {
      el.innerHTML = `<div class="watchlist-label">Open positions</div><div style="margin-top:8px;color:var(--muted);">No open positions.</div>`;
      return;
    }
    const nowTs = Math.floor(Date.now() / 1000);
    el.innerHTML = `
      <div class="watchlist-label">Open positions</div>
      ${positions.map((p) => {
        const hours = Math.floor((nowTs - p.entryTs) / 3600);
        return `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid #F3F4F6;">
          <span style="display:flex;flex-direction:column;gap:2px;"><span style="font-weight:600;">${escapeHtml(p.coin)}/GBP</span><span style="font-size:12px;color:var(--muted);">${escapeHtml(p.setup)} · ${hours}h</span></span>
          <span style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;"><span style="font-family:var(--mono);font-size:12px;color:var(--red);">stop £${p.initialStopPrice}</span></span>
        </div>
      `;
      }).join('')}
    `;
  } catch (err) {
    el.textContent = `Could not load positions: ${err.message}`;
  }
}

async function renderLastDecisionCard() {
  const el = document.getElementById('overview-last-decision');
  try {
    const cycles = await fetchJson('/api/cycles', { limit: 1 });
    if (cycles.length === 0) {
      el.innerHTML = `<div class="watchlist-label">Last decision</div><div style="margin-top:8px;color:var(--muted);">No cycles logged yet.</div>`;
      return;
    }
    const latest = cycles[0];
    el.innerHTML = `
      <div class="watchlist-label">Last decision · ${formatUtcTime(latest.ts)}</div>
      <p style="margin:8px 0 0 0;font-size:14px;line-height:1.5;">${escapeHtml(latest.oneLiner)}</p>
    `;
  } catch (err) {
    el.textContent = `Could not load last decision: ${err.message}`;
  }
}

export async function renderOverviewTab() {
  await Promise.all([renderBalanceCard(), renderMoodCard(), renderPositionsCard(), renderLastDecisionCard()]);
}

renderOverviewTab();
