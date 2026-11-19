import { fetchJson } from './api.mjs';
import { formatOutcome } from './format.mjs';

export async function renderExpand(cycleId) {
  const el = document.getElementById('expand');
  el.style.display = 'block';
  el.textContent = 'Loading…';
  try {
    const data = await fetchJson(`/api/decisions/${cycleId}`);
    el.innerHTML = '';
    if (data.candidates.length === 0) {
      el.textContent = 'No candidates this cycle.';
      return;
    }
    for (const candidate of data.candidates) {
      const block = document.createElement('div');
      block.className = 'candidate-block';
      const decision = candidate.decision;
      block.innerHTML = `
        <div><strong>${candidate.coin} ${candidate.setup}</strong> — default: ${candidate.default.action}, Claude: ${decision ? decision.action : '(no decision recorded)'}</div>
        ${decision ? `<div class="plain-panel">${decision.plainReason || ''}</div><div>${decision.reason || ''}</div>` : ''}
        <div>${formatOutcome(candidate)}</div>
      `;
      el.appendChild(block);
    }
  } catch (err) {
    el.textContent = `Could not load cycle detail: ${err.message}`;
  }
}
