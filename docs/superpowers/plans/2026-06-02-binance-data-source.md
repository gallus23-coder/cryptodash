# Binance Data Source Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CoinGecko live data with Binance public API, store 1h OHLCV candles in SQLite, and keep CoinGecko only for static coin metadata fetched once per coin.

**Architecture:** Three new modules (`db.js`, `binance.js`, `coingecko.js`) handle their single responsibility; `server.js` is rewritten as a thin orchestrator — routes + crons only. SQLite (`data/crypto.db`) holds candles and coin metadata. All indicators (RSI, sparkline, 1h change) computed from local candles. CoinGecko called once per coin for name/image/market_cap and then only for 24h market cap refresh.

**Tech Stack:** Node.js, Express, `better-sqlite3`, Binance public API (no key), CoinGecko free API (no key), Anthropic API (signals, unchanged).

---

### Task 1: Install better-sqlite3 and create db.js

**Files:**
- Modify: `package.json` (via npm install)
- Create: `db.js`

- [ ] **Step 1: Install better-sqlite3**

```bash
cd /home/gallus23/crypto-dashboard
npm install better-sqlite3
```

Expected: `added 1 package` (or similar), no errors.

- [ ] **Step 2: Create db.js**

```js
// db.js
'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'crypto.db');
let _db;

const _stmts = new Map();
function prepare(sql) {
  if (!_stmts.has(sql)) _stmts.set(sql, _db.prepare(sql));
  return _stmts.get(sql);
}

function initDb() {
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS coin_meta (
      id                    TEXT PRIMARY KEY,
      symbol                TEXT NOT NULL,
      name                  TEXT NOT NULL,
      image                 TEXT NOT NULL,
      market_cap            REAL,
      meta_fetched_at       INTEGER NOT NULL,
      market_cap_updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candles (
      symbol    TEXT    NOT NULL,
      open_time INTEGER NOT NULL,
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      PRIMARY KEY (symbol, open_time)
    );
    CREATE INDEX IF NOT EXISTS idx_candles_sym_time ON candles(symbol, open_time DESC);
  `);
}

function upsertMeta(row) {
  prepare(`
    INSERT OR REPLACE INTO coin_meta
      (id, symbol, name, image, market_cap, meta_fetched_at, market_cap_updated_at)
    VALUES
      (@id, @symbol, @name, @image, @market_cap, @meta_fetched_at, @market_cap_updated_at)
  `).run(row);
}

function getMeta(id) {
  return prepare('SELECT * FROM coin_meta WHERE id = ?').get(id);
}

function getAllMeta() {
  return prepare('SELECT * FROM coin_meta').all();
}

function updateMarketCap(id, market_cap) {
  prepare('UPDATE coin_meta SET market_cap = ?, market_cap_updated_at = ? WHERE id = ?')
    .run(market_cap, Date.now(), id);
}

function insertCandles(rows) {
  const ins = prepare(`
    INSERT OR REPLACE INTO candles (symbol, open_time, open, high, low, close, volume)
    VALUES (@symbol, @open_time, @open, @high, @low, @close, @volume)
  `);
  _db.transaction(rs => { for (const r of rs) ins.run(r); })(rows);
}

function getLastCandleTime(symbol) {
  const row = prepare('SELECT MAX(open_time) AS t FROM candles WHERE symbol = ?').get(symbol);
  return row ? row.t : null;
}

