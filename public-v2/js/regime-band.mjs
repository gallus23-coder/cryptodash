import { fetchJson } from './api.mjs';
import { createChart, LineSeries } from '/vendor/lightweight-charts.standalone.production.mjs';
import { buildRegimeSegments, REGIME_COLORS, escapeHtml } from './format.mjs';

export async function renderRegimeBand() {
  const el = document.getElementById('regime-band');
  try {
    const rows = await fetchJson('/api/regime/history', {});
    const segments = buildRegimeSegments(rows);
    const span = (segments[segments.length - 1]?.toTs || 1) - (segments[0]?.fromTs || 0) || 1;
    el.innerHTML = segments.map((s) => {
      const widthPct = ((s.toTs - s.fromTs + 1) / span) * 100;
      const showLabel = widthPct > 6;
      return `<span style="display:inline-flex;align-items:center;justify-content:center;overflow:hidden;height:100%;width:${widthPct}%;background:${REGIME_COLORS[s.label] || '#000'};" title="${escapeHtml(s.label)}">${showLabel ? `<span style="font-size:10px;font-family:var(--mono);color:#fff;white-space:nowrap;">${escapeHtml(s.label)}</span>` : ''}</span>`;
    }).join('');
  } catch (err) {
    el.textContent = `Could not load regime history: ${err.message}`;
  }
}

let rsiChart;
let rsiSeries;

export function resizeIndicatorPanel() {
  if (!rsiChart) return;
  const container = document.getElementById('indicator-panel');
  rsiChart.resize(container.clientWidth, container.clientHeight);
}

export async function renderIndicatorPanel(coin, tf) {
  const el = document.getElementById('indicator-panel');
  try {
    const data = await fetchJson(`/api/indicators/${coin}`, { tf });
    if (!rsiChart) {
      rsiChart = createChart(el, {
        height: 150,
        layout: { background: { color: '#FFFFFF' }, textColor: '#111827' },
        grid: { vertLines: { color: '#F3F4F6' }, horzLines: { color: '#F3F4F6' } },
        timeScale: { borderColor: '#E5E7EB' },
        rightPriceScale: { borderColor: '#E5E7EB' },
      });
      rsiSeries = rsiChart.addSeries(LineSeries, { color: '#1D4ED8', lineWidth: 2, title: 'RSI(14)' });
      rsiSeries.createPriceLine({ price: 70, color: '#B91C1C', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '70' });
      rsiSeries.createPriceLine({ price: 30, color: '#15803D', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '30' });
    }
    const points = data.ts.map((t, i) => ({ time: t, value: data.rsi14[i] })).filter((p) => p.value !== null);
    rsiSeries.setData(points);
    resizeIndicatorPanel();
  } catch (err) {
    el.textContent = `Could not load indicator panel: ${err.message}`;
  }
}

renderRegimeBand();
