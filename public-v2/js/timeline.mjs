import { fetchJson } from './api.mjs';
import { classifyRow } from './format.mjs';
import { renderExpand } from './expand.mjs';

function formatTs(ts) {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

async function renderTimeline() {
  const el = document.getElementById('timeline');
  const regime = document.getElementById('regime-filter').value;
  try {
    const rows = await fetchJson('/api/cycles', regime ? { regime } : {});
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

document.getElementById('regime-filter').addEventListener('change', renderTimeline);
renderTimeline();
