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
    <div>${g.killSwitchActive
      ? '<strong style="color:#ef4444;">KILL SWITCH ACTIVE</strong> <button id="reset-kill-switch-button">Reset kill switch</button><div id="reset-kill-switch-result"></div>'
      : 'Kill switch: inactive'}</div>
    ${rows.map(([label, { text, pct }]) => `
      <div>${escapeHtml(label)}: ${escapeHtml(text)}
        <div class="guardrail-bar-track"><div class="guardrail-bar-fill" style="width:${pct}%;"></div></div>
      </div>
    `).join('')}
  `;
  if (g.killSwitchActive) {
    document.getElementById('reset-kill-switch-button').addEventListener('click', resetKillSwitch);
  }
}

async function renderClaudeUsage() {
  const el = document.getElementById('claude-usage-panel');
  try {
    const usage = await fetchJson('/api/claude-usage', {});
    el.innerHTML = `
      <div><strong>Claude usage</strong></div>
      <div>Provider: ${escapeHtml(usage.provider)}</div>
      <div>Calls today: ${usage.callsToday} of ${usage.cyclesToday} cycles</div>
      <div>This month: ${usage.callsThisMonth} calls</div>
      <div>Fallbacks: ${usage.fallbacksThisMonth}</div>
    `;
  } catch (err) {
    el.textContent = `Could not load Claude usage: ${err.message}`;
  }
}

async function resetKillSwitch() {
  if (!window.confirm('Reset the kill switch and resume trading decisions? Only do this after reviewing why it tripped.')) return;
  const resultEl = document.getElementById('reset-kill-switch-result');
  try {
    await fetchJson('/api/guardrails/reset-kill-switch', {}, { method: 'POST' });
    resultEl.textContent = 'Kill switch reset.';
    const strategy = await fetchJson('/api/strategy', {});
    renderGuardrails(strategy);
  } catch (err) {
    resultEl.textContent = `Reset failed: ${err.message}`;
  }
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
    await renderClaudeUsage();
  } catch (err) {
    document.getElementById('setups-table').textContent = `Could not load strategy data: ${err.message}`;
  }
}

renderStrategyTab();
