import { fetchJson } from './api.mjs';
import { createChart, CandlestickSeries, LineSeries } from '/vendor/lightweight-charts.standalone.production.mjs';
import { renderMarkersAndPositions } from './positions.mjs';
import { renderIndicatorPanel } from './regime-band.mjs';
import { computeVisibleRange, escapeHtml } from './format.mjs';

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'LINK'];

let chart;
let candleSeries;
let latestCandleTs = null;
let selectedCoin = 'BTC';

function getCoin() { return selectedCoin; }
function getTf() { return document.getElementById('tf-select').value; }

export function resizeChart() {
  if (!chart) return;
  const container = document.getElementById('chart');
  chart.resize(container.clientWidth, container.clientHeight);
}

export function setVisibleRangeDays(presetDays) {
  if (!chart || latestCandleTs === null) return;
  const range = computeVisibleRange(presetDays, latestCandleTs);
  if (range === null) {
    chart.timeScale().fitContent();
  } else {
    chart.timeScale().setVisibleRange(range);
  }
}

export async function renderChart() {
  if (!chart) {
    chart = createChart(document.getElementById('chart'), {
      height: 400,
      layout: { background: { color: '#FFFFFF' }, textColor: '#111827' },
      grid: { vertLines: { color: '#F3F4F6' }, horzLines: { color: '#F3F4F6' } },
      timeScale: { borderColor: '#E5E7EB' },
      rightPriceScale: { borderColor: '#E5E7EB' },
    });
    candleSeries = chart.addSeries(CandlestickSeries, { upColor: '#15803D', downColor: '#B91C1C', borderVisible: false, wickUpColor: '#15803D', wickDownColor: '#B91C1C' });
  }
  try {
    const candles = await fetchJson(`/api/candles/${getCoin()}`, { tf: getTf() });
    candleSeries.setData(candles.map((c) => ({ time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close })));
    latestCandleTs = candles.length > 0 ? candles[candles.length - 1].ts : null;
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
      if (bollingerOn && !overlaySeries[key]) overlaySeries[key] = chart.addSeries(LineSeries, { lineWidth: 1, color: '#6B7280' });
      if (!bollingerOn && overlaySeries[key]) { chart.removeSeries(overlaySeries[key]); delete overlaySeries[key]; }
      if (overlaySeries[key]) overlaySeries[key].setData(toPoints(data.ts, data[key]));
    }
  } catch (err) {
    console.error('Could not load indicators:', err.message);
  }
}

