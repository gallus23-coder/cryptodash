import { fetchJson } from './api.mjs';
import { formatScorecardMessage } from './format.mjs';

async function renderScorecard() {
  const el = document.getElementById('scorecard');
  try {
    const data = await fetchJson('/api/scorecard', { days: 30 });
    el.textContent = formatScorecardMessage(data);
  } catch (err) {
    el.textContent = `Could not load scorecard: ${err.message}`;
  }
}

renderScorecard();
