# Technical Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MACD, Bollinger Bands, EMA 50/200, Stochastic RSI, Volume Ratio, and Crypto Fear & Greed Index to the dashboard, with all indicators fed into richer Claude signal prompts and 5-level signal classification.

**Architecture:** New `indicators.js` module holds pure calculation functions (no I/O). New `feargreed.js` fetches Alternative.me API. `server.js` gets `updateIndicators()` + `updateFearGreed()` functions wired into the 15-min and hourly crons respectively. `db.js` gains `getVolumes()`. Frontend gains a Fear & Greed badge strip and updated 5-level signal badge rendering.

**Tech Stack:** Node.js, better-sqlite3, Anthropic claude-haiku-4-5-20251001, Alternative.me API (no key), node:test

---

## File Map

| File | Change |
|------|--------|
| `db.js` | Add `getVolumes(coin_id, interval, limit)` |
| `indicators.js` | **Create** — pure calc: EMA, MACD, BB, StochRSI, VolumeRatio |
| `feargreed.js` | **Create** — `fetchFearGreed()` async fetch |
| `server.js` | Add constants, `updateIndicators`, `updateFearGreed`, update crons, update `updateSignals`, add routes |
| `public/index.html` | F&G badge CSS+HTML+JS, 5-level signal CSS+logic |
| `test/db.test.js` | Append `getVolumes` tests |
| `test/indicators.test.js` | **Create** — tests for all calc functions |
| `test/feargreed.test.js` | **Create** — fetch mock tests |

---

## Task 1: `db.js` — add `getVolumes`

**Files:**
- Modify: `db.js`
- Modify: `test/db.test.js`

- [ ] **Step 1: Append failing test to `test/db.test.js`**

Add at the very end of `test/db.test.js` (after all existing tests):

```js
test('getVolumes returns volumes oldest-first, limited to N', () => {
  // TC candles were inserted in earlier test; they have volumes 1000,1100,1200,1300,1400,1500
  const vols = db.getVolumes(COIN, INT, 3);
  assert.equal(vols.length, 3);
  // oldest-first: last 3 by DESC time reversed → indices 3,4,5 → 1300,1400,1500
  assert.equal(vols[0], 1300);
  assert.equal(vols[1], 1400);
  assert.equal(vols[2], 1500);
});

test('getVolumes returns empty array for unknown coin', () => {
  const vols = db.getVolumes('unknown', INT, 10);
  assert.equal(vols.length, 0);
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
cd /home/gallus23/crypto-dashboard && node --test test/db.test.js 2>&1 | tail -20
```

Expected: `TypeError: db.getVolumes is not a function`

- [ ] **Step 3: Add `getVolumes` to `db.js`**

Add after `getCloses` function (around line 98 in `db.js`):

```js
// Returns volumes oldest-first (last N by time, reversed).
function getVolumes(coin_id, interval, limit) {
  const rows = prepare(
    'SELECT volume FROM candles WHERE coin_id = ? AND interval = ? ORDER BY time DESC LIMIT ?'
  ).all(coin_id, interval, limit);
  return rows.map(r => r.volume).reverse();
}
```

Add `getVolumes` to the `module.exports` line at the bottom of `db.js`:

```js
module.exports = {
  initDb, upsertMeta, getMeta, getAllMeta, updateMarketCap,
  insertCandles, getLastCandleTime, getCloses, getVolumes, getCandles, getAggCandles,
  calculateRSI, pruneCandles,
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/gallus23/crypto-dashboard && node --test test/db.test.js 2>&1 | tail -20
```

Expected: all tests pass including the two new getVolumes tests.

- [ ] **Step 5: Commit**

```bash
cd /home/gallus23/crypto-dashboard
git add db.js test/db.test.js
git commit -m "feat: add db.getVolumes for volume ratio calculation"
```

---

## Task 2: `indicators.js` — pure calculation functions

**Files:**
- Create: `indicators.js`
- Create: `test/indicators.test.js`

