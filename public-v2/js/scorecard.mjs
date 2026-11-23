import { fetchJson } from './api.mjs';
import { formatScorecardMessage } from './format.mjs';

async function renderScorecard() {
  const el = document.getElementById('scorecard');
  try {
    const [d7, d30, d90] = await Promise.all([
      fetchJson('/api/scorecard', { days: 7 }),
      fetchJson('/api/scorecard', { days: 30 }),
      fetchJson('/api/scorecard', { days: 90 }),
    ]);
    el.innerHTML = `
      <div style="display:flex;gap:16px;">
        <div><strong>7 days</strong><div>${formatScorecardMessage(d7)}</div></div>
        <div><strong>30 days</strong><div>${formatScorecardMessage(d30)}</div></div>
        <div><strong>90 days</strong><div>${formatScorecardMessage(d90)}</div></div>
      </div>
    `;
  } catch (err) {
    el.textContent = `Could not load scorecard: ${err.message}`;
  }
}

renderScorecard();