// Returns closes oldest-first (required for RSI calculation).
function getCloses(symbol, limit) {
  const rows = prepare(
    'SELECT close FROM candles WHERE symbol = ? ORDER BY open_time DESC LIMIT ?'
  ).all(symbol, limit);
  return rows.map(r => r.close).reverse();
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

module.exports = {
  initDb, upsertMeta, getMeta, getAllMeta, updateMarketCap,
  insertCandles, getLastCandleTime, getCloses, calculateRSI,
};
```

- [ ] **Step 3: Smoke-test db.js**

```bash
node -e "
const db = require('./db');
db.initDb();
db.upsertMeta({ id: 'bitcoin', symbol: 'BTCUSDT', name: 'Bitcoin',
  image: 'https://example.com/btc.png', market_cap: 1e12,
  meta_fetched_at: Date.now(), market_cap_updated_at: Date.now() });
const m = db.getMeta('bitcoin');
console.assert(m.name === 'Bitcoin', 'getMeta failed');
db.insertCandles([
  { symbol: 'BTCUSDT', open_time: 1000, open: 50000, high: 51000, low: 49000, close: 50500, volume: 1e6 },
  { symbol: 'BTCUSDT', open_time: 2000, open: 50500, high: 52000, low: 50000, close: 51000, volume: 1e6 },
]);
const closes = db.getCloses('BTCUSDT', 10);
console.assert(closes.length === 2, 'getCloses count wrong: ' + closes.length);
console.assert(closes[0] === 50500, 'closes order wrong (should be oldest first)');
console.assert(db.getLastCandleTime('BTCUSDT') === 2000, 'getLastCandleTime wrong');
db.updateMarketCap('bitcoin', 1.1e12);
console.assert(db.getMeta('bitcoin').market_cap === 1.1e12, 'updateMarketCap failed');
const allMeta = db.getAllMeta();
console.assert(allMeta.length >= 1, 'getAllMeta empty');
console.log('db.js OK');
"
```

Expected: `db.js OK`

- [ ] **Step 4: Commit**

```bash
git add db.js package.json package-lock.json
git commit -m "feat: add SQLite db module with candles and coin_meta schema"
```

---

### Task 2: Create coingecko.js

**Files:**
- Create: `coingecko.js`

- [ ] **Step 1: Create coingecko.js**

```js
// coingecko.js
'use strict';

// Fetch name, image, market_cap for a single coin. Called once per new coin.
// Returns { cgSymbol, name, image, market_cap }
// cgSymbol is e.g. "BTC" — used as Binance symbol fallback when coin not in SYMBOL_MAP.
async function fetchMetadata(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}` +
    `?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko metadata ${res.status} for ${id}`);
  const data = await res.json();
  return {
    cgSymbol: data.symbol.toUpperCase(), // e.g. "BTC"
    name: data.name,
    image: data.image.large,
    market_cap: data.market_data.market_cap.usd ?? null,
  };
}

// Batch-fetch market caps for multiple coins. Called every 24h.
// Returns { [coingeckoId]: market_cap_usd }
async function refreshMarketCaps(ids) {
  if (!ids.length) return {};
  const url = `https://api.coingecko.com/api/v3/coins/markets` +
    `?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&per_page=250&page=1&sparkline=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko markets ${res.status}`);
  const data = await res.json();
  return Object.fromEntries(data.map(d => [d.id, d.market_cap]));
}

module.exports = { fetchMetadata, refreshMarketCaps };
```

- [ ] **Step 2: Smoke-test coingecko.js**

```bash
node -e "
const cg = require('./coingecko');
cg.fetchMetadata('bitcoin').then(d => {
  console.assert(d.name === 'Bitcoin', 'name wrong: ' + d.name);
  console.assert(typeof d.market_cap === 'number', 'market_cap not a number');
  console.assert(d.cgSymbol === 'BTC', 'cgSymbol wrong: ' + d.cgSymbol);
  console.log('coingecko.js fetchMetadata OK:', d.name, '\$' + (d.market_cap/1e9).toFixed(0) + 'B market cap');
}).catch(console.error);
"
```

Expected: `coingecko.js fetchMetadata OK: Bitcoin $<N>B market cap`

- [ ] **Step 3: Commit**

```bash
git add coingecko.js
git commit -m "feat: add coingecko module for metadata and market cap refresh"
```

---

### Task 3: Create binance.js

**Files:**
- Create: `binance.js`

- [ ] **Step 1: Create binance.js**

```js
// binance.js
'use strict';

const BASE = 'https://api.binance.com';

