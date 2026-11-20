import { fetchJson } from './api.mjs';
import { createChart, CandlestickSeries, LineSeries } from '/vendor/lightweight-charts.standalone.production.mjs';
import { renderMarkersAndPositions } from './positions.mjs';
import { renderIndicatorPanel } from './regime-band.mjs';

let chart;
let candleSeries;

function getCoin() { return document.getElementById('coin-select').value; }
function getTf() { return document.getElementById('tf-select').value; }

export async function renderChart() {
  if (!chart) {
    chart = createChart(document.getElementById('chart'), { height: 400 });
    candleSeries = chart.addSeries(CandlestickSeries);
  }
  try {
    const candles = await fetchJson(`/api/candles/${getCoin()}`, { tf: getTf() });
    candleSeries.setData(candles.map((c) => ({ time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close })));
  } catch (err) {
    document.getElementById('chart').textContent = `Could not load candles: ${err.message}`;
  }
}

const overlaySeries = {};

function toPoints(ts, values) {
  return ts.map((t, i) => ({ time: t, value: values[i] })).filter((p) => p.value !== null);
}

export async function renderIndicatorOverlays() {
  try {
    const data = await fetchJson(`/api/indicators/${getCoin()}`, { tf: getTf() });
    const toggles = {
      ema20: document.getElementById('toggle-ema20').checked,
      ema50: document.getElementById('toggle-ema50').checked,
      ema200: document.getElementById('toggle-ema200').checked,
    };
    for (const [key, enabled] of Object.entries(toggles)) {
      if (enabled && !overlaySeries[key]) {
        overlaySeries[key] = chart.addSeries(LineSeries, { lineWidth: 1 });
      }
      if (!enabled && overlaySeries[key]) {
        chart.removeSeries(overlaySeries[key]);
        delete overlaySeries[key];
      }
      if (overlaySeries[key]) overlaySeries[key].setData(toPoints(data.ts, data[key]));
    }

    const bollingerOn = document.getElementById('toggle-bollinger').checked;
    for (const key of ['bollingerUpper', 'bollingerMiddle', 'bollingerLower']) {
      if (bollingerOn && !overlaySeries[key]) overlaySeries[key] = chart.addSeries(LineSeries, { lineWidth: 1, color: '#8b92a5' });
      if (!bollingerOn && overlaySeries[key]) { chart.removeSeries(overlaySeries[key]); delete overlaySeries[key]; }
      if (overlaySeries[key]) overlaySeries[key].setData(toPoints(data.ts, data[key]));
    }
  } catch (err) {
    console.error('Could not load indicators:', err.message);
  }
}

['toggle-ema20', 'toggle-ema50', 'toggle-ema200', 'toggle-bollinger'].forEach((id) => {
  document.getElementById(id).addEventListener('change', renderIndicatorOverlays);
});

async function renderAll() {
  await renderChart();
  await renderIndicatorOverlays();
  await renderMarkersAndPositions(chart, candleSeries, getCoin());
  await renderIndicatorPanel(getCoin(), getTf());
}

['coin-select', 'tf-select'].forEach((id) => document.getElementById(id).addEventListener('change', renderAll));
renderAll();
