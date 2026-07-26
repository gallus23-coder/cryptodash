// server.js
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const cron = require('node-cron');
const notifier = require('node-notifier');
const db = require('./db');
const Database = require('better-sqlite3');
const binance = require('./binance');
const coingecko = require('./coingecko');
const ind       = require('./indicators');
const feargreed = require('./feargreed');
const scanner   = require('./scanner');
const backtest  = require('./backtest');

// ── In-memory connectivity tracker ───────────────────────────────────────────
// Updated by existing fetch call-sites via recordConnSuccess / recordConnError.
// Services: 'anthropic', 'binance', 'coingecko', 'kraken'
const _connState = {
  anthropic:  { ok: null, lastError: null, lastSuccessAt: null, lastErrorAt: null },
  binance:    { ok: null, lastError: null, lastSuccessAt: null, lastErrorAt: null },
  coingecko:  { ok: null, lastError: null, lastSuccessAt: null, lastErrorAt: null },
  kraken:     { ok: null, lastError: null, lastSuccessAt: null, lastErrorAt: null },
};
function recordConnSuccess(service) {
  const s = _connState[service];
  if (s) { s.ok = true; s.lastError = null; s.lastSuccessAt = new Date().toISOString(); }
}
function recordConnError(service, err) {
  const s = _connState[service];
  if (s) { s.ok = false; s.lastError = String(err); s.lastErrorAt = new Date().toISOString(); }
}

// ── In-memory rolling error log (last 30 entries) ─────────────────────────────
const _errorLog = [];
function logError(service, message) {
  _errorLog.unshift({ service, timestamp: new Date().toISOString(), message: String(message).slice(0, 300) });
  if (_errorLog.length > 30) _errorLog.length = 30;
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const ALERTS_FILE    = path.join(DATA_DIR, 'alerts.json');
const TRIGGERED_FILE = path.join(DATA_DIR, 'triggered.json');
const RSI_FILE       = path.join(DATA_DIR, 'rsi.json');
const SIGNALS_FILE   = path.join(DATA_DIR, 'signals.json');
const INDICATORS_FILE = path.join(DATA_DIR, 'indicators.json');
const FEARGREED_FILE  = path.join(DATA_DIR, 'feargreed.json');
const SCANNER_FILE      = path.join(DATA_DIR, 'scanner.json');
const BACKTEST_FILE     = path.join(DATA_DIR, 'backtest.json');
const KRAKEN_PAIRS_FILE = path.join(DATA_DIR, 'kraken_pairs.json');
const FXRATE_FILE       = path.join(DATA_DIR, 'fxrate.json');
const FT_CONFIG_FILE       = '/home/gallus23/freqtrade/user_data/config.json';
const FT_TREND_CONFIG_FILE = '/home/gallus23/freqtrade/user_data/config_trend.json';

// ── Freqtrade API client ──────────────────────────────────────────────────────

const FREQTRADE_API = 'http://localhost:8080/api/v1';
const FT_CREDS      = { username: 'cryptodash', password: 'Swagger23!' };
let _ftToken = null;

// Reverse map: CoinGecko ID → Freqtrade GBP pair (known coins)
const COIN_TO_PAIR = {
  bitcoin:       'BTC/GBP',
  ethereum:      'ETH/GBP',
  solana:        'SOL/GBP',
  ripple:        'XRP/GBP',
  cardano:       'ADA/GBP',
  binancecoin:   'BNB/GBP',
  chainlink:     'LINK/GBP',
  'avalanche-2': 'AVAX/GBP',
};

// Inverse map: Freqtrade GBP pair → CoinGecko ID
const PAIR_TO_COIN = Object.fromEntries(
  Object.entries(COIN_TO_PAIR).map(([k, v]) => [v, k])
);

// Freqtrade SQLite paths (opened read-only per request)
const FT_DB_MR    = '/home/gallus23/freqtrade/user_data/tradesv3.sqlite';
const FT_DB_TREND = '/home/gallus23/freqtrade/user_data/tradesv3_trend.sqlite';

async function ftLogin() {
  const b64 = Buffer.from(`${FT_CREDS.username}:${FT_CREDS.password}`).toString('base64');
  const res = await fetch(`${FREQTRADE_API}/token/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': `Basic ${b64}` },
  });
  if (!res.ok) throw new Error(`Freqtrade login failed: ${res.status}`);
  _ftToken = (await res.json()).access_token;
}

async function ftRequest(method, path, body) {
  if (!_ftToken) await ftLogin();
  const makeOpts = () => ({
    method,
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${_ftToken}` },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  let res = await fetch(`${FREQTRADE_API}${path}`, makeOpts());
  if (res.status === 401) {
    await ftLogin();
    res = await fetch(`${FREQTRADE_API}${path}`, makeOpts());
  }
  return res;
}

async function ftPairAvailable(pair) {
  try {
    const res = await ftRequest('GET',
      `/pair_candles?pair=${encodeURIComponent(pair)}&timeframe=1h&limit=1`);
    return res.ok;
  } catch { return false; }
}

async function ftAddPair(pair) {
  const res = await ftRequest('POST', '/whitelist', { whitelist: [pair] });
  if (!res.ok) throw new Error(`Freqtrade whitelist add ${pair}: ${res.status}`);
}

async function ftRemovePair(pair) {
  try {
    const res = await ftRequest('DELETE', '/whitelist', { pairs_to_delete: [pair] });
    if (!res.ok) console.warn(`[scanner] Freqtrade whitelist remove ${pair}: ${res.status}`);
  } catch (e) {
    console.warn(`[scanner] Freqtrade whitelist remove ${pair} failed:`, e.message);
  }
}

async function ftGetOpenPairs() {
  try {
    const res = await ftRequest('GET', '/status');
    if (!res.ok) return new Set();
    const trades = await res.json();
    return new Set(Array.isArray(trades) ? trades.map(t => t.pair) : []);
  } catch { return new Set(); }
}

// Derive GBP pair from coin_id + Binance symbol
function toGBPPair(coinId, binanceSymbol) {
  return COIN_TO_PAIR[coinId] || `${binanceSymbol.replace(/USDT$/, '')}/GBP`;
}

// Resolve CoinGecko ID from a Binance symbol (e.g. "DOTUSDT" → "polkadot").
// Checks coin_meta first, then falls back to CoinGecko search.
async function resolveCoinId(binanceSymbol) {
  const existing = db.getMetaBySymbol(binanceSymbol);
  if (existing) return existing.id;
  return coingecko.searchCoinId(binanceSymbol.replace(/USDT$/, ''));
}

// ── Kraken pairs cache (24h TTL) ──────────────────────────────────────────────

async function getKrakenGBPMap() {
  const cached = readJson(KRAKEN_PAIRS_FILE, null);
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) {
    return new Map(Object.entries(cached.pairs));
  }
  try {
    const map = await scanner.fetchKrakenGBPPairs();
    writeJson(KRAKEN_PAIRS_FILE, { fetchedAt: Date.now(), pairs: Object.fromEntries(map) });
    console.log(`[scanner] Kraken GBP pairs refreshed (${map.size} pairs)`);
    recordConnSuccess('kraken');
    return map;
  } catch (e) {
    console.error('[scanner] Kraken AssetPairs fetch failed:', e.message);
    recordConnError('kraken', e.message);
    logError('crypto-dashboard', `[scanner] Kraken: ${e.message}`);
    if (cached && cached.pairs) return new Map(Object.entries(cached.pairs));
    return new Map();
  }
}

