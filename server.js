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
    meta = db.getMeta(id); // re-read so meta.market_cap_updated_at is current
  }

  if (!meta || !meta.symbol) return;
  if (!db.getLastCandleTime(id, '1h')) {
    try {
      await binance.backfillCandles(id, meta.symbol, '1h', 90 * 24 * 3600 * 1000, db);
    } catch (e) {
      console.error(`[seed] 1h backfill failed for ${id}:`, e.message);
    }
  }
  if (!db.getLastCandleTime(id, '1m')) {
    try {
      await binance.backfillCandles(id, meta.symbol, '1m', 7 * 24 * 3600 * 1000, db);
    } catch (e) {
      console.error(`[seed] 1m backfill failed for ${id}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 2000)); // rate-limit gap between coins for 1m backfill
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
      await binance.fetchNewCandles(id, meta.symbol, '1h', db);
    } catch (e) {
      console.error(`[candles] 1h update failed for ${id}:`, e.message);
    }
  }
}

async function update1mCandles() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  const metaById = Object.fromEntries(db.getAllMeta().map(m => [m.id, m]));
  for (const id of wl.coins) {
    const meta = metaById[id];
    if (!meta || !meta.symbol) continue;
    try {
      await binance.fetchNewCandles(id, meta.symbol, '1m', db);
    } catch (e) {
      console.error(`[candles] 1m update failed for ${id}:`, e.message);
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
    const closes = db.getCloses(id, '1h', 300);
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
      const raw    = body.content[0].text.trim();
      // Strip markdown code fences if the model wraps the JSON in ```...```
      const text   = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
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
      const closes300 = db.getCloses(id, '1h', 300);
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

// ── candles route ──────────────────────────────────────────────────────────────

app.get('/api/candles/:coinId', (req, res) => {
  const { coinId } = req.params;
  const interval = req.query.interval || '1h';

  // Fixed time window per interval (window = depth of source data available)
  const windows = {
    '1m':   24 *  3600 * 1000,  // 24h  — native 1m
    '5m':    7 * 86400 * 1000,  //  7d  — aggregated from 1m (7d stored)
    '15m':   7 * 86400 * 1000,  //  7d  — aggregated from 1m (7d stored)
    '4h':   90 * 86400 * 1000,  // 90d  — aggregated from 1h (90d stored)
    '1h':   90 * 86400 * 1000,  // 90d  — native 1h
    '1d':   90 * 86400 * 1000,  // 90d  — aggregated from 1h (~90 daily bars)
  };
  // Derived intervals: bucket size in ms
  const buckets = { '5m': 300000, '15m': 900000, '4h': 14400000, '1d': 86400000 };

  if (!windows[interval]) return res.status(400).json({ error: 'invalid interval' });

  const since = Date.now() - windows[interval];
  let candles;
  if (buckets[interval]) {
    // 4h and 1d aggregate from 1h data; 5m and 15m aggregate from 1m data
    const src = (interval === '4h' || interval === '1d') ? '1h' : '1m';
    candles = db.getAggCandles(coinId, src, buckets[interval], since);
  } else {
    candles = db.getCandles(coinId, interval, since);
  }
  res.json(candles);
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

// every minute: check price alerts + fetch new 1m candles
cron.schedule('* * * * *', () => {
  checkAlerts().catch(e => console.error('[cron alerts]', e.message));
  update1mCandles().catch(e => console.error('[cron 1m candles]', e.message));
});

// every 15 minutes: fetch new candles → recalc RSI → update signals
cron.schedule('*/15 * * * *', () => {
  updateCandles()
    .then(() => updateRSI())
    .then(() => updateSignals())
    .catch(e => console.error('[cron 15min] unexpected error:', e.message));
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
