# Technical Indicators Design

**Date:** 2026-06-03
**Status:** Approved

## Summary

Add MACD, Bollinger Bands, EMA 50/200, Stochastic RSI, and Volume Ratio calculated from local SQLite 1h candles, cached in `data/indicators.json`, refreshed every 15 minutes. Add Crypto Fear & Greed Index fetched hourly from Alternative.me, cached in `data/feargreed.json`. Pass all indicators + Fear & Greed into Claude signal prompt. Expand signal to 5 levels: `strong_buy`, `buy`, `hold`, `sell`, `strong_sell`. Add Fear & Greed gauge badge to dashboard top.

---

## Architecture

### New files

**`indicators.js`** — pure calculation functions, no I/O, no side effects:
- `calcEMA(values, period)` → number — standard EMA with SMA seed
- `calcMACD(closes)` → `{macd, signal, histogram}` — 12/26/9
- `calcBollingerBands(closes)` → `{upper, middle, lower, bandwidthPct}` — 20-period
- `calcStochRSI(closes)` → `{k, d}` — 14/14/3/3
- `calcVolumeRatio(volumes)` → number — current vs 20-period avg

**`feargreed.js`** — single async export:
- `fetchFearGreed()` → `{value, classification}` — fetches `https://api.alternative.me/fng/?limit=1`

### Modified files

**`db.js`**:
- Add `getVolumes(coin_id, interval, limit)` — last N volume values oldest-first

**`server.js`**:
- New constants: `INDICATORS_FILE`, `FEARGREED_FILE`
- New `updateIndicators()` function — reads closes + volumes, runs all calculations, writes `data/indicators.json`
- New `updateFearGreed()` function — checks cache freshness (1h), fetches if stale, writes `data/feargreed.json`
- 15-min cron chain extended: `updateCandles → updateRSI → updateIndicators → updateSignals`
- New hourly cron: `updateFearGreed`
- `updateSignals()` updated: reads indicators + feargreed, builds richer prompt, validates 5-level signal
- New routes: `GET /api/indicators`, `GET /api/feargreed`

**`public/index.html`**:
- Fear & Greed gauge badge at page top
- Signal badge updated for 5-level display + colors

---

## `indicators.js` — Math Spec

### `calcEMA(values, period)`

```js
// Seed from SMA of first `period` values, then apply multiplier
const k = 2 / (period + 1);
let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
for (let i = period; i < values.length; i++) {
  ema = values[i] * k + ema * (1 - k);
}
return ema;
```

Returns `null` if `values.length < period`.

### `calcMACD(closes)`

Requires ≥ 35 closes (26 for EMA26 seed + 9 for signal EMA seed).

```
ema12 = calcEMA(closes, 12)
ema26 = calcEMA(closes, 26)
macdLine = ema12 - ema26

// Build MACD series over last (closes.length - 25) points for signal EMA
macdSeries = closes.slice(25).map((_, i) => {
  const ema12i = calcEMA(closes.slice(0, 26 + i), 12);  // wrong — see below
  ...
}
```

Correct approach: walk the full closes array once, accumulating EMA12 and EMA26 at each step, then accumulate MACD line values, then compute EMA9 of the MACD series.

```js
function calcMACD(closes) {
  if (closes.length < 35) return null;
  const k12 = 2/13, k26 = 2/27, k9 = 2/10;
  let ema12 = closes.slice(0, 12).reduce((a,b) => a+b,0) / 12;
  let ema26 = closes.slice(0, 26).reduce((a,b) => a+b,0) / 26;
  const macdSeries = [];
  for (let i = 12; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    if (i >= 25) {
      ema26 = closes[i] * k26 + ema26 * (1 - k26);
      macdSeries.push(ema12 - ema26);
    }
  }
  // signal = EMA9 of macdSeries
  let signal = macdSeries.slice(0, 9).reduce((a,b) => a+b,0) / 9;
  for (let i = 9; i < macdSeries.length; i++) {
    signal = macdSeries[i] * k9 + signal * (1 - k9);
  }
  const macd = macdSeries[macdSeries.length - 1];
  return { macd, signal, histogram: macd - signal };
}
```

### `calcBollingerBands(closes)`