- [ ] **Step 1: Write `test/indicators.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ind = require('../indicators');

// ── calcEMA ───────────────────────────────────────────────────────────────────

test('calcEMA returns null for insufficient data', () => {
  assert.equal(ind.calcEMA([1, 2, 3], 12), null);
});

test('calcEMA of constant series equals the constant', () => {
  const closes = Array(20).fill(5);
  const result = ind.calcEMA(closes, 12);
  assert.ok(Math.abs(result - 5) < 0.001, `expected ~5, got ${result}`);
});

test('calcEMA exact period length returns SMA', () => {
  // With exactly `period` values, result is the SMA (no smoothing loop runs)
  const closes = [2, 4, 6, 8]; // period=4, SMA=5
  assert.ok(Math.abs(ind.calcEMA(closes, 4) - 5) < 0.001);
});

// ── calcMACD ──────────────────────────────────────────────────────────────────

test('calcMACD returns null for fewer than 35 closes', () => {
  assert.equal(ind.calcMACD(Array(34).fill(100)), null);
});

test('calcMACD returns null for exactly 34 closes', () => {
  assert.equal(ind.calcMACD(Array(34).fill(100)), null);
});

test('calcMACD returns shape for 35+ closes', () => {
  const result = ind.calcMACD(Array(60).fill(100));
  assert.ok(result !== null);
  assert.ok('macd' in result && 'signal' in result && 'histogram' in result);
});

test('calcMACD constant price → macd and signal near zero', () => {
  const result = ind.calcMACD(Array(60).fill(100));
  assert.ok(Math.abs(result.macd) < 0.001);
  assert.ok(Math.abs(result.signal) < 0.001);
  assert.ok(Math.abs(result.histogram) < 0.001);
});

test('calcMACD histogram = macd - signal', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.3) * 5);
  const result = ind.calcMACD(closes);
  assert.ok(Math.abs(result.histogram - (result.macd - result.signal)) < 0.0001);
});

// ── calcBollingerBands ────────────────────────────────────────────────────────

test('calcBollingerBands returns null for fewer than 20 closes', () => {
  assert.equal(ind.calcBollingerBands(Array(19).fill(100)), null);
});

test('calcBollingerBands constant series: all bands equal, bandwidth zero', () => {
  const bb = ind.calcBollingerBands(Array(20).fill(100));
  assert.ok(bb !== null);
  assert.ok(Math.abs(bb.upper - 100) < 0.001);
  assert.ok(Math.abs(bb.middle - 100) < 0.001);
  assert.ok(Math.abs(bb.lower - 100) < 0.001);
  assert.ok(Math.abs(bb.bandwidthPct) < 0.001);
});

test('calcBollingerBands: upper > middle > lower for varying prices', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const bb = ind.calcBollingerBands(closes);
  assert.ok(bb.upper > bb.middle);
  assert.ok(bb.lower < bb.middle);
  assert.ok(bb.bandwidthPct > 0);
});

test('calcBollingerBands uses only last 20 closes', () => {
  // 25 closes: first 5 are extreme outliers — should not affect result
  const closes = [...Array(5).fill(99999), ...Array(20).fill(100)];
  const bb = ind.calcBollingerBands(closes);
  assert.ok(Math.abs(bb.middle - 100) < 0.001);
});

// ── calcVolumeRatio ───────────────────────────────────────────────────────────

test('calcVolumeRatio returns null for fewer than 21 volumes', () => {
  assert.equal(ind.calcVolumeRatio(Array(20).fill(1)), null);
});

test('calcVolumeRatio: current double average returns 2', () => {
  const volumes = [...Array(20).fill(1), 2];
  assert.ok(Math.abs(ind.calcVolumeRatio(volumes) - 2) < 0.001);
});

test('calcVolumeRatio: current equal to average returns 1', () => {
  const volumes = Array(21).fill(5);
  assert.ok(Math.abs(ind.calcVolumeRatio(volumes) - 1) < 0.001);
});

test('calcVolumeRatio returns null when average is zero', () => {
  assert.equal(ind.calcVolumeRatio(Array(21).fill(0)), null);
});

// ── calcStochRSI ──────────────────────────────────────────────────────────────

test('calcStochRSI returns null for fewer than 28 closes', () => {
  assert.equal(ind.calcStochRSI(Array(27).fill(100)), null);
});

test('calcStochRSI returns k and d for 28+ closes', () => {
  const result = ind.calcStochRSI(Array(60).fill(100));
  assert.ok(result !== null);
  assert.ok('k' in result && 'd' in result);
});

test('calcStochRSI k and d are in [0, 100]', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.5) * 10);
  const result = ind.calcStochRSI(closes);
  assert.ok(result.k >= 0 && result.k <= 100, `k=${result.k} out of range`);
  assert.ok(result.d >= 0 && result.d <= 100, `d=${result.d} out of range`);
});
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
cd /home/gallus23/crypto-dashboard && node --test test/indicators.test.js 2>&1 | tail -10
```

