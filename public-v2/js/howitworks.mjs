import { fetchJson } from './api.mjs';
import { escapeHtml, buildConfigDiff } from './format.mjs';

let currentMode = 'plain';
let lastData = null;

function renderSteps(data) {
  const el = document.getElementById('howitworks-steps');
  el.innerHTML = data.steps.map((step, i) => `
    <div class="candidate-block">
      <strong>${i + 1}. ${escapeHtml(step.title)}</strong>
      <div>${escapeHtml(currentMode === 'plain' ? step.plain : step.technical)}</div>
      <div class="plain-panel">Right now: ${escapeHtml(step.rightNow)}</div>
    </div>
  `).join('');
}

function renderSidebar(data) {
  const el = document.getElementById('howitworks-sidebar');
  const optionalRows = data.optionalFeatures.map((f) => `<li>${escapeHtml(f.name)}: ${escapeHtml(f.status)}</li>`).join('');
  const changedText = data.changedInLatest
    ? escapeHtml(data.changedInLatest)
    : buildConfigDiff(data.diffConfigs.previous, data.diffConfigs.active).map((line) => escapeHtml(line)).join('<br>') || 'No changes from the previous version.';

  el.innerHTML = `
    <h3>At a glance</h3>
    <div>Mode: ${escapeHtml(data.atAGlance.mode)}</div>
    <div>Market mood: ${escapeHtml(data.atAGlance.marketMood)}</div>
    <div>Config version: ${escapeHtml(String(data.atAGlance.configVersion))}</div>
    <div>Claude model: ${escapeHtml(data.atAGlance.claudeModel)}</div>
    <h3>Optional features</h3>
    <ul>${optionalRows}</ul>
    <h3>Changed in latest</h3>
    <div>${changedText}</div>
  `;
}

export async function renderHowItWorks() {
  const el = document.getElementById('howitworks-steps');
  try {
    lastData = await fetchJson('/api/how-it-works', {});
    renderSteps(lastData);
    renderSidebar(lastData);
  } catch (err) {
    el.textContent = `Could not load how it works: ${err.message}`;
  }
}

document.getElementById('howitworks-plain').addEventListener('click', () => {
  currentMode = 'plain';
  document.getElementById('howitworks-plain').classList.add('active');
  document.getElementById('howitworks-technical').classList.remove('active');
  if (lastData) renderSteps(lastData);
});

document.getElementById('howitworks-technical').addEventListener('click', () => {
  currentMode = 'technical';
  document.getElementById('howitworks-technical').classList.add('active');
  document.getElementById('howitworks-plain').classList.remove('active');
  if (lastData) renderSteps(lastData);
});

renderHowItWorks();
