# Candlestick Chart Modal Design

**Date:** 2026-06-02
**Status:** Approved

## Summary

Add a full-screen candlestick chart modal that opens when a user clicks a coin's sparkline cell in the watchlist table. Uses TradingView Lightweight Charts v4 with three stacked panels: candlestick, volume histogram, and RSI line. Backend adds `days` param and RSI series to the `/api/candles` endpoint.

---

## Backend Changes

### `/api/candles/:coinId` — two additions

**1. `days` query param (optional)**

Overrides the fixed time window. Capped at available data depth per interval:
- 1m: max 7 days
- 5m, 15m: max 7 days
- 1h, 4h, 1d: max 90 days

```
GET /api/candles/bitcoin?interval=1h&days=7
→ returns last 7 days of 1h candles
```

If `days` is not provided, the existing full-window defaults apply unchanged.

**2. RSI series in response**

Calculate sliding RSI-14 from candle closes on the backend before returning. Each candle row gains an `rsi` field. First 14 rows get `rsi: null`.

Response shape (unchanged fields + new `rsi`):
```json
[
  { "time": 1700000000000, "open": 95000, "high": 96000, "low": 94000, "close": 95500, "volume": 1234.5, "rsi": null },
  { "time": 1700003600000, "open": 95500, "high": 97000, "low": 95000, "close": 96800, "volume": 2345.6, "rsi": 62.4 }
]
```

Implementation in `server.js`: after fetching candles, extract closes array, call `db.calculateRSI` for each index `i` using `closes.slice(0, i+1)`, attach to row.

**No new routes. No new npm dependencies.**

---

## Frontend Changes

All changes in `public/index.html`. File is currently 463 lines; modal adds ~200 lines.

### CDN script (added to `<head>`)

```html
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
```

### Click target

Sparkline `<td>` gets `onclick` and `cursor:pointer`:
```js
<td style="cursor:pointer" onclick="openCandleModal('${row.id}', ${JSON.stringify(row)})">
  ${sp}
</td>
```

The second argument passes current market data (name, price, 24h change, image) to avoid an extra fetch for the header.

### Modal HTML structure

Single `<div id="candle-modal">` injected into `<body>`, hidden by default (`display:none`):

```html
<div id="candle-modal" class="modal-overlay">
  <div class="modal-card">
    <div class="modal-header">
      <img id="modal-coin-img">
      <span id="modal-coin-name"></span>
      <span id="modal-coin-price"></span>
      <span id="modal-coin-change"></span>
      <button id="modal-close">×</button>
    </div>
    <div class="modal-timeframes">
      <!-- 1M 5M 15M 1H 4H 1D buttons -->
    </div>
    <div id="chart-candle"  class="chart-panel" style="flex:6"></div>
    <div id="chart-volume"  class="chart-panel" style="flex:2"></div>
    <div id="chart-rsi"     class="chart-panel" style="flex:2"></div>
  </div>
</div>
```

Overlay click (not card click) closes modal.

### Modal CSS (dark theme, CSS variables)

```css
.modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.75);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: var(--radius);
  width: 90vw; height: 90vh;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.modal-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.modal-timeframes {
  display: flex; gap: 4px; padding: 8px 16px;
  border-bottom: 1px solid var(--border);
}
.modal-timeframes button {
  background: var(--bg3); border: 1px solid var(--border);
  color: var(--muted); border-radius: 4px;
  padding: 4px 10px; cursor: pointer; font-size: 12px;
}
.modal-timeframes button.active {
  background: var(--accent); color: #000; border-color: var(--accent);
}
.chart-panel { min-height: 0; }
```

### Chart JS

**State:**
```js
let _charts = [];          // [candleChart, volumeChart, rsiChart]
let _currentCoin = null;   // { id, name, price, change24h, image }
let _currentInterval = '1h';
```

**`openCandleModal(coinId, rowData)`:**
1. Set `_currentCoin` from `rowData`
2. Populate header (image, name, price, 24h change badge)
3. Set active timeframe button to `1H`
4. Show modal (`display: flex`)
5. Call `loadChartData(coinId, '1h')`

**`loadChartData(coinId, interval)`:**
1. Destroy existing `_charts` instances
2. Fetch `/api/candles/${coinId}?interval=${interval}`
3. Build `candleData`, `volumeData`, `rsiData` arrays from response
4. Create 3 chart instances in `#chart-candle`, `#chart-volume`, `#chart-rsi`
5. Set data on each series
6. Add price lines at RSI 70 (red dashed) and 30 (green dashed)
7. Add crosshair tooltip div for OHLCV display

**Chart config:**

```js
const chartOpts = {
  layout: { background: { color: 'transparent' }, textColor: '#6b7280' },
  grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
  timeScale: { timeVisible: true, secondsVisible: false },
  rightPriceScale: { borderVisible: false },
  crosshair: { mode: 1 },
  handleScroll: true,
  handleScale: true,
};

// Candlestick series
{ upColor: '#4ade80', downColor: '#f87171', borderVisible: false,
  wickUpColor: '#4ade80', wickDownColor: '#f87171' }

// Volume series
{ color: '#4ade80', priceFormat: { type: 'volume' },
  priceScaleId: 'volume' }
// colour each bar green/red based on candle direction

// RSI series
{ color: '#60a5fa', lineWidth: 1, priceScaleId: 'rsi',
  priceFormat: { type: 'custom', formatter: v => v.toFixed(1) } }
```

**OHLCV tooltip:** custom `<div>` positioned via `subscribeCrosshairMove`, shows O/H/L/C/V values when crosshair is active.

**`closeCandleModal()`:**
1. Destroy all 3 chart instances, clear `_charts`
2. Hide modal (`display: none`)

**Event listeners:**
```js
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCandleModal(); });
document.getElementById('modal-close').onclick = closeCandleModal;
document.getElementById('candle-modal').onclick = e => {
  if (e.target.id === 'candle-modal') closeCandleModal();
};
timeframeButtons.forEach(btn => btn.onclick = () => {
  setActiveTimeframe(btn.dataset.interval);
  loadChartData(_currentCoin.id, btn.dataset.interval);
});
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `/api/candles` returns empty array | Chart shows empty state message |
| Fetch fails | Show error text in chart area |
| RSI null for first 14 candles | Skip those points in RSI series |
| Modal opened while previous fetch in flight | Cancel via `AbortController` |

---

## CLAUDE.md Updates

- Document `/api/candles` `days` param and RSI field in response
- Document chart modal feature under project structure

---

## What Does Not Change

- No new npm dependencies (Lightweight Charts loaded from CDN only)
- `/api/market` response shape unchanged
- All existing dashboard functionality unchanged
- Backend module structure unchanged