Expected: `Cannot find module '../indicators'`

- [ ] **Step 3: Create `indicators.js`**

```js
// indicators.js
'use strict';

// Standard EMA seeded from SMA of first `period` values.
// Returns null if insufficient data.
function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// MACD 12/26/9. Returns null if fewer than 35 closes.
// Walks the full closes array once to build EMA12 and EMA26 series,
// then computes EMA9 of the MACD line.
function calcMACD(closes) {
  if (closes.length < 35) return null;
  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
  let ema12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let ema26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  const macdSeries = [];
  for (let i = 12; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    if (i >= 25) {
      ema26 = closes[i] * k26 + ema26 * (1 - k26);
      macdSeries.push(ema12 - ema26);
    }
  }
  if (macdSeries.length < 9) return null;
  let signal = macdSeries.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdSeries.length; i++) {
    signal = macdSeries[i] * k9 + signal * (1 - k9);
  }
  const macd = macdSeries[macdSeries.length - 1];
  return { macd, signal, histogram: macd - signal };
}

// Bollinger Bands 20-period, 2 std dev (population).
// Returns null if fewer than 20 closes.
function calcBollingerBands(closes) {
  if (closes.length < 20) return null;
  const last20 = closes.slice(-20);
  const middle = last20.reduce((a, b) => a + b, 0) / 20;
  const variance = last20.reduce((a, v) => a + (v - middle) ** 2, 0) / 20;
  const std = Math.sqrt(variance);
  const upper = middle + 2 * std;
  const lower = middle - 2 * std;
  return { upper, middle, lower, bandwidthPct: (upper - lower) / middle * 100 };
}

// Internal: Wilder RSI-14 from a closes array (needs ≥15 values).
// Uses the full array to build up smoothed averages.
function _calcRSI14(closes) {
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < 14; i++) {
    if (changes[i] > 0) avgGain += changes[i]; else avgLoss -= changes[i];
  }
  avgGain /= 14; avgLoss /= 14;
  for (let i = 14; i < changes.length; i++) {
    avgGain = (avgGain * 13 + Math.max(0, changes[i])) / 14;
    avgLoss = (avgLoss * 13 + Math.max(0, -changes[i])) / 14;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Stochastic RSI 14/14/3/3.
// Builds full RSI series from closes, then applies 14-period stochastic,
// then SMA-3 for %K and SMA-3 for %D.
// Returns null if fewer than 28 closes.
function calcStochRSI(closes) {
  if (closes.length < 28) return null;
  // Build RSI at each step from index 14 onward (each needs ≥15 closes)
  const rsiSeries = [];
  for (let end = 15; end <= closes.length; end++) {
    rsiSeries.push(_calcRSI14(closes.slice(0, end)));
  }
  if (rsiSeries.length < 14) return null;
  // Raw StochRSI: 14-period sliding window over RSI series
  const rawSeries = [];
  for (let i = 13; i < rsiSeries.length; i++) {
    const w = rsiSeries.slice(i - 13, i + 1);
    const minR = Math.min(...w), maxR = Math.max(...w);
    rawSeries.push(maxR === minR ? 50 : (rsiSeries[i] - minR) / (maxR - minR) * 100);
  }
  // %K = SMA-3 of rawSeries
  const kSeries = [];
  for (let i = 2; i < rawSeries.length; i++) {
    kSeries.push((rawSeries[i - 2] + rawSeries[i - 1] + rawSeries[i]) / 3);
  }
  if (kSeries.length === 0) {
    const k = rawSeries[rawSeries.length - 1];
    return { k, d: k };
  }
  const k = kSeries[kSeries.length - 1];
  // %D = SMA-3 of kSeries
  const d = kSeries.length >= 3
    ? (kSeries.slice(-3).reduce((a, b) => a + b, 0) / 3)
    : k;
  return { k, d };
}

// Volume ratio: last volume vs 20-period average.
// volumes: array of ≥21 values oldest-first (index 0 = oldest, index 20 = current).
// Returns null if insufficient or zero average.
function calcVolumeRatio(volumes) {
  if (volumes.length < 21) return null;
  const avg20 = volumes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  return avg20 === 0 ? null : volumes[20] / avg20;
}

module.exports = { calcEMA, calcMACD, calcBollingerBands, calcStochRSI, calcVolumeRatio };
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
cd /home/gallus23/crypto-dashboard && node --test test/indicators.test.js 2>&1 | tail -20
```