Requires ≥ 20 closes.

```js
function calcBollingerBands(closes) {
  if (closes.length < 20) return null;
  const last20 = closes.slice(-20);
  const middle = last20.reduce((a,b) => a+b,0) / 20;
  const variance = last20.reduce((a,b) => a + (b - middle) ** 2, 0) / 20;
  const std = Math.sqrt(variance);
  const upper = middle + 2 * std;
  const lower = middle - 2 * std;
  const bandwidthPct = (upper - lower) / middle * 100;
  return { upper, middle, lower, bandwidthPct };
}
```

### `calcStochRSI(closes)` — 14/14/3/3

Requires ≥ 28 closes (14 for RSI period + 14 for stoch window).

```js
function calcStochRSI(closes) {
  if (closes.length < 28) return null;
  // Build RSI series over last 15 values (14-period RSI needs 15 closes)
  const rsiSeries = [];
  for (let i = closes.length - 15; i <= closes.length - 14; i++) {
    // ... need 14 RSI values for stoch window
  }
}
```

Correct approach: compute RSI at each of the last 14 steps (each needs 15 closes), so need 28 closes total:

```js
function calcStochRSI(closes) {
  if (closes.length < 28) return null;
  // Compute 14 RSI values (each from a 15-close window)
  const rsiValues = [];
  for (let i = closes.length - 28; i <= closes.length - 15; i++) {
    rsiValues.push(calculateRSIFromCloses(closes.slice(i, i + 15)));
  }
  // StochRSI raw series: last 3 values (for %K SMA3)
  const rawSeries = [];
  for (let i = 0; i <= rsiValues.length - 14; i++) {
    const window14 = rsiValues.slice(i, i + 14);
    const minR = Math.min(...window14), maxR = Math.max(...window14);
    rawSeries.push(maxR === minR ? 0 : (window14[13] - minR) / (maxR - minR) * 100);
  }
  // %K = SMA3 of last 3 rawSeries values
  const kSeries = [];
  for (let i = 0; i <= rawSeries.length - 3; i++) {
    kSeries.push((rawSeries[i] + rawSeries[i+1] + rawSeries[i+2]) / 3);
  }
  // %D = SMA3 of last 3 kSeries values
  const k = kSeries[kSeries.length - 1];
  const d = kSeries.length >= 3
    ? (kSeries.slice(-3).reduce((a,b) => a+b,0) / 3)
    : k;
  return { k, d };
}
```

`calculateRSIFromCloses` is a pure function extracted from `db.calculateRSI` (or reimplemented inline in indicators.js — see db.js note below).

### `calcVolumeRatio(volumes)`

`volumes` = last 21 volumes oldest-first.

```js
function calcVolumeRatio(volumes) {
  if (volumes.length < 21) return null;
  const avg20 = volumes.slice(0, 20).reduce((a,b) => a+b,0) / 20;
  return avg20 === 0 ? null : volumes[20] / avg20;
}
```

### EMA 50/200 + cross detection

Computed in `updateIndicators()` in server.js (not in indicators.js, since it needs 4 consecutive EMA values for cross detection):

```js
const ema50  = ind.calcEMA(closes, 50);
const ema200 = ind.calcEMA(closes, 200);
const price  = closes[closes.length - 1];
const emaAbovePrice = ema200 != null && price > ema200;

// Cross detection: need EMA50 and EMA200 at each of last 4 closes
function emaAt(closes, period, endIdx) {
  return ind.calcEMA(closes.slice(0, endIdx + 1), period);
}
let goldenCross = false, deathCross = false;
for (let i = closes.length - 3; i < closes.length; i++) {
  const e50prev  = emaAt(closes, 50, i-1);
  const e200prev = emaAt(closes, 200, i-1);
  const e50curr  = emaAt(closes, 50, i);
  const e200curr = emaAt(closes, 200, i);
  if (e50prev != null && e200prev != null && e50curr != null && e200curr != null) {
    if (e50prev <= e200prev && e50curr > e200curr) goldenCross = true;
    if (e50prev >= e200prev && e50curr < e200curr) deathCross  = true;
  }
}
```

---

## `db.js` — New Function