// Hardcoded map for known coins. Covers all coins in the default watchlist.
// New coins not in this map fall back to cgSymbol + 'USDT' from CoinGecko metadata.
const SYMBOL_MAP = {
  bitcoin:       'BTCUSDT',
  ethereum:      'ETHUSDT',
  binancecoin:   'BNBUSDT',
  ripple:        'XRPUSDT',
  cardano:       'ADAUSDT',
  solana:        'SOLUSDT',
  'avalanche-2': 'AVAXUSDT',
  chainlink:     'LINKUSDT',
};

// Fetch 24h ticker for one Binance symbol.
// Relevant fields: lastPrice (string), priceChangePercent (string), quoteVolume (string, USDT).
async function fetchTicker(symbol) {
  const res = await fetch(`${BASE}/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status} for ${symbol}`);
  return res.json();
}

// Fetch up to `limit` 1h candles starting from `startTime` (unix ms).
async function _fetchKlines(symbol, startTime, limit = 1000) {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=1h` +
    `&startTime=${startTime}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status} for ${symbol}`);
  return res.json();
}

// Convert a Binance kline array to a candles-table row.
// k[0]=openTime k[1]=open k[2]=high k[3]=low k[4]=close k[7]=quoteAssetVolume(USDT)
function _klineToRow(symbol, k) {
  return {
    symbol,
    open_time: k[0],
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[7]),
  };
}

// Backfill 90 days of 1h candles. 3 requests per coin (2160 candles / 1000 per page).
// db is the db.js module exports object.
async function backfillCandles(symbol, db) {
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  let startTime = Date.now() - NINETY_DAYS_MS;
  let total = 0;
  while (true) {
    const klines = await _fetchKlines(symbol, startTime);
    if (!klines.length) break;
    db.insertCandles(klines.map(k => _klineToRow(symbol, k)));
    total += klines.length;
    if (klines.length < 1000) break;
    startTime = klines[klines.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 200)); // be polite to Binance
  }
  console.log(`[binance] backfilled ${total} candles for ${symbol}`);
}

// Fetch candles since the last stored open_time. Falls back to backfillCandles if no history.
// db is the db.js module exports object.
async function fetchNewCandles(symbol, db) {
  const lastTime = db.getLastCandleTime(symbol);
  if (!lastTime) return backfillCandles(symbol, db);
  const klines = await _fetchKlines(symbol, lastTime + 1);
  if (!klines.length) return;
  db.insertCandles(klines.map(k => _klineToRow(symbol, k)));
  console.log(`[binance] fetched ${klines.length} new candles for ${symbol}`);
}

module.exports = { SYMBOL_MAP, fetchTicker, backfillCandles, fetchNewCandles };
```

- [ ] **Step 2: Smoke-test binance.js**

```bash
node -e "
const b = require('./binance');
b.fetchTicker('BTCUSDT').then(t => {
  console.assert(parseFloat(t.lastPrice) > 0, 'lastPrice not positive');
  console.assert(typeof t.priceChangePercent === 'string', 'priceChangePercent missing');
  console.assert(typeof t.quoteVolume === 'string', 'quoteVolume missing');
  console.log('binance.js fetchTicker OK: BTC =', t.lastPrice);
}).catch(console.error);
"
```

Expected: `binance.js fetchTicker OK: BTC = <price>`

- [ ] **Step 3: Commit**

```bash
git add binance.js
git commit -m "feat: add Binance module for ticker, candle backfill and incremental fetch"
```

---

### Task 4: Rewrite server.js

This task replaces `server.js` in full. The old file is deleted and replaced with the complete final version. This avoids any intermediate broken state from piecemeal edits.

**Files:**
- Overwrite: `server.js`

- [ ] **Step 1: Write the complete new server.js**