Expected: all tests pass (0 failures).

- [ ] **Step 5: Run full test suite to check nothing broke**

```bash
cd /home/gallus23/crypto-dashboard && node --test 2>&1 | tail -10
```

Expected: all existing tests + new indicators tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/gallus23/crypto-dashboard
git add indicators.js test/indicators.test.js
git commit -m "feat: add indicators.js — MACD, Bollinger Bands, EMA, StochRSI, VolumeRatio"
```

---

## Task 3: `feargreed.js` — Alternative.me API

**Files:**
- Create: `feargreed.js`
- Create: `test/feargreed.test.js`

- [ ] **Step 1: Write `test/feargreed.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('fetchFearGreed returns parsed value and classification', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ value: '42', value_classification: 'Fear' }] }),
  });
  try {
    // require after mock is set (module has no top-level fetch call)
    const { fetchFearGreed } = require('../feargreed');
    const result = await fetchFearGreed();
    assert.equal(result.value, 42);
    assert.equal(result.classification, 'Fear');
  } finally {
    global.fetch = saved;
  }
});

test('fetchFearGreed throws on non-ok response', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429 });
  try {
    const { fetchFearGreed } = require('../feargreed');
    await assert.rejects(() => fetchFearGreed(), /429/);
  } finally {
    global.fetch = saved;
  }
});