// ── Freqtrade config file helpers ─────────────────────────────────────────────

function ftConfigAddPair(pair, configFile, label) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const wl = cfg.exchange?.pair_whitelist || [];
    if (!wl.includes(pair)) {
      wl.push(pair);
      cfg.exchange.pair_whitelist = wl;
      const tmp = configFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, configFile);
      console.log(`[scanner] Added ${pair} to ${label} whitelist`);
    }
  } catch (e) {
    throw new Error(`ftConfigAddPair ${pair} (${label}): ${e.message}`);
  }
}

function ftConfigRemovePair(pair, configFile, label) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const wl = cfg.exchange?.pair_whitelist || [];
    const updated = wl.filter(p => p !== pair);
    if (updated.length !== wl.length) {
      cfg.exchange.pair_whitelist = updated;
      const tmp = configFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, configFile);
      console.log(`[scanner] Removed ${pair} from ${label} whitelist`);
    }
  } catch (e) {
    console.error(`[scanner] ftConfigRemovePair ${pair} (${label}) failed:`, e.message);
  }
}

// Reload both FT instances. TF failure is non-fatal.
async function ftReloadBoth() {
  const { meanReversionClient, trendClient } = require('./lib/freqtradeClient');
  try {
    const res = await meanReversionClient.request('POST', '/reload_config');
    if (!res.ok) console.warn(`[scanner] Mean Reversion reload_config: ${res.status}`);
    else console.log('[scanner] Mean Reversion config reloaded');
  } catch (e) {
    console.warn('[scanner] Mean Reversion reload_config failed:', e.message);
  }
  try {
    const res = await trendClient.request('POST', '/reload_config');
    if (!res.ok) console.warn(`[scanner] Trend Following reload_config: ${res.status}`);
    else console.log('[scanner] Trend Following config reloaded');
  } catch (e) {
    console.warn('[scanner] Reload failed for Trend Following (service may be down) — continuing');
  }
}

// Set of GBP pairs present in EITHER config at startup — never auto-remove these.
let _manualCoins = null;

function initManualCoins() {
  const pairs = new Set();
  for (const [file, label] of [
    [FT_CONFIG_FILE, 'Mean Reversion'],
    [FT_TREND_CONFIG_FILE, 'Trend Following'],
  ]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const p of (cfg.exchange?.pair_whitelist || [])) pairs.add(p);
    } catch (e) {
      console.warn(`[scanner] Could not read ${label} config for manual coins:`, e.message);
    }
  }
  _manualCoins = pairs;
  console.log(`[scanner] Manual coins: ${[..._manualCoins].join(', ')}`);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── backtest job state ────────────────────────────────────────────────────────
let backtestJob = { status: 'idle', progress: 0, message: '', jobId: null };

// ── helpers ───────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ── GBP/USD exchange rate ─────────────────────────────────────────────────────
//
// cryptodash candle/indicator data is sourced from Binance USDT pairs and is in
// USD. priceGBP is a converted convenience field for comparing against Freqtrade
// (which trades GBP pairs on Kraken) — do NOT use priceGBP for any trading
// decision logic; it is for display/debugging only.
//
// Rate direction: gbpUsdRate is GBP per USD (i.e. < 1.0, typically ~0.78).
// priceGBP = price_usd * gbpUsdRate.

let _fxRateCache = null; // { rate: number, fetchedAt: number }

const FX_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchFxRate() {
  if (_fxRateCache && Date.now() - _fxRateCache.fetchedAt < FX_TTL_MS) {
    return _fxRateCache.rate;
  }

  // Try to restore from disk cache first (survives restarts)
  if (!_fxRateCache) {
    const persisted = readJson(FXRATE_FILE, null);
    if (persisted && Date.now() - persisted.fetchedAt < FX_TTL_MS) {
      _fxRateCache = persisted;
      return _fxRateCache.rate;
    }
  }

  // Primary: frankfurter.app — returns rates[GBP] which is GBP per 1 USD
  let rate = null;
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=GBP');
    if (res.ok) {
      const data = await res.json();
      rate = data?.rates?.GBP;
    }
  } catch (e) {
    console.warn('[fx] frankfurter.app failed:', e.message);
  }

  // Fallback: open.er-api.com — same field layout
  if (!rate) {
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD');
      if (res.ok) {
        const data = await res.json();
        rate = data?.rates?.GBP;
      }
    } catch (e) {
      console.warn('[fx] open.er-api.com failed:', e.message);
    }
  }

  if (!rate) {
    console.warn('[fx] Could not fetch GBP/USD rate, priceGBP omitted from indicators.json');
    return null;
  }

  _fxRateCache = { rate, fetchedAt: Date.now() };
  writeJson(FXRATE_FILE, _fxRateCache);
  console.log(`[fx] GBP/USD rate updated: 1 USD = ${rate.toFixed(6)} GBP`);
  return rate;
}

// ── Binance Futures — funding rate & open interest ───────────────────────────
//
// Uses Binance USDT-M Futures (fapi). Not all watchlist coins have perp contracts
// (e.g. small-cap alts). Errors and missing data are handled gracefully — callers
// receive null fields which are omitted from indicators.json rather than guessed.

const FAPI_BASE = 'https://fapi.binance.com';