```js
// server.js
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const notifier = require('node-notifier');
const db = require('./db');
const binance = require('./binance');
const coingecko = require('./coingecko');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const ALERTS_FILE    = path.join(DATA_DIR, 'alerts.json');
const TRIGGERED_FILE = path.join(DATA_DIR, 'triggered.json');
const RSI_FILE       = path.join(DATA_DIR, 'rsi.json');
const SIGNALS_FILE   = path.join(DATA_DIR, 'signals.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── helpers ───────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── seed helpers ──────────────────────────────────────────────────────────────

// Fetch CoinGecko metadata + Binance candle history for one coin.
// Idempotent: skips steps already completed. Safe to re-run.
async function seedCoin(id) {
  let meta = db.getMeta(id);
  if (!meta) {
    let cgData;
    try {
      cgData = await coingecko.fetchMetadata(id);
    } catch (e) {
      console.error(`[seed] metadata failed for ${id}:`, e.message);
      return;
    }
    const symbol = binance.SYMBOL_MAP[id] || (cgData.cgSymbol + 'USDT');
    db.upsertMeta({
      id, symbol,
      name: cgData.name,
      image: cgData.image,
      market_cap: cgData.market_cap,
      meta_fetched_at: Date.now(),
      market_cap_updated_at: Date.now(),
    });
    meta = db.getMeta(id);
    console.log(`[seed] metadata stored for ${id} (${symbol})`);
    await new Promise(r => setTimeout(r, 1200)); // CoinGecko free-tier rate limit
  } else if (Date.now() - meta.market_cap_updated_at > 24 * 60 * 60 * 1000) {
    try {
      const caps = await coingecko.refreshMarketCaps([id]);
      if (caps[id] != null) db.updateMarketCap(id, caps[id]);
    } catch (e) {
      console.error(`[seed] market cap refresh failed for ${id}:`, e.message);
    }
  }

  if (!meta || !meta.symbol) return;
  if (!db.getLastCandleTime(meta.symbol)) {
    try {
      await binance.backfillCandles(meta.symbol, db);
    } catch (e) {
      console.error(`[seed] backfill failed for ${meta.symbol}:`, e.message);
    }
  }
}

async function seedAndBackfill() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  for (const id of wl.coins) await seedCoin(id);
}

// ── background jobs ───────────────────────────────────────────────────────────

async function updateCandles() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  const metaById = Object.fromEntries(db.getAllMeta().map(m => [m.id, m]));
  for (const id of wl.coins) {
    const meta = metaById[id];
    if (!meta || !meta.symbol) continue;
    try {
      await binance.fetchNewCandles(meta.symbol, db);
    } catch (e) {
      console.error(`[candles] update failed for ${meta.symbol}:`, e.message);
    }
  }
}

async function updateRSI() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;
  const metaById = Object.fromEntries(db.getAllMeta().map(m => [m.id, m]));
  const rsiCache = readJson(RSI_FILE, {});
  for (const id of wl.coins) {
    const meta = metaById[id];
    if (!meta || !meta.symbol) continue;
    const closes = db.getCloses(meta.symbol, 300);
    rsiCache[id] = { rsi: db.calculateRSI(closes), updatedAt: new Date().toISOString() };
  }
  for (const id of Object.keys(rsiCache)) {
    if (!wl.coins.includes(id)) delete rsiCache[id];
  }
  writeJson(RSI_FILE, rsiCache);
  console.log('[RSI] updated:', Object.keys(rsiCache).map(k => `${k}=${rsiCache[k].rsi}`).join(', '));
}

async function updateSignals() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;

  const rsiCache    = readJson(RSI_FILE, {});
  const signalCache = readJson(SIGNALS_FILE, {});
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('[signals] ANTHROPIC_API_KEY not set'); return; }

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
    try {
      const prompt =
        `Coin: ${meta.name}\n` +
        `Current price: $${price}\n` +
        `24h change: ${change24h.toFixed(2)}%\n` +
        `RSI (14): ${rsi != null ? rsi : 'unavailable'}\n\n` +
        `Respond with valid JSON only, no markdown, no prose:\n` +
        `{"signal":"buy","summary":"..."} where signal is exactly one of: buy, sell, hold. ` +
        `Summary is 1-2 plain English sentences suitable for a trading dashboard.`;

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
      const text   = body.content[0].text.trim();
      const parsed = JSON.parse(text);
      if (!['buy', 'sell', 'hold'].includes(parsed.signal)) throw new Error(`invalid signal: ${parsed.signal}`);
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

async function refreshAllMarketCaps() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;
  try {
    const caps = await coingecko.refreshMarketCaps(wl.coins);
    for (const [id, cap] of Object.entries(caps)) {
      if (cap != null) db.updateMarketCap(id, cap);
    }
    console.log('[market_cap] refreshed:', Object.keys(caps).join(', '));
  } catch (e) {
    console.error('[market_cap] refresh failed:', e.message);
  }
}

// ── watchlist routes ──────────────────────────────────────────────────────────

app.get('/api/watchlist', (req, res) => {
  res.json(readJson(WATCHLIST_FILE, { coins: [] }));
});

app.post('/api/watchlist', (req, res) => {
  const { coin } = req.body;
  if (!coin) return res.status(400).json({ error: 'coin required' });
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  const id = coin.toLowerCase().trim();
  if (!wl.coins.includes(id)) {
    wl.coins.push(id);
    writeJson(WATCHLIST_FILE, wl);
    // seed metadata + backfill candles in background; dashboard shows "—" until ready
    seedCoin(id).catch(e => console.error(`[seed] ${id}:`, e.message));
  }
  res.json(wl);
});

app.delete('/api/watchlist/:coin', (req, res) => {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  wl.coins = wl.coins.filter(c => c !== req.params.coin);
  writeJson(WATCHLIST_FILE, wl);
  res.json(wl);
});

// ── market data route ──────────────────────────────────────────────────────────

app.get('/api/market', async (req, res) => {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return res.json([]);
  try {
    const metaById = Object.fromEntries(db.getAllMeta().map(m => [m.id, m]));
    const results = await Promise.all(wl.coins.map(async id => {
      const meta = metaById[id];
      if (!meta || !meta.symbol) return null;
      let ticker;
      try {
        ticker = await binance.fetchTicker(meta.symbol);
      } catch (e) {
        console.error(`[market] ticker failed for ${meta.symbol}:`, e.message);
        return null;
      }
      const closes300 = db.getCloses(meta.symbol, 300);
      const closes168 = closes300.slice(-168);
      const closes2   = closes300.slice(-2);
      const p1h = closes2.length === 2
        ? (closes2[1] - closes2[0]) / closes2[0] * 100
        : null;
      const p7d = closes168.length >= 2
        ? (closes168[closes168.length - 1] - closes168[0]) / closes168[0] * 100
        : null;
      return {
        id,
        symbol: meta.symbol.replace('USDT', '').toLowerCase(),
        name:   meta.name,
        image:  meta.image,
        current_price:                         parseFloat(ticker.lastPrice),
        price_change_percentage_1h_in_currency: p1h,
        price_change_percentage_24h:            parseFloat(ticker.priceChangePercent),
        price_change_percentage_7d_in_currency: p7d,
        market_cap:   meta.market_cap,
        total_volume: parseFloat(ticker.quoteVolume),
        sparkline_in_7d: { price: closes168 },
      };
    }));
    res.json(results.filter(Boolean));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── RSI route ──────────────────────────────────────────────────────────────────

app.get('/api/rsi', (req, res) => {
  res.json(readJson(RSI_FILE, {}));
});

// ── signals route ──────────────────────────────────────────────────────────────

app.get('/api/signals', (req, res) => {
  res.json(readJson(SIGNALS_FILE, {}));
});

// ── alerts routes ─────────────────────────────────────────────────────────────

app.get('/api/alerts', (req, res) => {
  res.json(readJson(ALERTS_FILE, { alerts: [] }));
});

app.post('/api/alerts', (req, res) => {
  const { coin, condition, price, label } = req.body;
  if (!coin || !condition || price == null)
    return res.status(400).json({ error: 'coin, condition, and price required' });
  const store = readJson(ALERTS_FILE, { alerts: [] });
  const alert = {
    id: Date.now().toString(),
    coin: coin.toLowerCase(),
    condition,
    price: Number(price),
    label: label || '',
    createdAt: new Date().toISOString(),
    active: true,
  };
  store.alerts.push(alert);
  writeJson(ALERTS_FILE, store);
  res.json(alert);
});

app.delete('/api/alerts/:id', (req, res) => {
  const store = readJson(ALERTS_FILE, { alerts: [] });
  store.alerts = store.alerts.filter(a => a.id !== req.params.id);
  writeJson(ALERTS_FILE, store);
  res.json({ ok: true });
});

app.patch('/api/alerts/:id/reset', (req, res) => {
  const store = readJson(ALERTS_FILE, { alerts: [] });
  const alert = store.alerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'not found' });
  alert.active = true;
  writeJson(ALERTS_FILE, store);
  const tr = readJson(TRIGGERED_FILE, { triggered: [] });
  tr.triggered = tr.triggered.filter(id => id !== req.params.id);
  writeJson(TRIGGERED_FILE, tr);
  res.json(alert);
});

// ── alert checker ──────────────────────────────────────────────────────────────

async function checkAlerts() {
  const store  = readJson(ALERTS_FILE, { alerts: [] });
  const active = store.alerts.filter(a => a.active);
  if (!active.length) return;

  const triggered = readJson(TRIGGERED_FILE, { triggered: [] });
  const coinIds   = [...new Set(active.map(a => a.coin))];

  // fetch current price per coin from Binance
  const prices = {};
  for (const id of coinIds) {
    const meta = db.getMeta(id);
    if (!meta || !meta.symbol) {
      console.warn(`[alert check] no symbol for ${id} — skipping`);
      continue;
    }
    try {
      const ticker = await binance.fetchTicker(meta.symbol);
      prices[id] = parseFloat(ticker.lastPrice);
    } catch (e) {
      console.error(`[alert check] ticker failed for ${id}:`, e.message);
    }
  }

  let changed = false;
  for (const alert of active) {
    if (triggered.triggered.includes(alert.id)) continue;
    const current = prices[alert.coin];
    if (current == null) continue;
    const hit =
      (alert.condition === 'above' && current >= alert.price) ||
      (alert.condition === 'below' && current <= alert.price);
    if (hit) {
      const msg = `${alert.coin.toUpperCase()} is ${alert.condition} $${alert.price.toLocaleString()} — now $${current.toLocaleString()}`;
      console.log(`[ALERT] ${msg}`);
      notifier.notify({
        title: 'Crypto Alert' + (alert.label ? `: ${alert.label}` : ''),
        message: msg,
        sound: true,
        wait: false,
      });
      triggered.triggered.push(alert.id);
      changed = true;
    }
  }
  if (changed) writeJson(TRIGGERED_FILE, triggered);
}

// ── cron jobs ──────────────────────────────────────────────────────────────────

// every minute: check price alerts
cron.schedule('* * * * *', () => {
  checkAlerts().catch(e => console.error('[cron alerts]', e.message));
});

// every 15 minutes: fetch new candles → recalc RSI → update signals
cron.schedule('*/15 * * * *', () => {
  updateCandles()
    .then(() => updateRSI())
    .then(() => updateSignals())
    .catch(e => console.error('[cron 15min]', e.message));
});

// every 24 hours at midnight: refresh market caps from CoinGecko
cron.schedule('0 0 * * *', () => {
  refreshAllMarketCaps().catch(e => console.error('[cron 24h]', e.message));
});

// ── start ─────────────────────────────────────────────────────────────────────

db.initDb();
app.listen(PORT, () => {
  console.log(`\n  Crypto Dashboard running at http://localhost:${PORT}\n`);
  // seed metadata + backfill candles; start background jobs after
  seedAndBackfill()
    .then(() => {
      setTimeout(() => checkAlerts().catch(() => {}), 2000);
      setTimeout(() => updateCandles().then(() => updateRSI()).then(() => updateSignals()).catch(() => {}), 4000);
    })
    .catch(e => console.error('[startup]', e.message));
});
```

- [ ] **Step 2: Verify syntax**

```bash
node --check server.js && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: rewrite server.js — Binance live data, SQLite candles, CoinGecko metadata only"
```

---

### Task 5: End-to-end smoke test

**Files:**
- No changes.

- [ ] **Step 1: Start the server and tail logs**

```bash
sudo systemctl restart crypto-dashboard
sleep 3
journalctl -u crypto-dashboard -n 50 --no-pager
```

Expected in logs:
- `Crypto Dashboard running at http://localhost:3000`
- `[seed] metadata stored for bitcoin (BTCUSDT)` (first run) or no seed lines if DB already has data
- `[binance] backfilled N candles for BTCUSDT` (first run only)
- `[RSI] updated: bitcoin=XX.X, ...`