test('fetchFearGreed value is an integer', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ value: '75', value_classification: 'Extreme Greed' }] }),
  });
  try {
    const { fetchFearGreed } = require('../feargreed');
    const result = await fetchFearGreed();
    assert.strictEqual(typeof result.value, 'number');
    assert.equal(result.value, 75);
    assert.equal(result.classification, 'Extreme Greed');
  } finally {
    global.fetch = saved;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/gallus23/crypto-dashboard && node --test test/feargreed.test.js 2>&1 | tail -10
```

Expected: `Cannot find module '../feargreed'`

- [ ] **Step 3: Create `feargreed.js`**

```js
// feargreed.js
'use strict';

const FNG_URL = 'https://api.alternative.me/fng/?limit=1';

// Fetch current Fear & Greed index from Alternative.me.
// Returns { value: number, classification: string }.
// Throws on network error or non-ok HTTP status.
async function fetchFearGreed() {
  const res = await fetch(FNG_URL);
  if (!res.ok) throw new Error(`Fear & Greed API ${res.status}`);
  const body = await res.json();
  const d = body.data[0];
  return { value: parseInt(d.value, 10), classification: d.value_classification };
}

module.exports = { fetchFearGreed };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/gallus23/crypto-dashboard && node --test test/feargreed.test.js 2>&1 | tail -10
```

Expected: all 3 tests pass.

- [ ] **Step 5: Run full test suite**

```bash
cd /home/gallus23/crypto-dashboard && node --test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/gallus23/crypto-dashboard
git add feargreed.js test/feargreed.test.js
git commit -m "feat: add feargreed.js — Alternative.me Fear & Greed fetch"
```

---

## Task 4: `server.js` — `updateIndicators`, `updateFearGreed`, crons, routes

**Files:**
- Modify: `server.js`

This task wires up the two new modules into the server. It does not change `updateSignals` — that's Task 5.

- [ ] **Step 1: Add requires and file constants near top of `server.js`**

After the existing `require` lines (after `const coingecko = require('./coingecko');`), add:

```js
const ind       = require('./indicators');
const feargreed = require('./feargreed');
```

After the existing `const SIGNALS_FILE` line, add:

```js
const INDICATORS_FILE = path.join(DATA_DIR, 'indicators.json');
const FEARGREED_FILE  = path.join(DATA_DIR, 'feargreed.json');
```

- [ ] **Step 2: Add `updateIndicators()` function**

Add after the `updateRSI()` function (around line 140) and before `updateSignals()`:

```js
async function updateIndicators() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;
  const cache = {};
  for (const id of wl.coins) {
    const closes  = db.getCloses(id, '1h', 300);
    const volumes = db.getVolumes(id, '1h', 21);
    if (closes.length < 35) continue;
    const price       = closes[closes.length - 1];
    const macd        = ind.calcMACD(closes);
    const bb          = ind.calcBollingerBands(closes);
    const stochRsi    = ind.calcStochRSI(closes);
    const volumeRatio = ind.calcVolumeRatio(volumes);
    const ema50       = ind.calcEMA(closes, 50);
    const ema200      = ind.calcEMA(closes, 200);
    const emaAbovePrice = ema200 != null && price > ema200;
    // Detect golden/death cross in last 3 candles
    let goldenCross = false, deathCross = false;
    const n = closes.length;
    if (n >= 201) {
      const emas = [];
      for (let len = n - 3; len <= n; len++) {
        emas.push({
          e50:  ind.calcEMA(closes.slice(0, len), 50),
          e200: ind.calcEMA(closes.slice(0, len), 200),
        });
      }
      for (let i = 0; i < 3; i++) {
        const prev = emas[i], curr = emas[i + 1];
        if (prev.e50 != null && prev.e200 != null && curr.e50 != null && curr.e200 != null) {
          if (prev.e50 <= prev.e200 && curr.e50 > curr.e200) goldenCross = true;
          if (prev.e50 >= prev.e200 && curr.e50 < curr.e200) deathCross  = true;
        }
      }
    }
    cache[id] = {
      macd, bb, ema50, ema200, emaAbovePrice, goldenCross, deathCross,
      stochRsi, volumeRatio, updatedAt: new Date().toISOString(),
    };
  }
  writeJson(INDICATORS_FILE, cache);
  console.log('[indicators] updated:', Object.keys(cache).join(', '));
}
```

- [ ] **Step 3: Add `updateFearGreed()` function**

Add immediately after `updateIndicators()`:

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

- [ ] **Step 4: Update the 15-min cron to include `updateIndicators`**

Find this block in server.js:

```js
// every 15 minutes: fetch new candles → recalc RSI → update signals
cron.schedule('*/15 * * * *', () => {
  updateCandles()
    .then(() => updateRSI())
    .then(() => updateSignals())
    .catch(e => console.error('[cron 15min] unexpected error:', e.message));
});
```

Replace with:

```js
// every 15 minutes: fetch new candles → recalc RSI → recalc indicators → update signals
cron.schedule('*/15 * * * *', () => {
  updateCandles()
    .then(() => updateRSI())
    .then(() => updateIndicators())
    .then(() => updateSignals())
    .catch(e => console.error('[cron 15min] unexpected error:', e.message));
});
```

- [ ] **Step 5: Add hourly Fear & Greed cron**

Add after the 15-min cron block:

```js
// every hour: refresh Fear & Greed index
cron.schedule('0 * * * *', () => {
  updateFearGreed().catch(e => console.error('[cron feargreed]', e.message));
});
```

- [ ] **Step 6: Update startup chain to include indicators + Fear & Greed**

Find this in server.js:

```js
setTimeout(() => updateCandles().then(() => updateRSI()).then(() => updateSignals()).catch(() => {}), 4000);
```

Replace with:

```js
setTimeout(() => updateCandles().then(() => updateRSI()).then(() => updateIndicators()).then(() => updateSignals()).catch(() => {}), 4000);
setTimeout(() => updateFearGreed().catch(() => {}), 6000);
```

- [ ] **Step 7: Add `/api/indicators` and `/api/feargreed` routes**

After the existing `/api/signals` route (around line 337), add:

```js
// ── indicators route ───────────────────────────────────────────────────────────

app.get('/api/indicators', (req, res) => {
  res.json(readJson(INDICATORS_FILE, {}));
});

// ── Fear & Greed route ─────────────────────────────────────────────────────────

