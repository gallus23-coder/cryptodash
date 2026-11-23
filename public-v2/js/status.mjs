import { fetchJson } from './api.mjs';
import { computeNextCycleTs, formatUtcTime } from './format.mjs';

export async function renderStatusBar() {
  try {
    const [regime, status] = await Promise.all([
      fetchJson('/api/regime/current', {}),
      fetchJson('/api/status', {}),
    ]);

    document.getElementById('status-regime').textContent = `Regime: ${regime.label ?? 'unknown'}`;

    const nowTs = Math.floor(Date.now() / 1000);
    document.getElementById('status-next-cycle').textContent = `Next cycle ${formatUtcTime(computeNextCycleTs(nowTs))}`;

    document.getElementById('status-claude-calls').textContent = `Claude: ${status.claudeCallsToday} calls today`;

    const pauseButton = document.getElementById('pause-button');
    pauseButton.textContent = status.pausedByOperator ? 'Resume trading' : 'Pause trading';
    pauseButton.classList.toggle('paused', status.pausedByOperator);
    pauseButton.onclick = () => togglePause(status.pausedByOperator);
  } catch (err) {
    console.error('Could not load status bar:', err.message);
  }
}

async function togglePause(currentlyPaused) {
  const action = currentlyPaused ? 'resume' : 'pause';
  const verb = currentlyPaused ? 'resume' : 'pause';
  if (!window.confirm(`Are you sure you want to ${verb} trading?`)) return;
  try {
    await fetchJson(`/api/control/${action}`, {}, { method: 'POST' });
    await renderStatusBar();
  } catch (err) {
    console.error(`Could not ${verb} trading:`, err.message);
  }
}

renderStatusBar();
