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

async function fetchPrices(ids) {
  const url = `https://api.coingecko.com/api/v3/coins/markets` +
    `?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc` +
    `&sparkline=true&price_change_percentage=1h,24h,7d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return res.json();
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

// ── start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Crypto Dashboard running at http://localhost:${PORT}\n`);
  // run first alert check after 5s
  setTimeout(() => checkAlerts().catch(() => {}), 5000);
});