app.get('/api/feargreed', (req, res) => {
  res.json(readJson(FEARGREED_FILE, {}));
});
```

- [ ] **Step 8: Verify server starts cleanly**

```bash
cd /home/gallus23/crypto-dashboard && node -e "
const db = require('./db'); db.initDb();
const ind = require('./indicators');
const fg = require('./feargreed');
console.log('requires OK');
console.log('calcEMA test:', ind.calcEMA(Array(15).fill(100), 12));
"
```

Expected output:
```
requires OK
calcEMA test: 100
```

- [ ] **Step 9: Commit**

```bash
cd /home/gallus23/crypto-dashboard
git add server.js
git commit -m "feat: add updateIndicators, updateFearGreed, crons, and API routes to server.js"
```

---

## Task 5: `server.js` — update `updateSignals` for 5-level classification + richer prompt

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Update `updateSignals` to read indicators + Fear & Greed and build richer prompt**

Find the entire `updateSignals` function. Replace the prompt construction and signal validation with the following. The full updated function:

```js
async function updateSignals() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;

  const rsiCache    = readJson(RSI_FILE, {});
  const indCache    = readJson(INDICATORS_FILE, {});
  const fng         = readJson(FEARGREED_FILE, {});
  const signalCache = readJson(SIGNALS_FILE, {});
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('[signals] ANTHROPIC_API_KEY not set'); return; }

  const fngStr = fng.value != null
    ? `${fng.value}/100 (${fng.classification})`
    : 'unavailable';

  for (const id of wl.coins) {
    const meta = db.getMeta(id);
    if (!meta || !meta.symbol) continue;
    let ticker;
    try {
      ticker = await binance.fetchTicker(meta.symbol);
    } catch (e) {
      console.error(`[signals] ticker failed for ${id}:`, e.message);
      continue;
    }
    const rsiEntry = rsiCache[id];
    const rsi      = rsiEntry ? rsiEntry.rsi : null;
    const price    = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    const i = indCache[id] || {};
    try {
      const lines = [
        `Coin: ${meta.name}`,
        `Price: $${price}`,
        `24h change: ${change24h.toFixed(2)}%`,
        `RSI (14): ${rsi != null ? rsi.toFixed(1) : 'unavailable'}`,
      ];
      if (i.macd) {
        lines.push(`MACD: ${i.macd.macd.toFixed(2)} | Signal: ${i.macd.signal.toFixed(2)} | Histogram: ${i.macd.histogram.toFixed(2)}`);
      }
      if (i.bb) {
        lines.push(`Bollinger: Upper $${i.bb.upper.toFixed(2)} Middle $${i.bb.middle.toFixed(2)} Lower $${i.bb.lower.toFixed(2)} BW: ${i.bb.bandwidthPct.toFixed(1)}%`);
      }
      if (i.ema50 != null) lines.push(`EMA50: $${i.ema50.toFixed(2)}`);
      if (i.ema200 != null) lines.push(`EMA200: $${i.ema200.toFixed(2)} | Price ${i.emaAbovePrice ? 'above' : 'below'} 200 EMA`);
      if (i.goldenCross) lines.push('Golden cross detected in last 3 candles.');
      if (i.deathCross)  lines.push('Death cross detected in last 3 candles.');
      if (i.stochRsi)    lines.push(`Stoch RSI: %K=${i.stochRsi.k.toFixed(1)} %D=${i.stochRsi.d.toFixed(1)}`);
      if (i.volumeRatio != null) lines.push(`Volume ratio vs 20-period avg: ${i.volumeRatio.toFixed(2)}x`);
      lines.push(`Fear & Greed: ${fngStr}`);
      lines.push('');
      lines.push('Respond with valid JSON only, no markdown, no prose:');
      lines.push('{"signal":"buy","summary":"..."} where signal is exactly one of: strong_buy, buy, hold, sell, strong_sell');
      lines.push('Summary: 1-2 plain English sentences referencing specific indicator values.');

      const prompt = lines.join('\n');

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      const body   = await res.json();
      const raw    = body.content[0].text.trim();
      const text   = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(text);
      if (!['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'].includes(parsed.signal))
        throw new Error(`invalid signal: ${parsed.signal}`);
      if (typeof parsed.summary !== 'string') throw new Error('missing summary');
      signalCache[id] = { signal: parsed.signal, summary: parsed.summary, updatedAt: new Date().toISOString() };
    } catch (e) {
      console.error(`[signals] ${id}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  for (const id of Object.keys(signalCache)) {
    if (!wl.coins.includes(id)) delete signalCache[id];
  }
  writeJson(SIGNALS_FILE, signalCache);
  console.log('[signals] updated:', Object.keys(signalCache).map(k => `${k}=${signalCache[k].signal}`).join(', '));
}
```

- [ ] **Step 2: Verify server syntax is valid**

```bash
cd /home/gallus23/crypto-dashboard && node --check server.js && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 3: Commit**

```bash
cd /home/gallus23/crypto-dashboard
git add server.js
git commit -m "feat: update updateSignals for 5-level classification and rich indicator prompt"
```

---

## Task 6: Frontend — Fear & Greed badge + 5-level signal rendering

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add CSS for Fear & Greed badge and 5-level signal badges**

Find this CSS block in `public/index.html` (around line 121–125):

```css
.signal-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-family: var(--mono); cursor: default; white-space: nowrap; }
.signal-buy  { background: rgba(74,222,128,0.12); color: #4ade80; border: 1px solid rgba(74,222,128,0.30); }
.signal-sell { background: rgba(248,113,113,0.12); color: #f87171; border: 1px solid rgba(248,113,113,0.30); }
.signal-hold { background: rgba(251,191,36,0.10); color: #fbbf24; border: 1px solid rgba(251,191,36,0.25); }
.signal-pending { background: var(--bg3); color: var(--muted); border: 1px solid var(--border); }
```

Replace with:

```css
.signal-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-family: var(--mono); cursor: default; white-space: nowrap; }
.signal-strong_buy  { background: rgba(74,222,128,0.20); color: #4ade80; border: 1px solid rgba(74,222,128,0.45); font-weight: 600; }
.signal-buy         { background: rgba(74,222,128,0.10); color: #4ade80; border: 1px solid rgba(74,222,128,0.25); }
.signal-hold        { background: rgba(251,191,36,0.10); color: #fbbf24; border: 1px solid rgba(251,191,36,0.25); }
.signal-sell        { background: rgba(248,113,113,0.10); color: #f87171; border: 1px solid rgba(248,113,113,0.25); }
.signal-strong_sell { background: rgba(248,113,113,0.20); color: #f87171; border: 1px solid rgba(248,113,113,0.45); font-weight: 600; }
.signal-pending     { background: var(--bg3); color: var(--muted); border: 1px solid var(--border); }
.fng-bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--mono); font-size: 12px; color: var(--muted); }
.fng-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.fng-value { font-size: 14px; font-weight: 500; }
```

- [ ] **Step 2: Add Fear & Greed bar HTML**

Find this in `public/index.html` (around line 141):

```html
      <div class="summary-grid" id="summary-grid">
```

Add the `fng-bar` div immediately before the `summary-grid` div:

```html
      <div class="fng-bar" id="fng-bar">
        <span class="fng-label">Fear &amp; Greed</span>
        <span class="fng-value" id="fng-value">—</span>
        <span id="fng-class" style="color:var(--muted)"></span>
      </div>

      <div class="summary-grid" id="summary-grid">
```

- [ ] **Step 3: Add `loadFearGreed()` JavaScript function**

Find in `public/index.html` the line `let marketData = [];` (around line 210). Add a new variable below `let signalData = {};`:

```js
let fearGreedData = {};
```

Then find the `// ── status pill` comment (around line 246). Add a new function before it:

```js
// ── Fear & Greed ──────────────────────────────────────────────────────────────
async function loadFearGreed() {
  try {
    const r = await fetch('/api/feargreed');
    fearGreedData = r.ok ? await r.json() : {};
    const el = document.getElementById('fng-value');
    const cls = document.getElementById('fng-class');
    if (fearGreedData.value == null) {
      el.textContent = '—';
      el.style.color = 'var(--muted)';
      cls.textContent = '';
      return;
    }
    const v = fearGreedData.value;
    const color = v < 25 ? 'var(--red)'
      : v < 50 ? 'var(--amber)'
      : v < 75 ? 'var(--accent)'
      : '#a78bfa';
    el.textContent = v;
    el.style.color = color;
    cls.textContent = '— ' + fearGreedData.classification;
    cls.style.color = color;
  } catch (e) {
    // silently leave existing display
  }
}

```

- [ ] **Step 4: Update signal rendering in `renderTable()` for 5 levels**

Find in `public/index.html` (around lines 325–329):

```js
    const sigEntry = signalData[row.id];
    const validSignal = sigEntry && ['buy', 'sell', 'hold'].includes(sigEntry.signal) ? sigEntry.signal : null;
    const sigHtml = validSignal
      ? `<span class="signal-badge signal-${validSignal}" title="${sigEntry.summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}">${validSignal.toUpperCase()}</span>`
      : `<span class="signal-badge signal-pending">Pending</span>`;
```

Replace with:

```js
    const sigEntry = signalData[row.id];
    const VALID_SIGNALS = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'];
    const SIGNAL_LABELS = { strong_buy: 'STRONG BUY', buy: 'BUY', hold: 'HOLD', sell: 'SELL', strong_sell: 'STRONG SELL' };
    const validSignal = sigEntry && VALID_SIGNALS.includes(sigEntry.signal) ? sigEntry.signal : null;
    const sigHtml = validSignal
      ? `<span class="signal-badge signal-${validSignal}" title="${(sigEntry.summary||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}">${SIGNAL_LABELS[validSignal]}</span>`
      : `<span class="signal-badge signal-pending">Pending</span>`;
```

- [ ] **Step 5: Wire up `loadFearGreed` in the init section**

Find at the bottom of `<script>` in `public/index.html`:

```js
loadMarket();
loadAlerts();
setInterval(loadMarket, 60000);
setInterval(loadAlerts, 30000);
```

Replace with:

```js
loadMarket();
loadAlerts();
loadFearGreed();
setInterval(loadMarket, 60000);
setInterval(loadAlerts, 30000);
setInterval(loadFearGreed, 300000);
```

- [ ] **Step 6: Run full test suite to confirm nothing broke**

```bash
cd /home/gallus23/crypto-dashboard && node --test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /home/gallus23/crypto-dashboard
git add public/index.html
git commit -m "feat: add Fear & Greed badge and 5-level signal rendering to dashboard"
```

---

## Task 7: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Stack section**

Find in `CLAUDE.md`:

```
- Anthropic API (`ANTHROPIC_API_KEY`) — buy/sell/hold signals via claude-haiku
```

Replace with:

```
- Anthropic API (`ANTHROPIC_API_KEY`) — strong_buy/buy/hold/sell/strong_sell signals via claude-haiku
- Alternative.me API (no key) — Crypto Fear & Greed Index, fetched hourly
```

- [ ] **Step 2: Update the Project structure section**

Find:

```
- test/ — Node.js built-in test suite (node:test): test/db.test.js, test/binance.test.js
```

Replace with:

```
- test/ — Node.js built-in test suite (node:test): test/db.test.js, test/binance.test.js, test/indicators.test.js, test/feargreed.test.js
```

Find:

```
- binance.js — Binance API: fetchTicker, backfillCandles (90d 1h / 7d 1m), fetchNewCandles
```

After that line, add:

```
- indicators.js — Pure technical indicator functions: calcEMA, calcMACD, calcBollingerBands, calcStochRSI, calcVolumeRatio
- feargreed.js — Alternative.me Fear & Greed API: fetchFearGreed
```

Find:

```
- data/signals.json — Anthropic signal cache
```

After that line, add:

```
- data/indicators.json — Technical indicators cache (MACD, BB, EMA, StochRSI, VolumeRatio) per coin
- data/feargreed.json — Fear & Greed Index cache (refreshed hourly)
```

- [ ] **Step 3: Update the Data flow section**

Find:

```
- Every 15 min: fetch new 1h candles → recalculate RSI → update signals
```

Replace with:

```
- Every 15 min: fetch new 1h candles → recalculate RSI → recalculate indicators → update signals
- Every 1h: refresh Fear & Greed Index from Alternative.me
```

- [ ] **Step 4: Commit**

```bash
cd /home/gallus23/crypto-dashboard
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for indicators, feargreed, 5-level signals"
```

---

## Task 8: Restart service and verify

**Files:** none (operational)

- [ ] **Step 1: Restart the service**

```bash
sudo systemctl restart crypto-dashboard
```

- [ ] **Step 2: Check logs for startup errors**

```bash
journalctl -u crypto-dashboard -n 50 --no-pager
```

Expected: no `Error` lines. Should see:
- `[RSI] updated: ...`
- `[indicators] updated: ...`
- `[signals] updated: ...` with 5-level signal values
- `[feargreed] <value> (<classification>)`

- [ ] **Step 3: Verify new API endpoints**

```bash
curl -s http://localhost:3000/api/indicators | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); const k=Object.keys(j)[0]; if(k) console.log(k, JSON.stringify(j[k],null,2).slice(0,300)); else console.log('empty');"
```

Expected: JSON with macd, bb, ema50, ema200, stochRsi, volumeRatio fields for at least one coin.

```bash
curl -s http://localhost:3000/api/feargreed
```

Expected: `{"value":XX,"classification":"...","fetchedAt":...}`

- [ ] **Step 4: Verify signals have 5-level values**

```bash
curl -s http://localhost:3000/api/signals | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); Object.entries(j).forEach(([k,v])=>console.log(k, v.signal));"
```

Expected: signal values from `['strong_buy', 'buy', 'hold', 'sell', 'strong_sell']`.