```js
function getVolumes(coin_id, interval, limit) {
  return prepare(
    `SELECT volume FROM candles WHERE coin_id = ? AND interval = ?
     ORDER BY time DESC LIMIT ?`
  ).all(coin_id, interval, limit).map(r => r.volume).reverse();
}
```

Export added to `module.exports`.

Also extract a pure `_calcRSI(closes)` helper within db.js (same logic as current `calculateRSI`), used by both `calculateRSI` and exported for indicators use. **Do not export `_calcRSI`** — indicators.js reimplements the 14-period RSI inline to avoid coupling.

---

## `feargreed.js`

```js
'use strict';
const BASE = 'https://api.alternative.me/fng/';

async function fetchFearGreed() {
  const res = await fetch(`${BASE}?limit=1`);
  if (!res.ok) throw new Error(`Fear & Greed API ${res.status}`);
  const body = await res.json();
  const d = body.data[0];
  return { value: parseInt(d.value, 10), classification: d.value_classification };
}

module.exports = { fetchFearGreed };
```

---

## `server.js` — New/Changed Functions

### Constants (add near top)

```js
const INDICATORS_FILE = path.join(DATA_DIR, 'indicators.json');
const FEARGREED_FILE  = path.join(DATA_DIR, 'feargreed.json');
```

### `updateIndicators()`

```js
async function updateIndicators() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;
  const cache = {};
  for (const id of wl.coins) {
    const closes  = db.getCloses(id, '1h', 300);
    const volumes = db.getVolumes(id, '1h', 21);
    if (closes.length < 35) continue;
    const price = closes[closes.length - 1];
    const macd  = ind.calcMACD(closes);
    const bb    = ind.calcBollingerBands(closes);
    const stoch = ind.calcStochRSI(closes);
    const volR  = ind.calcVolumeRatio(volumes);
    const ema50  = ind.calcEMA(closes, 50);
    const ema200 = ind.calcEMA(closes, 200);
    const emaAbovePrice = ema200 != null && price > ema200;
    // Cross detection (see math spec above)
    let goldenCross = false, deathCross = false;
    // ... (walk last 3 candles)
    cache[id] = { macd, bb, ema50, ema200, emaAbovePrice, goldenCross, deathCross, stochRsi: stoch, volumeRatio: volR, updatedAt: new Date().toISOString() };
  }
  writeJson(INDICATORS_FILE, cache);
  console.log('[indicators] updated:', Object.keys(cache).join(', '));
}
```

### `updateFearGreed()`

```js
async function updateFearGreed() {
  const cached = readJson(FEARGREED_FILE, {});
  if (cached.fetchedAt && Date.now() - cached.fetchedAt < 3600000) return;
  try {
    const fg = await feargreed.fetchFearGreed();
    writeJson(FEARGREED_FILE, { ...fg, fetchedAt: Date.now() });
    console.log(`[feargreed] ${fg.value} (${fg.classification})`);
  } catch (e) {
    console.error('[feargreed] fetch failed:', e.message);
  }
}
```

### Updated 15-min cron chain

```js
cron.schedule('*/15 * * * *', () => {
  updateCandles()
    .then(() => updateRSI())
    .then(() => updateIndicators())
    .then(() => updateSignals())
    .catch(e => console.error('[cron 15min]', e.message));
});
```

### New hourly cron

```js
cron.schedule('0 * * * *', () => {
  updateFearGreed().catch(e => console.error('[cron feargreed]', e.message));
});
```

### Startup

Add after `updateSignals()` call in startup chain:

```js
.then(() => updateIndicators())
.then(() => updateSignals())  // signals after indicators
.then(() => updateFearGreed())
```

### Updated `updateSignals()` prompt

