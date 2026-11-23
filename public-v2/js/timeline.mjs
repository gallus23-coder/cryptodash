import { fetchJson } from './api.mjs';
import { classifyRow } from './format.mjs';
import { renderExpand } from './expand.mjs';

function formatTs(ts) {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function currentFilters() {
  const params = {};
  const regime = document.getElementById('regime-filter').value;
  const coin = document.getElementById('coin-filter').value;
  const setup = document.getElementById('setup-filter').value;
  const action = document.getElementById('action-filter').value;
  const diverged = document.getElementById('diverged-filter').checked;
  if (regime) params.regime = regime;
  if (coin) params.coin = coin;
  if (setup) params.setup = setup;
  if (action) params.action = action;
  if (diverged) params.diverged = true;
  return params;
}

async function renderTimeline() {
  const el = document.getElementById('timeline');
  try {
    const rows = await fetchJson('/api/cycles', currentFilters());
    el.innerHTML = '';
    for (const row of rows) {
      const div = document.createElement('div');
      div.className = `cycle-row ${classifyRow(row) === 'error' ? 'has-error' : ''}`;
      div.innerHTML = `<div class="ts">${formatTs(row.ts)} · ${row.regimeLabel}</div><div class="line">${row.oneLiner}</div>`;
      div.addEventListener('click', () => renderExpand(row.ts));
      el.appendChild(div);
    }
    if (rows.length === 0) el.textContent = 'No cycles logged yet for this filter.';
  } catch (err) {
    el.textContent = `Could not load cycles: ${err.message}`;
  }
}

['regime-filter', 'coin-filter', 'setup-filter', 'action-filter', 'diverged-filter'].forEach((id) => {
  document.getElementById(id).addEventListener('change', renderTimeline);
});
renderTimeline();