- [ ] **Step 2: Test /api/market**

```bash
curl -s http://localhost:3000/api/market | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.assert(Array.isArray(d), 'not array');
console.assert(d.length > 0, 'empty response — seed may still be running, wait 30s and retry');
const c = d[0];
console.assert(typeof c.id === 'string', 'id missing');
console.assert(typeof c.current_price === 'number', 'current_price missing');
console.assert(typeof c.price_change_percentage_24h === 'number', '24h% missing');
console.assert(Array.isArray(c.sparkline_in_7d.price), 'sparkline missing');
console.log('market OK:', d.map(x => x.symbol.toUpperCase() + '=' + x.current_price).join(', '));
"
```

Expected: `market OK: BTC=<price>, ETH=<price>, ...`

- [ ] **Step 3: Test /api/rsi**

```bash
curl -s http://localhost:3000/api/rsi | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const entries = Object.entries(d);
console.assert(entries.length > 0, 'RSI cache empty');
entries.forEach(([id, v]) => {
  console.assert(v.rsi != null, id + ': RSI is null (need more candle history)');
});
console.log('RSI OK:', entries.map(([id,v]) => id + '=' + v.rsi).join(', '));
"
```

Expected: `RSI OK: bitcoin=<n>, ethereum=<n>, ...`

- [ ] **Step 4: Test /api/signals**

