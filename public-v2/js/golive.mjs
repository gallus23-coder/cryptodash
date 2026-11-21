import { fetchJson } from './api.mjs';
import { formatChecklistStatus, formatR, escapeHtml } from './format.mjs';

const ROWS = [
  ['trades60', (c) => `60+ paper trades with positive expectancy (${c.trades60.count}/${c.trades60.required}, ${formatR(c.trades60.expectancy)} expectancy)`],
  ['scorecard', (c) => `Claude-vs-default scorecard not negative over 30 days${c.scorecard.claudeMeanR !== undefined ? ` (${formatR(c.scorecard.claudeMeanR)})` : ''}`],
  ['reconcileTested', () => 'Reconcile tested deliberately'],
  ['killSwitchTested', () => 'Kill switch tested deliberately'],
  ['dailyLossLimitTested', () => 'Daily loss limit tested deliberately'],
  ['krakenKeyNoWithdraw', () => 'Kraken key confirmed to have no withdraw permission'],
];

function renderChecklist(checklist) {
  const el = document.getElementById('golive-checklist');
  el.innerHTML = `
    <h3>Go-live checklist</h3>
    <table>
      <tbody>
        ${ROWS.map(([key, describe]) => {
          const item = checklist[key];
          const { icon, label } = formatChecklistStatus(item.pass);
          const detail = item.detail ? `<div><em>${escapeHtml(item.detail)}</em></div>` : '';
          return `<tr><td>${icon} ${label}</td><td>${escapeHtml(describe(checklist))}${detail}</td></tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

export async function renderGoLiveChecklist() {
  const el = document.getElementById('golive-checklist');
  try {
    const checklist = await fetchJson('/api/go-live-checklist', {});
    renderChecklist(checklist);
  } catch (err) {
    el.textContent = `Could not load go-live checklist: ${err.message}`;
  }
}

renderGoLiveChecklist();
