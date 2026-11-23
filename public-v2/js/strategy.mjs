import { fetchJson } from './api.mjs';
import { formatRegimeDuration, formatSetupStats, formatR, formatPct, escapeHtml } from './format.mjs';

// Which regime each setup is designed for — matches src/engine/playbook's SETUPS_BY_REGIME
// mapping. Not exposed via any API, so this is hand-kept in sync with that constant; a setup
// added or reassigned there needs this list updated too.
const SETUP_REGIMES = {
  trend_breakout: 'trend_up', trend_pullback: 'trend_up',
  range_reversion: 'range', oversold_bounce: 'downtrend',
};

async function renderRegimeCard() {
  const el = document.getElementById('regime-card');
  try {
    const [current, history] = await Promise.all([
      fetchJson('/api/regime/current', {}),
      fetchJson('/api/regime/history', {}),
    ]);
    const duration = formatRegimeDuration(history, Math.floor(Date.now() / 1000));
    const m = current.metrics;
    const tiles = m ? [
      ['BTC vs daily EMA200', m.btcAboveEma200 ? 'Above' : 'Below', m.ema200SlopeFalling ? 'slope falling' : 'slope rising'],
      ['ADX (4h)', m.adx?.toFixed(1) ?? '—', 'threshold 22'],
      ['Volatility rank', m.volatilityRankPct?.toFixed(0) ?? '—', 'percentile, 90 days'],
      ['Breadth', m.breadthPct !== undefined ? `${Math.round((m.breadthPct / 100) * 6)} / 6` : '—', 'coins above 4h EMA50'],
      ['Funding (avg)', 'not tracked', 'Kraken Futures not wired in'],
    ] : [];
    el.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px;">
        <div><div class="watchlist-label">Current regime</div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px;"><span style="font-family:var(--mono);font-size:22px;font-weight:600;color:var(--green-text);background:var(--green-bg);padding:4px 12px;border-radius:6px;">${escapeHtml(current.label ?? 'unknown')}</span><span style="font-size:13px;color:var(--muted);">${escapeHtml(duration)}</span></div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:16px;">
        ${tiles.map(([label, value, sub]) => `<div style="border:1px solid var(--border);border-radius:8px;padding:12px;"><div style="font-size:12px;color:var(--muted);">${escapeHtml(label)}</div><div style="font-family:var(--mono);font-size:18px;font-weight:600;margin-top:4px;">${escapeHtml(String(value))}</div><div style="font-size:12px;color:var(--muted);margin-top:2px;">${escapeHtml(sub)}</div></div>`).join('')}
      </div>
    `;
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
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
      <div class="plain-panel"><div class="watchlist-label">In plain English</div><div style="margin-top:8px;font-weight:600;">${escapeHtml(plainNote?.mood || '')}</div><ul style="margin:10px 0 0 0;padding-left:18px;">${bullets}</ul><div style="margin-top:8px;">${escapeHtml(plainNote?.botAction || '')}</div></div>
      <div><div class="watchlist-label">Claude's market note</div><p style="margin:10px 0 0 0;font-size:14px;line-height:1.6;color:#1F2937;">${escapeHtml(marketNote)}</p></div>
    </div>
  `;
}

function renderSetupsTable(strategy) {
  const el = document.getElementById('setups-table');
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;"><h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">Active setups</h2><span style="font-size:12px;color:var(--muted);">Stats: 30d / 90d, after fees</span></div>
    <table>
      <thead><tr><th>Setup</th><th>Allowed in</th><th>Ranges</th><th>30d</th><th>90d</th></tr></thead>
      <tbody>
        ${strategy.setups.map((s) => `
          <tr>
            <td style="font-family:var(--mono);">${escapeHtml(s.name)}</td>
            <td>${escapeHtml(SETUP_REGIMES[s.name] || '—')}</td>
            <td style="font-family:var(--mono);font-size:12px;">size ${JSON.stringify(s.ranges.size)}, stop ${JSON.stringify(s.ranges.stopAtr)}${s.ranges.trailAtr ? `, trail ${JSON.stringify(s.ranges.trailAtr)}` : ''}</td>
            <td>${escapeHtml(formatSetupStats(s.stats30d))}</td>
            <td>${escapeHtml(formatSetupStats(s.stats90d))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <p style="margin:10px 0 0 0;font-size:12px;color:var(--muted);">Setup lifecycle (trial → active → auto-off) is not built yet — every setup listed here is always active for its regime.</p>
  `;
}

function renderOpenPositions(positions) {
  const el = document.getElementById('open-positions');
  if (positions.length === 0) {
    el.innerHTML = `<h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">Open positions</h2><div style="color:var(--muted);">No open positions.</div>`;
    return;
  }
  el.innerHTML = `
    <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">Open positions</h2>
    <table>
      <thead><tr><th>Coin</th><th>Setup</th><th>Entry</th><th>Stop</th></tr></thead>
      <tbody>
        ${positions.map((p) => `<tr><td>${escapeHtml(p.coin)}</td><td style="font-family:var(--mono);">${escapeHtml(p.setup)}</td><td style="font-family:var(--mono);">£${p.entryPrice}</td><td style="font-family:var(--mono);color:var(--red);">£${p.initialStopPrice}</td></tr>`).join('')}
      </tbody>
    </table>
  `;
}

function renderGuardrails(strategy, caps, paperSettings) {
  const el = document.getElementById('guardrails-panel');
  const g = strategy.guardrails;
  const riskPerTradeAmount = paperSettings.balanceNow !== null ? paperSettings.balanceNow * caps.paper.baseStakePct : null;
  const rows = [
    ['Open risk (all trades)', g.totalRiskPct],
    ['Total exposure', g.totalExposurePct],
    ['Daily loss', g.dailyLossPct],
    ['Weekly drawdown', g.weeklyDrawdownPct],
  ];
  el.innerHTML = `
    <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">Guardrails</h2>
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px;background:#F9FAFB;border-radius:6px;padding:10px 12px;"><span>Risk per trade</span><span style="font-family:var(--mono);font-weight:600;">${formatPct(caps.paper.baseStakePct)}${riskPerTradeAmount === null ? '' : ` · £${riskPerTradeAmount.toFixed(2)}`}</span></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px;background:#F9FAFB;border-radius:6px;padding:10px 12px;"><span>Open positions</span><span style="font-family:var(--mono);font-weight:600;">${g.openPositions.used} / ${g.openPositions.max}</span></div>
      ${rows.map(([label, { used, max }]) => `
        <div><div style="display:flex;justify-content:space-between;font-size:13px;"><span>${escapeHtml(label)}</span><span style="font-family:var(--mono);color:#374151;">${formatPct(used)} / ${formatPct(max)}</span></div>
        <div class="guardrail-bar-track"><div class="guardrail-bar-fill" style="width:${max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0}%;"></div></div></div>
      `).join('')}
      <div style="font-size:13px;line-height:1.5;border-top:1px solid var(--border);padding-top:12px;"><span style="font-weight:600;">Fee check:</span> a coin's typical 4h move must beat a multiple of the round-trip fee (not exposed via any endpoint yet — see final report).</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px;padding-top:14px;border-top:1px solid var(--border);">
      <div style="font-size:13px;">Kill switch: ${g.killSwitchActive ? '<strong style="color:var(--red);">TRIGGERED</strong>' : '<span style="font-weight:600;color:var(--green-text);">armed, not triggered</span>'}</div>
      ${g.killSwitchActive ? '<button id="reset-kill-switch-button" style="font-family:Inter,sans-serif;font-size:13px;font-weight:600;color:var(--red);background:var(--panel);border:1px solid #FCA5A5;border-radius:6px;padding:8px 14px;min-height:40px;cursor:pointer;">Reset kill switch</button>' : ''}
    </div>
    <div id="reset-kill-switch-result" style="margin-top:8px;"></div>
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
    renderStrategyTab();
  } catch (err) {
    resultEl.textContent = `Reset failed: ${err.message}`;
  }
}

async function renderClaudeUsage() {
  const el = document.getElementById('claude-usage-panel');
  try {
    const usage = await fetchJson('/api/claude-usage', {});
    el.innerHTML = `
      <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;">Claude usage</h2>
      <dl style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;margin:0;">
        <div><dt style="font-size:12px;color:var(--muted);">Provider</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);">${escapeHtml(usage.provider)}</dd></div>
        <div><dt style="font-size:12px;color:var(--muted);">Calls today</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);">${usage.callsToday} of ${usage.cyclesToday} cycles</dd></div>
        <div><dt style="font-size:12px;color:var(--muted);">This month</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);">${usage.callsThisMonth} calls</dd></div>
        <div><dt style="font-size:12px;color:var(--muted);">Fallbacks</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);">${usage.fallbacksThisMonth}</dd></div>
      </dl>
    `;
  } catch (err) {
    el.textContent = `Could not load Claude usage: ${err.message}`;
  }
}

export async function renderStrategyTab() {
  await renderRegimeCard();
  try {
    const [strategy, positions, caps, paperSettings] = await Promise.all([
      fetchJson('/api/strategy', {}),
      fetchJson('/api/positions', {}),
      fetchJson('/api/settings/guardrail-caps', {}),
      fetchJson('/api/settings/paper', {}),
    ]);
    await renderMarketNote(strategy);
    renderSetupsTable(strategy);
    renderOpenPositions(positions);
    renderGuardrails(strategy, caps, paperSettings);
    await renderClaudeUsage();
  } catch (err) {
    document.getElementById('setups-table').textContent = `Could not load strategy data: ${err.message}`;
  }
}

renderStrategyTab();