```bash
curl -s http://localhost:3000/api/signals | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log('signals:', Object.keys(d).length > 0
  ? Object.entries(d).map(([id,v]) => id + '=' + v.signal).join(', ')
  : '(pending — ANTHROPIC_API_KEY may not be set or first run not complete yet)');
"
```

- [ ] **Step 5: Test /api/alerts**

```bash
curl -s http://localhost:3000/api/alerts | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.assert(Array.isArray(d.alerts), 'alerts array missing');
console.log('alerts OK, count:', d.alerts.length);
"
```

Expected: `alerts OK, count: <n>`

- [ ] **Step 6: Test add-coin triggers background seed**

```bash
# Add a coin not in default watchlist
curl -s -X POST http://localhost:3000/api/watchlist \
  -H 'Content-Type: application/json' \
  -d '{"coin":"polkadot"}' | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.assert(d.coins.includes('polkadot'), 'polkadot not added');
console.log('add-coin OK:', d.coins);
"
# Wait for background seed
sleep 15
journalctl -u crypto-dashboard -n 10 --no-pager | grep -E 'seed|backfill|polkadot'
```

Expected: log lines showing `[seed] metadata stored for polkadot (DOTUSDT)` and `[binance] backfilled N candles for DOTUSDT`.

- [ ] **Step 7: Open browser**

Navigate to `http://localhost:3000`. Confirm:
- All watchlist coins show live prices
- 24h % column has values
- 7d sparklines render (may be flat/short for newly added coins until candles backfill)
- RSI badges show numbers
- Signal column shows buy/sell/hold badges (or Pending if ANTHROPIC_API_KEY not set)

- [ ] **Step 8: Remove polkadot from watchlist (cleanup)**

```bash
curl -s -X DELETE http://localhost:3000/api/watchlist/polkadot
```

- [ ] **Step 9: Final commit**

```bash
# Nothing to commit if Step 8 only modified watchlist.json (not tracked).
# If any files changed during testing, commit them:
git status
# If clean: done. If not:
git add -A
git commit -m "chore: post-migration cleanup"
```