```js
const indicators = readJson(INDICATORS_FILE, {});
const fng        = readJson(FEARGREED_FILE, {});
// ...per coin:
const ind = indicators[id] || {};
const fngStr = fng.value != null ? `${fng.value}/100 (${fng.classification})` : 'unavailable';

const prompt =
  `Coin: ${meta.name}\n` +
  `Price: $${price}\n` +
  `24h change: ${change24h.toFixed(2)}%\n` +
  `RSI (14): ${rsi != null ? rsi.toFixed(1) : 'unavailable'}\n` +
  (ind.macd ? `MACD: ${ind.macd.macd.toFixed(2)} | Signal: ${ind.macd.signal.toFixed(2)} | Histogram: ${ind.macd.histogram.toFixed(2)}\n` : '') +
  (ind.bb   ? `Bollinger: Upper $${ind.bb.upper.toFixed(2)} Middle $${ind.bb.middle.toFixed(2)} Lower $${ind.bb.lower.toFixed(2)} BW: ${ind.bb.bandwidthPct.toFixed(1)}%\n` : '') +
  (ind.ema50  != null ? `EMA50: $${ind.ema50.toFixed(2)}\n` : '') +
  (ind.ema200 != null ? `EMA200: $${ind.ema200.toFixed(2)} | Price ${ind.emaAbovePrice ? 'above' : 'below'} 200 EMA\n` : '') +
  (ind.goldenCross ? 'Golden cross detected in last 3 candles.\n' : '') +
  (ind.deathCross  ? 'Death cross detected in last 3 candles.\n'  : '') +
  (ind.stochRsi   ? `Stoch RSI: %K=${ind.stochRsi.k.toFixed(1)} %D=${ind.stochRsi.d.toFixed(1)}\n` : '') +
  (ind.volumeRatio != null ? `Volume ratio vs 20-period avg: ${ind.volumeRatio.toFixed(2)}x\n` : '') +
  `Fear & Greed: ${fngStr}\n\n` +
  `Respond with valid JSON only, no markdown:\n` +
  `{"signal":"buy","summary":"..."} where signal is exactly one of: strong_buy, buy, hold, sell, strong_sell\n` +
  `Summary: 1-2 sentences referencing specific indicator values.`;
```

Signal validation:
```js
if (!['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'].includes(parsed.signal))
  throw new Error(`invalid signal: ${parsed.signal}`);
```

### New routes

```js
app.get('/api/indicators', (req, res) => res.json(readJson(INDICATORS_FILE, {})));
app.get('/api/feargreed',  (req, res) => res.json(readJson(FEARGREED_FILE, {})));
```

---

## Frontend (`public/index.html`)

### Fear & Greed Badge

Placed above the coin table. Fetched once on load + every 5 minutes:

```js
async function updateFearGreedBadge() {
  const data = await fetch('/api/feargreed').then(r => r.json());
  const el = document.getElementById('fear-greed-badge');
  if (!data.value) { el.textContent = 'Fear & Greed: —'; return; }
  const color = data.value < 25 ? 'var(--red)'
    : data.value < 50 ? 'var(--amber)'
    : data.value < 75 ? 'var(--accent)'
    : '#a78bfa';
  el.style.color = color;
  el.textContent = `Fear & Greed  ${data.value} — ${data.classification}`;
}
```

HTML element: `<div id="fear-greed-badge" style="..."></div>`

### Signal Badge Colors

| Signal | Color | Text |
|---|---|---|
| `strong_buy` | `var(--accent)` bold | `STRONG BUY` |
| `buy` | `var(--accent)` | `BUY` |
| `hold` | `var(--muted)` | `HOLD` |
| `sell` | `var(--red)` | `SELL` |
| `strong_sell` | `var(--red)` bold | `STRONG SELL` |

Update `renderSignal()` (or equivalent) to map new keys and apply `font-weight: bold` for `strong_buy` / `strong_sell`.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `closes.length < 35` | Skip coin in `updateIndicators()`, no entry in cache |
| `calcMACD` returns null | Omit MACD lines from prompt |
| Fear & Greed fetch fails | Log error, serve stale cache; if no cache, `value: null` |
| Fear & Greed `value` null in frontend | Display `—` |
| Signal validation fails (invalid 5-level value) | Log error, skip — retain previous cached signal |
| `getVolumes` returns < 21 rows | `calcVolumeRatio` returns null, omit from prompt |

---

## What Does Not Change

- `db.js` schema — no schema changes
- `binance.js` — no changes
- `coingecko.js` — no changes
- `/api/market` response shape — unchanged
- `/api/rsi` — unchanged
- RSI algorithm in `db.js` — unchanged
- Alert logic — unchanged
- Candle cron timing — unchanged
