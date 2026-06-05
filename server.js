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
const ind       = require('./indicators');
const feargreed = require('./feargreed');
const scanner   = require('./scanner');
const backtest  = require('./backtest');

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
const SCANNER_FILE    = path.join(DATA_DIR, 'scanner.json');
const BACKTEST_FILE   = path.join(DATA_DIR, 'backtest.json');

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

async function updateIndicators() {
  const wl = readJson(WATCHLIST_FILE, { coins: [] });
  if (!wl.coins.length) return;
  const cache = {};
  for (const id of wl.coins) {
    const closes  = db.getCloses(id, '1h', 300);
    const volumes = db.getVolumes(id, '1h', 21);
    const ohlc    = db.getOHLCLimit(id, '1h', 14);
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
    cache[id] = {
      macd, bb, ema50, ema200, emaAbovePrice, goldenCross, deathCross,
      stochRsi, volumeRatio, atr14, atr14Pct, updatedAt: new Date().toISOString(),
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

const WATCHLIST_SIGNAL_SYSTEM = `You are a systematic crypto trading assistant. Your only job is to evaluate whether a coin currently meets the criteria for our exact trading strategy and report that evaluation as structured JSON.

STRATEGY: Mean Reversion in Uptrend
Entry criteria (ALL must be met for a buy signal):
  1. Price above EMA200 (confirmed uptrend)
  2. RSI between 25 and 45 (pulled back from overbought)
  3. Price within 5% of EMA50 (near mean)
  4. MACD line > 0 (macro momentum positive)
  5. Stochastic RSI %K below 30 (oversold on fast oscillator)
  6. Volume ratio >= 1.2x 20-period average (participation confirming move)

Risk parameters:
  - Stop loss: 5% below entry
  - Take profit: 10% above entry
  - Time stop: exit if target not reached within 72 hours

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
    "stopLossNote": "<one sentence on ATR vs 5% stop>",
    "takeProfitReachable": <true|false>,
    "takeProfitNote": "<one sentence on momentum towards 10% target>",
    "timeStopRisk": "<low|medium|high>",
    "timeStopNote": "<one sentence on likelihood of resolving within 72h>"
  },
  "newsImpact": "<none|minor|major>",
  "newsNote": "<one sentence if newsImpact is minor or major, else null>"
}`;

function buildWatchlistSignalPrompt(meta, price, change24h, rsi, i, fngStr) {
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
    const vrLabel = i.volumeRatio >= 1.2 ? 'above 1.2x — entry requirement met' : 'below 1.2x — entry requirement NOT met';
    lines.push(`Volume ratio vs 20-period avg: ${i.volumeRatio.toFixed(2)}x (${vrLabel})`);
  }
  if (i.atr14 != null) {
    const atrPct = i.atr14Pct != null ? ` (${i.atr14Pct.toFixed(2)}% of price)` : '';
    lines.push(`ATR-14 (1h): $${i.atr14.toFixed(4)}${atrPct}`);
  }
  lines.push(`Fear & Greed: ${fngStr}`);
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
    const rsiEntry  = rsiCache[id];
    const rsi       = rsiEntry ? rsiEntry.rsi : null;
    const price     = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    const i = indCache[id] || {};
    try {
      const prompt = buildWatchlistSignalPrompt(meta, price, change24h, rsi, i, fngStr);

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
          system: WATCHLIST_SIGNAL_SYSTEM,
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
      signalCache[id] = {
        signal:          parsed.signal,
        summary:         parsed.summary,
        entryQuality:    parsed.entryQuality    || null,
        riskAssessment:  parsed.riskAssessment  || null,
        newsImpact:      parsed.newsImpact      || 'none',
        newsNote:        parsed.newsNote        || null,
        updatedAt: new Date().toISOString(),
      };
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

async function updateScanner() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('[scanner] ANTHROPIC_API_KEY not set'); return; }

  const watchlistSymbols = new Set(db.getAllMeta().map(m => m.symbol).filter(Boolean));
  let result;
  try {
    result = await scanner.runScanner(watchlistSymbols);
  } catch (e) {
    console.error('[scanner] scan failed:', e.message);
    return;
  }

  if (result.winner) {
    const fng = readJson(FEARGREED_FILE, {});
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
      result.winner.signal        = parsed.signal;
      result.winner.signalSummary = parsed.summary;
    } catch (e) {
      console.error('[scanner] Claude failed:', e.message);
    }
  }

  const existing = readJson(SCANNER_FILE, { history: [] });
  const history  = [{ ...result, storedAt: Date.now() }, ...(existing.history || [])].slice(0, 24);
  writeJson(SCANNER_FILE, { latest: result, history, updatedAt: Date.now() });

  const winStr = result.winner
    ? `${result.winner.symbol} tier${result.winnerTier} score=${result.winner.score}`
    : 'no candidates';
  console.log(`[scanner] ${winStr}`);
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
});

// ── start ─────────────────────────────────────────────────────────────────────

db.initDb();
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