async function fetchFundingAndOI(symbol) {
  // symbol is e.g. 'BTCUSDT' — same format as spot
  try {
    const [premRes, oiRes] = await Promise.all([
      fetch(`${FAPI_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      fetch(`${FAPI_BASE}/fapi/v1/openInterest?symbol=${symbol}`),
    ]);
    const fundingRate   = premRes.ok ? parseFloat((await premRes.json()).lastFundingRate) : null;
    const openInterest  = oiRes.ok  ? parseFloat((await oiRes.json()).openInterest)       : null;
    return { fundingRate, openInterest };
  } catch {
    return { fundingRate: null, openInterest: null };
  }
}

// Compute trend object from current value and 24h-ago DB row.
// direction: 'rising' / 'falling' / 'flat' (±2% relative threshold)
function derivTrend(current, agoRow, field) {
  if (current == null) return null;
  const agoVal = agoRow?.[field] ?? null;
  const trend24h    = agoVal != null ? current - agoVal : null;
  const trend24hPct = trend24h != null && agoVal !== 0 ? trend24h / Math.abs(agoVal) * 100 : null;
  const direction   = trend24hPct == null ? 'unknown'
                    : trend24hPct >  2 ? 'rising'
                    : trend24hPct < -2 ? 'falling'
                    : 'flat';
  return { current, trend24h, trend24hPct, direction };
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
      recordConnSuccess('coingecko');
    } catch (e) {
      console.error(`[seed] metadata failed for ${id}:`, e.message);
      recordConnError('coingecko', e.message);
      logError('crypto-dashboard', `[seed] coingecko ${id}: ${e.message}`);
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
      recordConnSuccess('binance');
    } catch (e) {
      console.error(`[candles] 1h update failed for ${id}:`, e.message);
      recordConnError('binance', e.message);
      logError('crypto-dashboard', `[candles] 1h ${id}: ${e.message}`);
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
      recordConnSuccess('binance');
    } catch (e) {
      console.error(`[candles] 1m update failed for ${id}:`, e.message);
      recordConnError('binance', e.message);
      logError('crypto-dashboard', `[candles] 1m ${id}: ${e.message}`);
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
    const closes = db.getCloses(id, '1h', 301).slice(0, -1); // drop incomplete forming candle
    rsiCache[id] = { rsi: db.calculateRSI(closes), updatedAt: new Date().toISOString() };
  }
  for (const id of Object.keys(rsiCache)) {
    if (!wl.coins.includes(id)) delete rsiCache[id];
  }
  writeJson(RSI_FILE, rsiCache);
  console.log('[RSI] updated:', Object.keys(rsiCache).map(k => `${k}=${rsiCache[k].rsi}`).join(', '));
}

async function updateIndicators() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;
  const fxRate   = await fetchFxRate(); // GBP per USD; null if unavailable
  const metaById = Object.fromEntries(db.getAllMeta().map(m => [m.id, m]));
  const cache = {};
  for (const id of wl.coins) {
    // Fetch one extra for each array and strip the last (incomplete forming candle)
    const closes  = db.getCloses(id, '1h', 301).slice(0, -1);
    const volumes = db.getVolumes(id, '1h', 22).slice(0, -1);
    const ohlc    = db.getOHLCLimit(id, '1h', 15).slice(0, -1);
    if (closes.length < 35) continue;
    const price       = closes[closes.length - 1];
    const macd        = ind.calcMACD(closes);
    const bb          = ind.calcBollingerBands(closes);
    const stochRsi    = ind.calcStochRSI(closes);
    const volumeRatio = ind.calcVolumeRatio(volumes);
    const ema50       = ind.calcEMA(closes, 50);
    const ema200      = ind.calcEMA(closes, 200);
    const emaAbovePrice = ema200 != null && price > ema200;
    const atr14       = ind.calcATR(ohlc, 14);
    const atr14Pct    = (atr14 != null && price > 0) ? (atr14 / price * 100) : null;
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

    // ── Derivatives: funding rate + open interest ────────────────────────────
    let fundingRate = null, openInterest = null;
    const meta = metaById[id];
    if (meta?.symbol) {
      try {
        const deriv = await fetchFundingAndOI(meta.symbol);
        // openInterest from Binance is coin quantity (e.g. number of BTC).
        // Multiply by current USD price for cross-coin comparable notional value.
        const oiCoinQty = deriv.openInterest;
        const oiUSD     = oiCoinQty != null ? oiCoinQty * price : null;
        const now = Date.now();
        if (deriv.fundingRate != null || oiCoinQty != null) {
          db.upsertDerivatives({ coin_id: id, time: now, funding_rate: deriv.fundingRate, open_interest: oiCoinQty, open_interest_usd: oiUSD });
        }
        const ago = db.getDerivativesAgo(id, 24 * 3600 * 1000);
        fundingRate = derivTrend(deriv.fundingRate, ago, 'funding_rate');
        // Build openInterest trend using USD notional for comparability; expose coin qty separately
        const oiTrend = derivTrend(oiUSD, ago, 'open_interest_usd');
        if (oiTrend != null) {
          openInterest = { ...oiTrend, currentCoinQty: oiCoinQty };
        }
      } catch (e) {
        console.warn(`[indicators] derivatives fetch failed for ${id}:`, e.message);
      }
    }

    cache[id] = {
      macd, bb, ema50, ema200, emaAbovePrice, goldenCross, deathCross,
      stochRsi, volumeRatio, atr14, atr14Pct,
      ...(fxRate != null
        ? { priceGBP: price * fxRate, gbpUsdRate: fxRate, gbpUsdRateUpdatedAt: _fxRateCache?.fetchedAt ?? null }
        : {}),
      ...(fundingRate  != null ? { fundingRate }  : {}),
      ...(openInterest != null ? { openInterest } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
  writeJson(INDICATORS_FILE, cache);
  console.log('[indicators] updated:', Object.keys(cache).join(', '));
}

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

function buildSignalSystem(phase) {
  const isBull = phase === 'bull';
  const params = isBull
    ? { rsiMin: 32, rsiMax: 53, stochRsi: 39, volume: 1.8, ema50Dist: 1.2, stopLoss: 7, takeProfit: 20, timeStop: 67 }
    : { rsiMin: 34, rsiMax: 49, stochRsi: 17, volume: 1.7, ema50Dist: 6.2, stopLoss: 5, takeProfit: 15, timeStop: 89 };
  const phaseLabel = isBull
    ? 'BULL (BTC above 200 EMA) — Jun 2024 hyperopt (144 days)'
    : 'BEAR (BTC below 200 EMA) — Jun 2026 hyperopt (357 days)';
  return `You are a systematic crypto trading assistant. Your only job is to evaluate whether a coin currently meets the criteria for our exact trading strategy and report that evaluation as structured JSON.

STRATEGY: Mean Reversion in Uptrend — Adaptive Market Phase
Current market phase: ${phaseLabel}

Entry criteria (ALL must be met for a buy signal):
  1. Price above EMA200 (confirmed uptrend)
  2. RSI between ${params.rsiMin} and ${params.rsiMax} (pulled back from overbought)
  3. Price within ${params.ema50Dist}% of EMA50 (near mean)
  4. MACD line > 0 (macro momentum positive) and histogram positive
  5. Stochastic RSI %K below ${params.stochRsi} (oversold on fast oscillator)
  6. Volume ratio >= ${params.volume}x 20-period average (participation confirming move)

Risk parameters:
  - Stop loss: ${params.stopLoss}% below entry
  - Take profit: ${params.takeProfit}% above entry
  - Time stop: exit if target not reached within ${params.timeStop} hours

Signal scale:
  strong_buy  — ALL 6 criteria met, strong momentum alignment
  buy         — 5 of 6 criteria met (one marginal miss)
  hold        — setup partially forming but not actionable yet
  sell        — uptrend intact but indicators deteriorating, consider reducing
  strong_sell — multiple criteria failing or downtrend signals present

Respond ONLY with valid JSON, no markdown, no prose. Use exactly this shape:
{
  "signal": "<strong_buy|buy|hold|sell|strong_sell>",
  "summary": "<1-2 sentences referencing specific values>",
  "entryQuality": {
    "allCriteriaMet": <true|false>,
    "marginalCriteria": ["<criterion text if nearly met>"],
    "failingCriteria": ["<criterion text if failing>"]
  },
  "riskAssessment": {
    "stopLossRisk": "<low|medium|high>",
    "stopLossNote": "<one sentence on ATR vs ${params.stopLoss}% stop>",
    "takeProfitReachable": <true|false>,
    "takeProfitNote": "<one sentence on momentum towards ${params.takeProfit}% target>",
    "timeStopRisk": "<low|medium|high>",
    "timeStopNote": "<one sentence on likelihood of resolving within ${params.timeStop}h>"
  },
  "newsImpact": "<none|minor|major>",
  "newsNote": "<one sentence if newsImpact is minor or major, else null>",
  "derivativesContext": "<one sentence on what funding rate and/or OI trend signals about conviction or risk, or null if derivatives data absent>"
}`;
}

function buildWatchlistSignalPrompt(meta, price, change24h, rsi, i, fngStr, volumeThreshold) {
  const volThreshold = volumeThreshold || 1.7;
  const lines = [
    `Coin: ${meta.name}`,
    `Price: $${price}`,
    `24h change: ${change24h.toFixed(2)}%`,
    `RSI (14): ${rsi != null ? rsi.toFixed(1) : 'unavailable'}`,
  ];
  if (i.macd) {
    lines.push(`MACD line: ${i.macd.macd.toFixed(6)} | Signal: ${i.macd.signal.toFixed(6)} | Histogram: ${i.macd.histogram.toFixed(6)}`);
  }
  if (i.bb) {
    lines.push(`Bollinger: Upper $${i.bb.upper.toFixed(4)} Middle $${i.bb.middle.toFixed(4)} Lower $${i.bb.lower.toFixed(4)} BW: ${i.bb.bandwidthPct.toFixed(1)}%`);
  }
  if (i.ema50  != null) lines.push(`EMA50: $${i.ema50.toFixed(4)}`);
  if (i.ema200 != null) lines.push(`EMA200: $${i.ema200.toFixed(4)} | Price ${i.emaAbovePrice ? 'above' : 'below'} 200 EMA`);
  if (i.goldenCross) lines.push('Golden cross detected in last 3 candles.');
  if (i.deathCross)  lines.push('Death cross detected in last 3 candles.');
  if (i.stochRsi)    lines.push(`Stoch RSI: %K=${i.stochRsi.k.toFixed(1)} %D=${i.stochRsi.d.toFixed(1)}`);
  if (i.volumeRatio != null) {
    const vrLabel = i.volumeRatio >= volThreshold
      ? `above ${volThreshold}x — entry requirement met`
      : `below ${volThreshold}x — entry requirement NOT met`;
    lines.push(`Volume ratio vs 20-period avg: ${i.volumeRatio.toFixed(2)}x (${vrLabel})`);
  }
  if (i.atr14 != null) {
    const atrPct = i.atr14Pct != null ? ` (${i.atr14Pct.toFixed(2)}% of price)` : '';
    lines.push(`ATR-14 (1h): $${i.atr14.toFixed(4)}${atrPct}`);
  }
  lines.push(`Fear & Greed: ${fngStr}`);

  // ── Derivatives context (qualitative signal, NOT a hard entry gate) ────────
  const hasDeriv = i.fundingRate || i.openInterest;
  if (hasDeriv) {
    lines.push('');
    lines.push('DERIVATIVES MARKET CONTEXT (qualitative judgment — NOT a hard pass/fail gate):');
    if (i.fundingRate) {
      const fr = i.fundingRate;
      const frPct = (fr.current * 100).toFixed(4);
      const trendNote = fr.trend24hPct != null
        ? `, ${fr.direction} (${fr.trend24hPct >= 0 ? '+' : ''}${fr.trend24hPct.toFixed(1)}% over 24h)`
        : '';
      lines.push(`Funding rate: ${frPct}%${trendNote}`);
      lines.push('  Rising funding into a rally can signal overheating — leveraged longs paying more. Falling/negative funding during a dip signals short capitulation, often precedes bounces.');
    }
    if (i.openInterest) {
      const oi = i.openInterest;
      const oiTrendNote = oi.trend24hPct != null
        ? ` ${oi.direction} (${oi.trend24hPct >= 0 ? '+' : ''}${oi.trend24hPct.toFixed(1)}% over 24h)`
        : ' — direction unknown (no 24h history yet)';
      lines.push(`Open interest:${oiTrendNote} (current: $${(oi.current / 1e6).toFixed(1)}M)`);
      lines.push('  Rising price + rising OI = new money entering, trend likely genuine. Rising price + falling OI = short covering, weaker conviction. Falling price + rising OI = new shorts, bearish. Falling price + falling OI = longs liquidating, potential snap-back.');
    }
    lines.push('If OI/funding contradicts the technical setup, note this and consider downgrading confidence (e.g. strong_buy → buy) even if all 9 technical criteria are met. Populate derivativesContext with your interpretation.');
  }

  lines.push('');
  lines.push('Evaluate this coin against the strategy criteria above and return the JSON response.');
  return lines.join('\n');
}

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

  // Detect market phase from BTC indicators
  const btcInd = indCache['bitcoin'] || {};
  const btcPhase = btcInd.emaAbovePrice ? 'bull' : 'bear';
  const phaseVolumeThreshold = btcPhase === 'bull' ? 1.8 : 1.7;
  const signalSystemPrompt = buildSignalSystem(btcPhase);
  console.log(`[signals] market phase: ${btcPhase} (BTC ${btcInd.emaAbovePrice ? 'above' : 'below'} EMA200)`);

  for (const id of wl.coins) {
    const meta = db.getMeta(id);
    if (!meta || !meta.symbol) continue;
    let ticker;
    try {
      ticker = await binance.fetchTicker(meta.symbol);
      recordConnSuccess('binance');
    } catch (e) {
      console.error(`[signals] ticker failed for ${id}:`, e.message);
      recordConnError('binance', e.message);
      logError('crypto-dashboard', `[signals] ticker ${id}: ${e.message}`);
      continue;
    }
    const rsiEntry  = rsiCache[id];
    const rsi       = rsiEntry ? rsiEntry.rsi : null;
    const price     = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    const i = indCache[id] || {};

    const latestClosed = db.getLastClosedCandleTime(id, '1h');
    const cachedCandle = _lastSignalCandle.get(id);
    if (cachedCandle != null && cachedCandle === latestClosed && signalCache[id]) {
      const updatedAt = new Date().toISOString();
      signalCache[id].updatedAt = updatedAt;
      console.log(`[signals] ${id}: cache hit (candle ${latestClosed}), skipping API call`);
      try {
        const cached = signalCache[id];
        db.insertSignalHistory({
          coin_id:             id,
          timestamp:           updatedAt,
          signal:              cached.signal,
          market_phase:        btcPhase,
          rsi:                 rsi ?? null,
          macd_hist:           i.macd?.histogram ?? null,
          volume_ratio:        i.volumeRatio ?? null,
          price_usd:           price,
          price_gbp:           i.priceGBP ?? null,
          derivatives_context: cached.derivativesContext || null,
          summary:             cached.summary,
        });
      } catch (e) {
        console.warn(`[signals] signal_history insert failed for ${id}:`, e.message);
      }
      continue;
    }
    console.log(`[signals] ${id}: calling API (closed candle ${latestClosed}, prev ${cachedCandle ?? 'none'})`);

    try {
      const prompt = buildWatchlistSignalPrompt(meta, price, change24h, rsi, i, fngStr, phaseVolumeThreshold);

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          system: signalSystemPrompt,
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
      recordConnSuccess('anthropic');
      _lastSignalCandle.set(id, latestClosed);
      const updatedAt = new Date().toISOString();
      signalCache[id] = {
        signal:              parsed.signal,
        summary:             parsed.summary,
        entryQuality:        parsed.entryQuality        || null,
        riskAssessment:      parsed.riskAssessment      || null,
        newsImpact:          parsed.newsImpact          || 'none',
        newsNote:            parsed.newsNote            || null,
        derivativesContext:  parsed.derivativesContext  || null,
        updatedAt,
      };
      try {
        db.insertSignalHistory({
          coin_id:             id,
          timestamp:           updatedAt,
          signal:              parsed.signal,
          market_phase:        btcPhase,
          rsi:                 rsi ?? null,
          macd_hist:           i.macd?.histogram ?? null,
          volume_ratio:        i.volumeRatio ?? null,
          price_usd:           price,
          price_gbp:           i.priceGBP ?? null,
          derivatives_context: parsed.derivativesContext || null,
          summary:             parsed.summary,
        });
      } catch (e) {
        console.warn(`[signals] signal_history insert failed for ${id}:`, e.message);
      }
    } catch (e) {
      console.error(`[signals] ${id}:`, e.message);
      if (e.message.includes('Anthropic')) {
        recordConnError('anthropic', e.message);
        logError('crypto-dashboard', `[signals] anthropic ${id}: ${e.message}`);
      } else {
        logError('crypto-dashboard', `[signals] ${id}: ${e.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  for (const id of Object.keys(signalCache)) {
    if (!wl.coins.includes(id)) delete signalCache[id];
  }
  writeJson(SIGNALS_FILE, signalCache);
  console.log('[signals] updated:', Object.keys(signalCache).map(k => `${k}=${signalCache[k].signal}`).join(', '));
}

function buildScannerPrompt(winner, winnerTier, fng) {
  const fngStr = fng.value != null ? `${fng.value}/100 (${fng.classification})` : 'unavailable';
  const sym = winner.symbol.replace('USDT', '');
  const lines = [
    `Coin: ${sym}`,
    `Price: $${winner.price}`,
    `24h change: ${winner.change24h.toFixed(2)}%`,
    `RSI (14): ${winner.rsi != null ? winner.rsi.toFixed(1) : 'unavailable'}`,
  ];
  if (winner.macd) {
    lines.push(`MACD line: ${winner.macd.macd.toFixed(6)} | Signal: ${winner.macd.signal.toFixed(6)} | Histogram: ${winner.macd.histogram.toFixed(6)}`);
  }
  if (winner.ema50  != null) lines.push(`EMA50: $${winner.ema50.toFixed(4)}`);
  if (winner.ema200 != null) {
    lines.push(`EMA200: $${winner.ema200.toFixed(4)} | Price ${winner.price > winner.ema200 ? 'above' : 'below'} 200 EMA`);
  }
  if (winner.distFromEMA50Pct != null) lines.push(`Distance from EMA50: ${winner.distFromEMA50Pct.toFixed(2)}%`);
  if (winner.volRatio != null) lines.push(`Volume ratio vs 20-period avg: ${winner.volRatio.toFixed(2)}x`);
  const rsDir = winner.relStrength >= 0 ? 'outperforming' : 'underperforming';
  lines.push(`Relative strength vs BTC: ${rsDir} by ${Math.abs(winner.relStrength).toFixed(2)}%`);
  if (winnerTier === 0 && winner.ema200CrossoverAgo != null) {
    lines.push(`200 EMA crossover: ${winner.ema200CrossoverAgo} hour(s) ago`);
  }
  lines.push(`Fear & Greed: ${fngStr}`);
  lines.push('');
  if (winnerTier === 0) {
    lines.push('Context: This coin has been identified as a new riser — price has just crossed above the 200 EMA with volume confirmation and momentum alignment. Frame the signal as an early entry opportunity.');
  } else {
    lines.push('Context: This coin has been identified as a dip-in-uptrend candidate within a confirmed uptrend. Frame the signal as a measured re-entry opportunity.');
  }
  lines.push('');
  lines.push('Respond with valid JSON only, no markdown, no prose:');
  lines.push('{"signal":"buy","summary":"..."} where signal is exactly one of: strong_buy, buy, hold, sell, strong_sell');
  lines.push('Summary: 1-2 plain English sentences referencing specific indicator values.');
  return lines.join('\n');
}

// Remove auto-added coins that are stale (24h+ with no trade, or strong_sell).
// Returns the updated autoAdded list (entries kept).
// Supports both old schema (ftPair) and new schema (krakenPair).
async function autoRemoveStaleCoins(autoAdded) {
  if (!autoAdded || !autoAdded.length) return [];
  const openPairs = await ftGetOpenPairs();
  const signals   = readJson(SIGNALS_FILE, {});
  const now       = Date.now();
  const kept      = [];

  for (const entry of autoAdded) {
    const { coinId, addedAt } = entry;
    // Normalize: support both old `ftPair` field and new `krakenPair` field
    const krakenPair = entry.krakenPair ?? entry.ftPair ?? null;

    // Always keep if Freqtrade has an open trade for this pair
    if (krakenPair && openPairs.has(krakenPair)) { kept.push(entry); continue; }

    const sig     = (signals[coinId] || {}).signal;
    const expired = now - addedAt >= 24 * 60 * 60 * 1000;

    if (!expired && sig !== 'strong_sell') { kept.push(entry); continue; }

    // Remove from cryptodash watchlist + signal cache
    try {
      const wl = readJson(WATCHLIST_FILE, { coins: [] });
      wl.coins = wl.coins.filter(c => c !== coinId);
      writeJson(WATCHLIST_FILE, wl);
      const sigCache = readJson(SIGNALS_FILE, {});
      delete sigCache[coinId];
      writeJson(SIGNALS_FILE, sigCache);
    } catch (e) {
      console.error(`[scanner] watchlist remove failed for ${coinId}:`, e.message);
    }

    // Remove from both config files + reload (only if not a manual coin)
    if (krakenPair && _manualCoins && !_manualCoins.has(krakenPair)) {
      ftConfigRemovePair(krakenPair, FT_CONFIG_FILE, 'Mean Reversion');
      ftConfigRemovePair(krakenPair, FT_TREND_CONFIG_FILE, 'Trend Following');
      await ftReloadBoth();
    }

    const reason = expired ? '24h no trade' : 'signal: strong_sell';
    console.log(`[scanner] Auto-removed ${coinId} from watchlist (${reason})`);
    notifier.notify({ title: 'Scanner', message: `${coinId} removed from watchlist (${reason})` });
  }

  return kept;
}

async function updateScanner() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('[scanner] ANTHROPIC_API_KEY not set'); return; }

  // Read existing state early — needed for autoAdded tracking
  const existing = readJson(SCANNER_FILE, { history: [], autoAdded: [] });

  // Auto-remove stale coins before scan (watchlist affects scanner scope)
  let autoAdded = await autoRemoveStaleCoins(existing.autoAdded || []);

  // Re-add surviving auto-added GBP pairs to both configs (handles FT restarts)
  for (const entry of autoAdded) {
    const krakenPair = entry.krakenPair ?? entry.ftPair ?? null;
    if (krakenPair && _manualCoins && !_manualCoins.has(krakenPair)) {
      ftConfigAddPair(krakenPair, FT_CONFIG_FILE, 'Mean Reversion');
      ftConfigAddPair(krakenPair, FT_TREND_CONFIG_FILE, 'Trend Following');
    }
  }

  // Fetch Kraken GBP pairs (cached 24h) — pre-filter scan universe
  const krakenGBPMap = await getKrakenGBPMap();

  const watchlistSymbols = new Set(db.getAllMeta().map(m => m.symbol).filter(Boolean));
  let result;
  try {
    result = await scanner.runScanner(watchlistSymbols, krakenGBPMap);
  } catch (e) {
    console.error('[scanner] scan failed:', e.message);
    return;
  }

  if (result.winner) {
    console.log(`[scanner] Winner selected: ${result.winner.symbol} tier${result.winnerTier} score=${result.winner.score}`);
  } else {
    console.log('[scanner] No candidates found this run');
  }

  // ── WRITE #1: save winner immediately before any async enrichment ─────────
  // Ensures winner is in scanner.json even if Claude calls fail or hang.
  const history1 = [{ ...result, storedAt: Date.now() }, ...(existing.history || [])].slice(0, 24);
  writeJson(SCANNER_FILE, { autoAdded, latest: result, history: history1, updatedAt: Date.now() });
  console.log('[scanner] Saving winner to scanner.json (pre-enrichment)');

  if (result.winner) {
    const sym        = result.winner.symbol;
    const krakenPair = result.winner.krakenPair; // guaranteed: scan pre-filtered to Kraken GBP pairs
    const baseSymbol = sym.replace(/USDT$/, '');

    // ── Step 1: auto-add to watchlist ─────────────────────────────────────
    let watchlistStatus = 'unknown';
    let coinId = null;
    try {
      coinId = await resolveCoinId(sym);
      if (!coinId) {
        watchlistStatus = 'resolve_failed';
        console.warn(`[scanner] Could not resolve CoinGecko ID for ${sym}`);
      } else {
        result.winner.coinId = coinId;
        const wl = readJson(WATCHLIST_FILE, { coins: [] });
        if (wl.coins.includes(coinId)) {
          watchlistStatus = 'already_watched';
          console.log(`[scanner] ${coinId} already on watchlist`);
        } else {
          wl.coins.push(coinId);
          writeJson(WATCHLIST_FILE, wl);
          seedCoin(coinId).catch(e => console.error(`[seed] ${coinId}:`, e.message));
          console.log(`[scanner] Auto-added ${coinId} to watchlist`);

          // ── Step 2: add GBP pair to config.json ──────────────────────────
          const tierLabel = result.winnerTier === 0 ? 'Tier 0' : 'Tier C';
          const isManual  = _manualCoins && _manualCoins.has(krakenPair);

          if (krakenPair && !isManual) {
            try {
              ftConfigAddPair(krakenPair, FT_CONFIG_FILE, 'Mean Reversion');
              ftConfigAddPair(krakenPair, FT_TREND_CONFIG_FILE, 'Trend Following');
              await ftReloadBoth();
              console.log(`[scanner] Added ${krakenPair} to both Freqtrade configs + reloaded`);
              watchlistStatus = 'auto_added';
              autoAdded.push({
                coinId, symbol: sym, krakenPair,
                addedAt: Date.now(), tier: result.winnerTier, score: result.winner.score,
              });
              notifier.notify({
                title:   'Scanner',
                message: `${baseSymbol} added to watchlist + Freqtrade — ${tierLabel}`,
              });
            } catch (e) {
              console.error(`[scanner] config add ${krakenPair} failed:`, e.message);
              watchlistStatus = 'watchlist_only';
              autoAdded.push({
                coinId, symbol: sym, krakenPair: null,
                addedAt: Date.now(), tier: result.winnerTier, score: result.winner.score,
              });
              notifier.notify({
                title:   'Scanner',
                message: `${baseSymbol} added to watchlist (Freqtrade config update failed)`,
              });
            }
          } else {
            // krakenPair is a manual coin — don't touch config
            watchlistStatus = 'auto_added';
            autoAdded.push({
              coinId, symbol: sym, krakenPair: null,
              addedAt: Date.now(), tier: result.winnerTier, score: result.winner.score,
            });
            console.log(`[scanner] ${krakenPair} is manual — added ${coinId} to watchlist only`);
            notifier.notify({ title: 'Scanner', message: `${baseSymbol} added to watchlist — ${tierLabel}` });
          }
        }
      }
    } catch (e) {
      console.error(`[scanner] auto-add failed for ${sym}:`, e.message);
    }
    result.winner.watchlistStatus = watchlistStatus;

    // ── Step 3: Claude signal ─────────────────────────────────────────────
    console.log('[scanner] Calling Claude for signal analysis...');
    const fng    = readJson(FEARGREED_FILE, {});
    const prompt = buildScannerPrompt(result.winner, result.winnerTier, fng);
    try {
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
      if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
      const body   = await res.json();
      const raw    = body.content[0].text.trim();
      const text   = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(text);
      if (!['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'].includes(parsed.signal))
        throw new Error(`invalid signal: ${parsed.signal}`);
      if (typeof parsed.summary !== 'string') throw new Error('missing summary');
      recordConnSuccess('anthropic');
      result.winner.signal        = parsed.signal;
      result.winner.signalSummary = parsed.summary;
    } catch (e) {
      console.error('[scanner] Claude failed:', e.message);
      recordConnError('anthropic', e.message);
      logError('crypto-dashboard', `[scanner] anthropic: ${e.message}`);
      result.winner.signal        = null;
      result.winner.signalSummary = null;
    }
  }

  // ── WRITE #2: final write with signal + watchlistStatus ──────────────────
  const history2 = [{ ...result, storedAt: Date.now() }, ...(existing.history || [])].slice(0, 24);
  writeJson(SCANNER_FILE, { autoAdded, latest: result, history: history2, updatedAt: Date.now() });

  const winStr = result.winner
    ? `${result.winner.symbol} tier${result.winnerTier} score=${result.winner.score} status=${result.winner.watchlistStatus}`
    : 'no candidates';
  console.log(`[scanner] Complete — ${winStr}`);
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

// ── indicators route ───────────────────────────────────────────────────────────

app.get('/api/indicators', (req, res) => {
  res.json(readJson(INDICATORS_FILE, {}));
});

// ── Fear & Greed route ─────────────────────────────────────────────────────────

app.get('/api/feargreed', (req, res) => {
  res.json(readJson(FEARGREED_FILE, {}));
});

// ── scanner routes ─────────────────────────────────────────────────────────────

app.get('/api/scanner', (req, res) => {
  res.json(readJson(SCANNER_FILE, { latest: null, history: [], updatedAt: null }));
});

app.post('/api/scanner/run', async (req, res) => {
  try {
    await updateScanner();
    res.json(readJson(SCANNER_FILE, {}));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── backtest routes ────────────────────────────────────────────────────────────

app.post('/api/backtest', (req, res) => {
  if (backtestJob.status === 'running') {
    return res.status(409).json({ error: 'backtest already running', jobId: backtestJob.jobId });
  }
  const { coins, days, forwardWindows } = req.body;
  if (!Array.isArray(coins) || !coins.length) return res.status(400).json({ error: 'coins array required' });
  if (!days || days < 1) return res.status(400).json({ error: 'days required' });
  if (!Array.isArray(forwardWindows) || !forwardWindows.length) return res.status(400).json({ error: 'forwardWindows array required' });

  const jobId = Date.now().toString();
  backtestJob = { status: 'running', progress: 0, message: 'Starting…', jobId };
  res.json({ jobId });

  const existingFile = readJson(BACKTEST_FILE, null);
  const previousResult = existingFile?.current || existingFile || null;

  backtest.runBacktest(db, { coins, days, forwardWindows }, (progress, message) => {
    backtestJob.progress = progress;
    backtestJob.message = message;
  }).then(result => {
    writeJson(BACKTEST_FILE, { current: result, previous: previousResult });
    backtestJob = { status: 'done', progress: 100, message: 'Complete', jobId };
    console.log(`[backtest] done — ${result.params.days}d, ${Object.keys(result.coinStats).length} coins`);
  }).catch(e => {
    console.error('[backtest] failed:', e.message);
    backtestJob = { status: 'error', progress: 0, message: e.message, jobId };
  });
});

app.get('/api/backtest/status', (req, res) => {
  res.json(backtestJob);
});

app.get('/api/backtest/results', (req, res) => {
  const data = readJson(BACKTEST_FILE, null);
  if (!data) return res.status(404).json({ error: 'no results' });
  res.json(data);
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

// ── Freqtrade portfolio routes ────────────────────────────────────────────────

const { meanReversionClient, trendClient } = require('./lib/freqtradeClient');

// Helper: fetch standard portfolio bundle from one FT instance
async function ftPortfolioBundle(client) {
  const [profit, status, trades, balance] = await Promise.all([
    client.safeGet('/profit'),
    client.safeGet('/status'),
    client.safeGet('/trades?limit=50'),
    client.safeGet('/balance'),
  ]);
  return { profit, openTrades: status, recentTrades: trades?.trades ?? null, balance };
}

// Mean reversion routes (existing instance, port 8080)
app.get('/api/freqtrade/portfolio', async (req, res) => {
  try { res.json(await ftPortfolioBundle(meanReversionClient)); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/freqtrade/positions', async (req, res) => {
  try { res.json(await meanReversionClient.safeGet('/status') ?? []); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/freqtrade/trades', async (req, res) => {
  try { res.json(await meanReversionClient.safeGet('/trades?limit=20') ?? {}); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/freqtrade/profit', async (req, res) => {
  try { res.json(await meanReversionClient.safeGet('/profit') ?? {}); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/freqtrade/health', async (req, res) => {
  try {
    const data = await meanReversionClient.safeGet('/ping');
    res.json({ ok: data !== null, instance: 'mean_reversion', port: 8080 });
  } catch (e) { res.json({ ok: false, instance: 'mean_reversion', port: 8080 }); }
});

// Trend following routes (new instance, port 8081)
app.get('/api/freqtrade/trend/portfolio', async (req, res) => {
  try { res.json(await ftPortfolioBundle(trendClient)); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/freqtrade/trend/positions', async (req, res) => {
  try { res.json(await trendClient.safeGet('/status') ?? []); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/freqtrade/trend/trades', async (req, res) => {
  try { res.json(await trendClient.safeGet('/trades?limit=20') ?? {}); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/freqtrade/trend/profit', async (req, res) => {
  try { res.json(await trendClient.safeGet('/profit') ?? {}); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/freqtrade/trend/health', async (req, res) => {
  try {
    const data = await trendClient.safeGet('/ping');
    res.json({ ok: data !== null, instance: 'trend', port: 8081 });
  } catch (e) { res.json({ ok: false, instance: 'trend', port: 8081 }); }
});

// Combined view — both instances merged
app.get('/api/freqtrade/combined', async (req, res) => {
  const [mr, tf] = await Promise.all([
    ftPortfolioBundle(meanReversionClient).catch(() => null),
    ftPortfolioBundle(trendClient).catch(() => null),
  ]);

  const totalBalance = (
    (mr?.balance?.total ?? 0) + (tf?.balance?.total ?? 0)
  );

  const mrPL  = mr?.profit?.profit_all_coin ?? null;
  const tfPL  = tf?.profit?.profit_all_coin ?? null;
  const totalPL = mrPL != null && tfPL != null ? mrPL + tfPL : (mrPL ?? tfPL ?? null);

  const mrTrades  = mr?.profit?.trade_count ?? 0;
  const tfTrades  = tf?.profit?.trade_count ?? 0;
  const mrWinRate = mr?.profit?.winrate ?? null;
  const tfWinRate = tf?.profit?.winrate ?? null;

  res.json({
    combined: { totalBalance, totalPL, mrTrades, tfTrades, mrWinRate, tfWinRate },
    meanReversion: mr,
    trend: tf,
  });
});

// ── /api/signal-history & /api/trade-signal-path ──────────────────────────────

app.get('/api/signal-history/:coinId', (req, res) => {
  const { coinId } = req.params;
  const from = req.query.from || '2000-01-01T00:00:00.000Z';
  const to   = req.query.to   || new Date().toISOString();
  try {
    const rows = db.getSignalHistory(coinId, from, to);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trade-signal-path/:bot/:tradeId', (req, res) => {
  const { bot, tradeId } = req.params;
  if (!['mr', 'trend'].includes(bot))
    return res.status(400).json({ error: 'bot must be "mr" or "trend"' });
  const dbPath = bot === 'mr' ? FT_DB_MR : FT_DB_TREND;
  let ftDb;
  try {
    ftDb = new Database(dbPath, { readonly: true });
    const trade = ftDb.prepare(
      `SELECT id, pair, open_date, close_date, open_rate, close_rate,
              close_profit_abs, close_profit, exit_reason, enter_tag, is_open
       FROM trades WHERE id = ?`
    ).get(parseInt(tradeId, 10));
    ftDb.close();
    ftDb = null;
    if (!trade) return res.status(404).json({ error: 'trade not found' });
    const coinId = PAIR_TO_COIN[trade.pair];
    if (!coinId) return res.json({ trade, signalPath: [] });
    // Freqtrade dates stored as "2026-06-20 15:00:09.557049" UTC — convert to ISO 8601
    const toISO = s => s ? s.replace(' ', 'T').replace(/(\.\d{1,3})\d*$/, '$1') + 'Z' : null;
    const from = toISO(trade.open_date);
    const to   = trade.close_date ? toISO(trade.close_date) : new Date().toISOString();
    const signalPath = db.getSignalHistory(coinId, from, to);
    res.json({ trade, signalPath });
  } catch (e) {
    if (ftDb) try { ftDb.close(); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// ── /api/status ───────────────────────────────────────────────────────────────

let _statusCache = null; // { data, at }

// Per-coin: open-time of the last closed 1h candle for which we called Anthropic.
// Resets on service restart (safe — just triggers one fresh call per coin on next candle close).
const _lastSignalCandle = new Map();
const STATUS_CACHE_MS = 15 * 1000;

function execShell(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function getServiceInfo(serviceName) {
  try {
    const out = await execShell('systemctl', [
      'show', serviceName,
      '--property=ActiveState,MainPID,ExecMainStartTimestamp',
      '--no-pager',
    ]);
    if (!out) return { running: false, uptimeSeconds: null, pid: null };
    const state = (out.match(/ActiveState=(.+)/) || [])[1];
    const pid   = parseInt((out.match(/MainPID=(\d+)/) || [])[1]) || null;
    const ts    = (out.match(/ExecMainStartTimestamp=(.+)/) || [])[1];
    const startMs = ts && ts !== '' && ts !== 'n/a' ? new Date(ts).getTime() : null;
    const uptimeSeconds = startMs && !isNaN(startMs) ? Math.floor((Date.now() - startMs) / 1000) : null;
    return { running: state === 'active', uptimeSeconds, pid };
  } catch {
    return { running: false, uptimeSeconds: null, pid: null };
  }
}

async function getDiskInfo() {
  try {
    const out = await execShell('df', ['-BM', '/']);
    if (!out) return null;
    const lines = out.split('\n');
    const parts = lines[1]?.split(/\s+/);
    if (!parts || parts.length < 6) return null;
    const total  = parseInt(parts[1]);
    const used   = parseInt(parts[2]);
    const free   = parseInt(parts[3]);
    const usePct = parseInt(parts[4]);
    return { diskFreeGB: parseFloat((free / 1024).toFixed(1)), diskUsedPercent: usePct, diskTotalGB: parseFloat((total / 1024).toFixed(1)) };
  } catch { return null; }
}

function getCpuTemp() {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
    return parseFloat((parseInt(raw) / 1000).toFixed(1));
  } catch { return null; }
}

app.get('/api/status', async (req, res) => {
  if (_statusCache && Date.now() - _statusCache.at < STATUS_CACHE_MS) {
    return res.json(_statusCache.data);
  }

  const [cdInfo, mrInfo, tfInfo, diskInfo] = await Promise.all([
    getServiceInfo('crypto-dashboard'),
    getServiceInfo('freqtrade'),
    getServiceInfo('freqtrade-trend'),
    getDiskInfo(),
  ]);

  // data freshness
  const signals    = readJson(SIGNALS_FILE, {});
  const indicators = readJson(INDICATORS_FILE, {});
  const scannerD   = readJson(SCANNER_FILE, { latest: null });
  const now = Date.now();

  function freshness(iso) {
    if (!iso) return { timestamp: null, ageMinutes: null };
    const ms = new Date(iso).getTime();
    return { timestamp: iso, ageMinutes: isNaN(ms) ? null : parseFloat(((now - ms) / 60000).toFixed(1)) };
  }

  const latestSignalAt = Object.values(signals).reduce((best, s) => {
    if (!s?.updatedAt) return best;
    return !best || s.updatedAt > best ? s.updatedAt : best;
  }, null);
  const latestIndAt = Object.values(indicators).reduce((best, i) => {
    if (!i?.updatedAt) return best;
    return !best || i.updatedAt > best ? i.updatedAt : best;
  }, null);
  const scannerAt = scannerD.latest?.timestamp ? new Date(scannerD.latest.timestamp).toISOString() : null;

  let derivAt = null;
  try {
    const t = db.getLatestDerivativesTime();
    if (t) derivAt = new Date(t).toISOString();
  } catch {}

  // resources
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const cpuLoad  = os.loadavg()[0]; // 1-min average
  const cpuPct   = parseFloat(Math.min(cpuLoad * 100 / os.cpus().length, 100).toFixed(1));
  const memPct   = parseFloat((usedMem / totalMem * 100).toFixed(1));

  // trading state — read dryRun directly from config files
  let mrDryRun = true, tfDryRun = true;
  try { mrDryRun = JSON.parse(fs.readFileSync(FT_CONFIG_FILE, 'utf8')).dry_run !== false; } catch {}
  try { tfDryRun = JSON.parse(fs.readFileSync(FT_TREND_CONFIG_FILE, 'utf8')).dry_run !== false; } catch {}

  const [mrStatus, tfStatus] = await Promise.all([
    meanReversionClient.safeGet('/status').catch(() => null),
    trendClient.safeGet('/status').catch(() => null),
  ]);
  // /status returns array of open trades
  const mrOpen = Array.isArray(mrStatus) ? mrStatus.length : (mrStatus === null ? null : 0);
  const tfOpen = Array.isArray(tfStatus) ? tfStatus.length : (tfStatus === null ? null : 0);

  // Kraken connectivity: infer from FT reachability
  if (mrStatus !== null || tfStatus !== null) recordConnSuccess('kraken');

  const data = {
    services: {
      cryptodash:    { ...cdInfo },
      meanReversion: { ...mrInfo, dryRun: mrDryRun },
      trendFollowing:{ ...tfInfo, dryRun: tfDryRun },
    },
    dataFreshness: {
      ...freshness(latestSignalAt),
      signalAgeMinutes:      freshness(latestSignalAt).ageMinutes,
      lastSignalUpdate:      latestSignalAt,
      indicatorAgeMinutes:   freshness(latestIndAt).ageMinutes,
      lastIndicatorUpdate:   latestIndAt,
      scannerAgeMinutes:     freshness(scannerAt).ageMinutes,
      lastScannerRun:        scannerAt,
      derivativesAgeMinutes: freshness(derivAt).ageMinutes,
      lastDerivativesWrite:  derivAt,
    },
    connectivity: {
      anthropic: { ..._connState.anthropic },
      binance:   { ..._connState.binance },
      kraken:    { ..._connState.kraken },
      coingecko: { ..._connState.coingecko },
    },
    resources: {
      cpuLoadPercent: cpuPct,
      memoryUsedPercent: memPct,
      ...(diskInfo || {}),
      cpuTempCelsius: getCpuTemp(),
    },
    trading: {
      meanReversion:  { dryRun: mrDryRun, openTrades: mrOpen, maxTrades: 2 },
      trendFollowing: { dryRun: tfDryRun, openTrades: tfOpen, maxTrades: 2 },
    },
    recentErrors: [..._errorLog],
  };

  _statusCache = { data, at: Date.now() };
  res.json(data);
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

// every 15 minutes: fetch new candles → recalc RSI → recalc indicators → update signals
cron.schedule('*/15 * * * *', () => {
  updateCandles()
    .then(() => updateRSI())
    .then(() => updateIndicators())
    .then(() => updateSignals())
    .catch(e => console.error('[cron 15min] unexpected error:', e.message));
});

// every hour: refresh Fear & Greed index
cron.schedule('0 * * * *', () => {
  updateFearGreed().catch(e => console.error('[cron feargreed]', e.message));
});

// every hour at minute 5: run opportunity scanner
cron.schedule('5 * * * *', () => {
  updateScanner().catch(e => console.error('[cron scanner]', e.message));
});

// every 24 hours at midnight: refresh market caps + prune old 1m candles
cron.schedule('0 0 * * *', () => {
  refreshAllMarketCaps().catch(e => console.error('[cron 24h]', e.message));
  try {
    db.pruneCandles('1m', 7 * 24 * 3600 * 1000);
  } catch (e) {
    console.error('[cron prune]', e.message);
  }
  try {
    db.pruneDerivatives(7 * 24 * 3600 * 1000); // keep 7 days of derivatives history
  } catch (e) {
    console.error('[cron prune derivatives]', e.message);
  }
});

// ── start ─────────────────────────────────────────────────────────────────────

db.initDb();
initManualCoins();
app.listen(PORT, () => {
  console.log(`\n  Crypto Dashboard running at http://localhost:${PORT}\n`);
  // seed metadata + backfill candles; start background jobs after
  seedAndBackfill()
    .then(() => {
      setTimeout(() => checkAlerts().catch(() => {}), 2000);
      setTimeout(() => updateCandles().then(() => updateRSI()).then(() => updateIndicators()).then(() => updateSignals()).catch(() => {}), 4000);
      setTimeout(() => updateFearGreed().catch(() => {}), 6000);
      setTimeout(() => updateScanner().catch(() => {}), 10000);
    })
    .catch(e => console.error('[startup]', e.message));
});