function formatInTrade(entryTs, nowTs) {
  const hours = Math.floor((nowTs - entryTs) / 3600);
  const days = Math.floor(hours / 24);
  return days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`;
}

async function renderSideCards(positions, candles) {
  const openCard = document.getElementById('open-position-card');
  const decisionCard = document.getElementById('entry-decision-card');
  const position = positions.find((p) => p.coin === selectedCoin);

  if (!position) {
    openCard.classList.add('hidden');
    decisionCard.classList.add('hidden');
    return;
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const latestClose = candles.length > 0 ? candles[candles.length - 1].close : position.entryPrice;
  const pnlPct = ((latestClose - position.entryPrice) / position.entryPrice) * 100;
  const stakeValue = position.units * position.entryPrice;

  openCard.classList.remove('hidden');
  openCard.innerHTML = `
    <div class="watchlist-label">Open position</div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:8px;">
      <span style="font-weight:600;font-size:16px;">${escapeHtml(position.coin)}/GBP</span>
      <span style="font-family:var(--mono);font-size:16px;font-weight:600;color:${pnlPct >= 0 ? 'var(--green)' : 'var(--red)'};">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</span>
    </div>
    <dl style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;margin:14px 0 0 0;">
      <div><dt style="font-size:12px;color:var(--muted);">Entry</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);">£${position.entryPrice}</dd></div>
      <div><dt style="font-size:12px;color:var(--muted);">Now</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);">£${latestClose}</dd></div>
      <div><dt style="font-size:12px;color:var(--muted);">Stop</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);color:var(--red);">£${position.initialStopPrice}</dd></div>
      <div><dt style="font-size:12px;color:var(--muted);">Stake</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);">£${stakeValue.toFixed(2)}</dd></div>
      <div><dt style="font-size:12px;color:var(--muted);">In trade</dt><dd style="margin:2px 0 0 0;font-family:var(--mono);">${formatInTrade(position.entryTs, nowTs)}</dd></div>
    </dl>
  `;

  try {
    const markers = await fetchJson(`/api/markers/${selectedCoin}`, {});
    const candidate = markers.candidates.find((c) => c.id === position.candidateId);
    if (!candidate || !candidate.decision) {
      decisionCard.classList.add('hidden');
      return;
    }
    decisionCard.classList.remove('hidden');
    decisionCard.innerHTML = `
      <div class="watchlist-label">Entry decision</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
        <span style="font-family:var(--mono);font-size:12px;background:#F3F4F6;border-radius:4px;padding:2px 6px;">${escapeHtml(candidate.setup)}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px;">
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;"><div style="font-size:12px;color:var(--muted);">Default</div><div style="font-family:var(--mono);font-size:13px;margin-top:4px;">Take ${candidate.default.size}× · Stop ${candidate.default.stopAtr}×ATR</div></div>
        <div style="border:1px solid var(--blue-border);background:var(--blue-bg);border-radius:8px;padding:10px;"><div style="font-size:12px;color:var(--accent);font-weight:600;">Claude</div><div style="font-family:var(--mono);font-size:13px;margin-top:4px;">${candidate.decision.action === 'take' ? `Take ${candidate.decision.size}× · Stop ${candidate.decision.stopAtr}×ATR` : 'Skip'}</div></div>
      </div>
      <p style="margin:12px 0 0 0;font-size:13px;line-height:1.5;color:#374151;">${escapeHtml(candidate.decision.plainReason || candidate.decision.reason || '')}</p>
    `;
  } catch (err) {
    decisionCard.classList.add('hidden');
  }
}

async function renderWatchlist(positions) {
  const el = document.getElementById('watchlist');
  const rows = await Promise.all(COINS.map(async (coin) => {
    try {
      const [candles, markers] = await Promise.all([
        fetchJson(`/api/candles/${coin}`, { tf: '1h' }),
        fetchJson(`/api/markers/${coin}`, {}),
      ]);
      const last = candles.length > 0 ? candles[candles.length - 1] : null;
      const prior = candles.length > 24 ? candles[candles.length - 25] : null;
      const changePct = last && prior ? ((last.close - prior.close) / prior.close) * 100 : null;
      const nowTs = Math.floor(Date.now() / 1000);
      const isCandidate = markers.candidates.some((c) => c.ts >= nowTs - 4 * 3600);
      const openPosition = positions.find((p) => p.coin === coin);
      return { coin, price: last ? last.close : null, changePct, isCandidate, openPosition };
    } catch (err) {
      return { coin, price: null, changePct: null, isCandidate: false, openPosition: null };
    }
  }));

  el.innerHTML = `
    <div class="watchlist-label">Watchlist</div>
    ${rows.map((r) => `
      <button type="button" data-coin="${escapeHtml(r.coin)}" class="${r.coin === selectedCoin ? 'selected' : ''}">
        <span class="wl-row"><span style="font-weight:600;">${escapeHtml(r.coin)}/GBP</span>${r.changePct === null ? '' : `<span style="font-family:var(--mono);font-size:12px;color:${r.changePct >= 0 ? 'var(--green)' : 'var(--red)'};">${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(1)}%</span>`}</span>
        <span class="wl-row"><span style="font-family:var(--mono);font-size:13px;">${r.price === null ? '—' : `£${r.price}`}</span>
          ${r.openPosition ? '<span class="wl-badge-open">OPEN</span>' : r.isCandidate ? '<span class="wl-badge-candidate">CANDIDATE</span>' : ''}
        </span>
      </button>
    `).join('')}
  `;

  el.querySelectorAll('button[data-coin]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedCoin = button.dataset.coin;
      renderAll();
    });
  });
}

async function renderChartHeader() {
  const el = document.getElementById('chart-header');
  const tfSelect = document.getElementById('tf-select');
  try {
    const candles = await fetchJson(`/api/candles/${selectedCoin}`, { tf: '1h' });
    const last = candles.length > 0 ? candles[candles.length - 1] : null;
    const prior = candles.length > 24 ? candles[candles.length - 25] : null;
    const changePct = last && prior ? ((last.close - prior.close) / prior.close) * 100 : null;
    el.innerHTML = `
      <div><h1 style="margin:0;font-size:20px;font-weight:600;">${escapeHtml(selectedCoin)}/GBP</h1>
      <div style="font-family:var(--mono);font-size:13px;color:var(--muted);margin-top:2px;">Kraken${last ? ` · £${last.close}` : ''}${changePct === null ? '' : ` · <span style="color:${changePct >= 0 ? 'var(--green)' : 'var(--red)'};">${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}% 24h</span>`}</div></div>
    `;
    el.appendChild(tfSelect);
  } catch (err) {
    el.textContent = `Could not load ${selectedCoin}: ${err.message}`;
  }
}

['toggle-ema20', 'toggle-ema50', 'toggle-ema200', 'toggle-bollinger'].forEach((id) => {
  document.getElementById(id).addEventListener('change', renderIndicatorOverlays);
});

async function renderAll() {
  await renderChartHeader();
  await renderChart();
  await renderIndicatorOverlays();
  const [positions, candles] = await Promise.all([
    fetchJson('/api/positions', {}),
    fetchJson(`/api/candles/${getCoin()}`, { tf: '1h' }),
  ]);
  await renderMarkersAndPositions(chart, candleSeries, getCoin());
  await renderIndicatorPanel(getCoin(), getTf());
  await renderSideCards(positions, candles);
  await renderWatchlist(positions);
}

document.getElementById('tf-select').addEventListener('change', renderAll);

document.querySelectorAll('button[data-range-days]').forEach((button) => {
  button.addEventListener('click', () => {
    const presetDays = button.dataset.rangeDays === '' ? null : Number(button.dataset.rangeDays);
    setVisibleRangeDays(presetDays);
  });
});

renderAll();
