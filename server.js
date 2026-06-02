const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const notifier = require('node-notifier');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const TRIGGERED_FILE = path.join(DATA_DIR, 'triggered.json');
const RSI_FILE = path.join(DATA_DIR, 'rsi.json');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── helpers ──────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  // seed: simple average of first `period` changes
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  // smooth remaining
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

async function fetchMarketChart(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart` +
    `?vs_currency=usd&days=30&interval=daily`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko market_chart ${res.status} for ${id}`);
  return res.json();
}

async function updateRSI() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;
  const rsiCache = readJson(RSI_FILE, {});
  for (const id of wl.coins) {
    try {
      const chart = await fetchMarketChart(id);
      const closes = chart.prices.map(p => p[1]);
      rsiCache[id] = { rsi: calculateRSI(closes), updatedAt: new Date().toISOString() };
    } catch (e) {
      console.error(`[RSI] ${id}:`, e.message);
    }
    // avoid rate-limiting on free tier
    await new Promise(r => setTimeout(r, 1200));
  }
  writeJson(RSI_FILE, rsiCache);
  console.log('[RSI] updated:', Object.keys(rsiCache).map(k => `${k}=${rsiCache[k].rsi}`).join(', '));
}

async function fetchPrices(ids) {
  const url = `https://api.coingecko.com/api/v3/coins/markets` +
    `?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc` +
    `&sparkline=true&price_change_percentage=1h,24h,7d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return res.json();
}

async function updateSignals() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;

  const rsiCache = readJson(RSI_FILE, {});
  let marketData = [];
  try {
    marketData = await fetchPrices(wl.coins);
  } catch (e) {
    console.error('[signals] price fetch failed:', e.message);
    return;
  }

  const signalCache = readJson(SIGNALS_FILE, {});
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[signals] ANTHROPIC_API_KEY not set');
    return;
  }

  for (const coin of marketData) {
    const rsiEntry = rsiCache[coin.id];
    const rsi = rsiEntry ? rsiEntry.rsi : null;
    try {
      const prompt =
        `Coin: ${coin.name}\n` +
        `Current price: $${coin.current_price}\n` +
        `24h change: ${coin.price_change_percentage_24h != null ? coin.price_change_percentage_24h.toFixed(2) : 'N/A'}%\n` +
        `RSI (14): ${rsi != null ? rsi : 'unavailable'}\n\n` +
        `Respond with valid JSON only, no markdown, no prose:\n` +
        `{"signal":"buy","summary":"..."} where signal is exactly one of: buy, sell, hold. ` +
        `Summary is 1-2 plain English sentences suitable for a trading dashboard.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      const body = await res.json();
      const text = body.content[0].text.trim();
      const parsed = JSON.parse(text);
      if (!['buy', 'sell', 'hold'].includes(parsed.signal)) throw new Error(`invalid signal: ${parsed.signal}`);
      if (typeof parsed.summary !== 'string') throw new Error('missing summary');

      signalCache[coin.id] = {
        signal: parsed.signal,
        summary: parsed.summary,
        updatedAt: new Date().toISOString()
      };
    } catch (e) {
      console.error(`[signals] ${coin.id}:`, e.message);
    }
    // avoid Anthropic rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  // evict coins removed from watchlist
  for (const id of Object.keys(signalCache)) {
    if (!wl.coins.includes(id)) delete signalCache[id];
  }

  writeJson(SIGNALS_FILE, signalCache);
  console.log('[signals] updated:', Object.keys(signalCache).map(k => `${k}=${signalCache[k].signal}`).join(', '));
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
  if (!wl.coins.includes(id)) wl.coins.push(id);
  writeJson(WATCHLIST_FILE, wl);
  res.json(wl);
});

app.delete('/api/watchlist/:coin', (req, res) => {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  wl.coins = wl.coins.filter(c => c !== req.params.coin);
  writeJson(WATCHLIST_FILE, wl);
  res.json(wl);
});

// ── market data route ─────────────────────────────────────────────────────────

app.get('/api/market', async (req, res) => {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return res.json([]);
  try {
    const data = await fetchPrices(wl.coins);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── RSI route ─────────────────────────────────────────────────────────────────

app.get('/api/rsi', (req, res) => {
  res.json(readJson(RSI_FILE, {}));
});

// ── signals route ─────────────────────────────────────────────────────────────

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
    condition,        // "above" | "below"
    price: Number(price),
    label: label || '',
    createdAt: new Date().toISOString(),
    active: true
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
  // clear triggered record
  const tr = readJson(TRIGGERED_FILE, { triggered: [] });
  tr.triggered = tr.triggered.filter(id => id !== req.params.id);
  writeJson(TRIGGERED_FILE, tr);
  res.json(alert);
});

// ── cron: check alerts every minute ──────────────────────────────────────────

async function checkAlerts() {
  const store = readJson(ALERTS_FILE, { alerts: [] });
  const active = store.alerts.filter(a => a.active);
  if (!active.length) return;

  const triggered = readJson(TRIGGERED_FILE, { triggered: [] });
  const coins = [...new Set(active.map(a => a.coin))];

  let prices;
  try {
    const data = await fetchPrices(coins);
    prices = Object.fromEntries(data.map(d => [d.id, d.current_price]));
  } catch (e) {
    console.error('[alert check] fetch failed:', e.message);
    return;
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
        wait: false
      });

      triggered.triggered.push(alert.id);
      changed = true;
    }
  }
  if (changed) writeJson(TRIGGERED_FILE, triggered);
}

cron.schedule('* * * * *', () => {
  checkAlerts().catch(e => console.error('[cron]', e.message));
});

cron.schedule('*/10 * * * *', () => {
  updateRSI()
    .then(() => updateSignals())
    .catch(e => console.error('[rsi/signals cron]', e.message));
});

// ── start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Crypto Dashboard running at http://localhost:${PORT}\n`);
  // run first alert check after 5s
  setTimeout(() => checkAlerts().catch(() => {}), 5000);
  // run first RSI + signals update after 10s
  setTimeout(() => updateRSI().then(() => updateSignals()).catch(() => {}), 10000);
});
