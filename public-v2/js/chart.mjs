import { fetchJson } from './api.mjs';
import { createChart, CandlestickSeries } from '/vendor/lightweight-charts.standalone.production.mjs';

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

document.getElementById('coin-select').addEventListener('change', renderChart);
document.getElementById('tf-select').addEventListener('change', renderChart);
renderChart();
