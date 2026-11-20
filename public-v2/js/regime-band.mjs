import { fetchJson } from './api.mjs';
import { buildRegimeSegments, REGIME_COLORS } from './format.mjs';

export async function renderRegimeBand() {
  const el = document.getElementById('regime-band');
  try {
    const rows = await fetchJson('/api/regime/history', {});
    const segments = buildRegimeSegments(rows);
    const span = (segments[segments.length - 1]?.toTs || 1) - (segments[0]?.fromTs || 0) || 1;
    el.innerHTML = segments.map((s) => {
      const widthPct = ((s.toTs - s.fromTs + 1) / span) * 100;
      return `<span style="display:inline-block;height:100%;width:${widthPct}%;background:${REGIME_COLORS[s.label] || '#000'};" title="${s.label}"></span>`;
    }).join('');
  } catch (err) {
    el.textContent = `Could not load regime history: ${err.message}`;
  }
}

export async function renderIndicatorPanel(coin, tf) {
  const el = document.getElementById('indicator-panel');
  try {
    const data = await fetchJson(`/api/indicators/${coin}`, { tf });
    const lastRsi = data.rsi14[data.rsi14.length - 1];
    const lastAdx = data.adx14[data.adx14.length - 1];
    el.textContent = `RSI(14): ${lastRsi !== null ? lastRsi.toFixed(1) : '—'}  ·  ADX(14): ${lastAdx !== null ? lastAdx.toFixed(1) : '—'}`;
  } catch (err) {
    el.textContent = `Could not load indicator panel: ${err.message}`;
  }
}

renderRegimeBand();
