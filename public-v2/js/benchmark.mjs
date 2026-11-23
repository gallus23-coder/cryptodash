import { fetchJson } from './api.mjs';
import { formatPct, formatRatio, escapeHtml } from './format.mjs';

function renderColumn(label, stats) {
  if (!stats) return `<div><strong>${escapeHtml(label)}</strong><div>No data yet</div></div>`;
  return `
    <div>
      <strong>${escapeHtml(label)}</strong>
      <div>${formatPct(stats.returnPct)}</div>
      <div>worst drop ${formatPct(-stats.worstDrawdownPct)}</div>
      <div>return ÷ worst drop: ${formatRatio(stats.ratio)}</div>
    </div>
  `;
}

export async function renderBenchmarkPanel() {
  const el = document.getElementById('benchmark-panel');
  try {
    const data = await fetchJson('/api/benchmarks', {});
    if (data.startTs === null) {
      el.textContent = 'Is it worth running? Not enough history yet.';
      return;
    }
    const sinceDate = new Date(data.startTs * 1000).toISOString().slice(0, 10);
    el.innerHTML = `
      <h3>Is it worth running? Bot vs just holding</h3>
      <div style="color:var(--muted);font-size:12px;">Since ${escapeHtml(sinceDate)}</div>
      <div style="display:flex;gap:16px;margin-top:8px;">
        ${renderColumn('The bot', data.bot)}
        ${renderColumn('Holding BTC', data.btc)}
        ${renderColumn('Holding cash', data.cash)}
      </div>
    `;
  } catch (err) {
    el.textContent = `Could not load benchmark: ${err.message}`;
  }
}

renderBenchmarkPanel();
