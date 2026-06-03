// scanner.js
'use strict';

const { calcMACD } = require('./indicators');

const BINANCE_API = 'https://api.binance.com';

// ── indicator helpers ─────────────────────────────────────────────────────────

// Wilder RSI-14 (mirrors _calcRSI14 in indicators.js)
function calcRSI14(closes) {
  if (closes.length < 15) return null;
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

// EMA array aligned with closes. result[i] = EMA using closes[0..i]; null if i < period-1.
function calcEMAAligned(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// Returns candles-ago (1 = most recent candle) at which price crossed above ema200,
// or -1 if no crossover found within lookback.
function findUpCrossover(closes, ema200, lookback) {
  const n = closes.length;
  for (let off = 1; off <= lookback; off++) {
    const i = n - off;
    if (i < 1 || ema200[i] === null || ema200[i - 1] === null) continue;
    if (closes[i] > ema200[i] && closes[i - 1] < ema200[i - 1]) return off;
  }
  return -1;
}

// True if any entry in series[j] crossed above threshold (series[j]>threshold && series[j-1]<threshold)
// within the last `window` entries.
function crossedAbove(series, threshold, window) {
  const n = series.length;
  for (let off = 1; off <= window; off++) {
    const j = n - off;
    if (j < 1) continue;
    if (series[j] !== null && series[j - 1] !== null &&
        series[j] > threshold && series[j - 1] < threshold) return true;
  }
  return false;
}

// ── Binance helpers ───────────────────────────────────────────────────────────

async function fetchAllTickers() {
  const res = await fetch(`${BINANCE_API}/api/v3/ticker/24hr`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  return res.json();
}

async function fetchKlines(symbol) {
  const res = await fetch(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=1h&limit=250`);
  if (!res.ok) throw new Error(`Klines ${symbol} ${res.status}`);
  const raw = await res.json();
  return raw.map(k => ({ close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
}

// ── candidate builder ─────────────────────────────────────────────────────────

function buildCandidate(candles, ticker, btcChange24h) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const n = closes.length;

  const ema200 = calcEMAAligned(closes, 200);
  const ema50  = calcEMAAligned(closes, 50);

  const currentPrice  = closes[n - 1];
  const currentEMA200 = ema200[n - 1];
  const currentEMA50  = ema50[n - 1];
  const rsi  = calcRSI14(closes);
  const macd = calcMACD(closes);

  // RSI series for last 6 candle endpoints (for crossover detection over last 5)
  const rsiSeries = [];
  for (let len = n - 5; len <= n; len++) {
    rsiSeries.push(len >= 15 ? calcRSI14(closes.slice(0, len)) : null);
  }

  // MACD line series for last 6 candle endpoints
  const macdLineSeries = [];
  for (let len = n - 5; len <= n; len++) {
    const m = len >= 35 ? calcMACD(closes.slice(0, len)) : null;
    macdLineSeries.push(m ? m.macd : null);
  }

  // Volume ratio: last candle vs average of prior 20
  const vol20avg = volumes.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = vol20avg > 0 ? volumes[n - 1] / vol20avg : null;

  // Relative strength vs BTC
  const relStrength = ticker.change24h - btcChange24h;

  // EMA200 price crossover in last 5 candles
  const ema200CrossoverAgo = findUpCrossover(closes, ema200, 5);

  // Volume conviction at crossover candle vs 20-period avg before it
  let crossoverVolRatio = null;
  if (ema200CrossoverAgo !== -1) {
    const ci = n - ema200CrossoverAgo;
    if (ci >= 20) {
      const avgBefore = volumes.slice(ci - 20, ci).reduce((a, b) => a + b, 0) / 20;
      crossoverVolRatio = avgBefore > 0 ? volumes[ci] / avgBefore : null;
    }
  }

  // Count candles below EMA200 in last 35
  let belowEMA200Count = 0;
  for (let i = Math.max(0, n - 35); i < n; i++) {
    if (ema200[i] !== null && closes[i] < ema200[i]) belowEMA200Count++;
  }

  const distFromEMA50Pct = currentEMA50
    ? Math.abs(currentPrice - currentEMA50) / currentEMA50 * 100
    : null;

  return {
    symbol: ticker.symbol,
    price: currentPrice,
    change24h: ticker.change24h,
    rsi,
    macd,
    ema50: currentEMA50,
    ema200: currentEMA200,
    volRatio,
    relStrength,
    distFromEMA50Pct,
    ema200CrossoverAgo,
    crossoverVolRatio,
    belowEMA200Count,
    rsiCrossed50:    crossedAbove(rsiSeries, 50, 5),
    macdCrossedZero: crossedAbove(macdLineSeries, 0, 5),
  };
}

// ── tier filters ──────────────────────────────────────────────────────────────

function isTier0(c) {
  return (
    c.ema200 !== null &&
    c.belowEMA200Count >= 30 &&
    c.ema200CrossoverAgo !== -1 &&
    c.rsiCrossed50 &&
    c.crossoverVolRatio !== null && c.crossoverVolRatio >= 2 &&
    c.macdCrossedZero &&
    c.relStrength > 0
  );
}

function isTierC(c) {
  if (c.ema200 === null || c.ema50 === null || c.rsi === null || c.macd === null) return false;
  return (
    c.price > c.ema200 &&
    c.rsi >= 30 && c.rsi <= 45 &&
    c.macd.macd > 0 &&
    c.distFromEMA50Pct !== null && c.distFromEMA50Pct <= 5 &&
    c.relStrength >= -1
  );
}

// ── scoring ───────────────────────────────────────────────────────────────────

function applyTier0Scores(candidates) {
  const maxHistogram = Math.max(
    ...candidates.map(c => c.macd ? Math.max(0, c.macd.histogram) : 0),
    0.000001
  );
  return candidates.map(c => {
    // Recency: 1 candle ago = 25 pts, 5 candles ago = 5 pts, linear (30 - 5*offset)
    const recency = Math.max(5, 30 - 5 * c.ema200CrossoverAgo);
    // Volume conviction: 2x avg = 5 pts, 5x avg = 25 pts
    const volume  = Math.min(25, Math.max(0, 5 + (c.crossoverVolRatio - 2) * (20 / 3)));
    // MACD momentum: normalised histogram
    const histogram = c.macd ? Math.max(0, c.macd.histogram) : 0;
    const macdScore = Math.min(25, (histogram / maxHistogram) * 25);
    // Relative strength: 0% = 0 pts, 5%+ = 25 pts
    const rs = Math.min(25, Math.max(0, c.relStrength * 5));
    const total = recency + volume + macdScore + rs;
    return {
      ...c, tier: 0, score: Math.round(total),
      scoreBreakdown: {
        recency:     Math.round(recency),
        volume:      Math.round(volume),
        macd:        Math.round(macdScore),
        relStrength: Math.round(rs),
      },
    };
  }).sort((a, b) => b.score - a.score);
}

function applyTierCScores(candidates) {
  const maxMACD = Math.max(
    ...candidates.map(c => c.macd ? Math.max(0, c.macd.macd) : 0),
    0.000001
  );
  return candidates.map(c => {
    // RSI: 30 = 40 pts, 45 = 0, linear
    const rsiScore = Math.max(0, (45 - c.rsi) / 15 * 40);
    // EMA50 proximity: within 1% = 30 pts, at 5% = 0
    const emaScore = Math.max(0, (5 - c.distFromEMA50Pct) / 4 * 30);
    // MACD above zero: normalised
    const macdVal   = c.macd ? Math.max(0, c.macd.macd) : 0;
    const macdScore = Math.min(30, (macdVal / maxMACD) * 30);
    const total = rsiScore + emaScore + macdScore;
    return {
      ...c, tier: 'C', score: Math.round(total),
      scoreBreakdown: {
        rsi:  Math.round(rsiScore),
        ema50: Math.round(emaScore),
        macd: Math.round(macdScore),
      },
    };
  }).sort((a, b) => b.score - a.score);
}

// ── main entry point ──────────────────────────────────────────────────────────

async function runScanner(watchlistSymbols) {
  const allTickers = await fetchAllTickers();

  const btcTicker = allTickers.find(t => t.symbol === 'BTCUSDT');
  const btcChange24h = btcTicker ? parseFloat(btcTicker.priceChangePercent) : 0;

  const top100 = allTickers
    .filter(t => t.symbol.endsWith('USDT') && !watchlistSymbols.has(t.symbol))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 100)
    .map(t => ({
      symbol:    t.symbol,
      price:     parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent),
    }));

  const candidates = [];
  for (const ticker of top100) {
    try {
      const candles = await fetchKlines(ticker.symbol);
      if (candles.length < 210) continue;
      candidates.push(buildCandidate(candles, ticker, btcChange24h));
    } catch (_) { /* skip coin on error */ }
    await new Promise(r => setTimeout(r, 50));
  }

  const tier0Raw = candidates.filter(isTier0);
  const tierCRaw = candidates.filter(isTierC);

  const tier0Scored = tier0Raw.length ? applyTier0Scores(tier0Raw) : [];
  const tierCScored = tierCRaw.length ? applyTierCScores(tierCRaw) : [];

  let winner = null, winnerTier = null;
  let otherTier0 = [], otherTierC = [];

  if (tier0Scored.length) {
    [winner, ...otherTier0] = tier0Scored;
    winnerTier = 0;
    otherTierC = tierCScored;
  } else if (tierCScored.length) {
    [winner, ...otherTierC] = tierCScored;
    winnerTier = 'C';
  }

  const slim = c => ({ symbol: c.symbol, score: c.score, scoreBreakdown: c.scoreBreakdown, tier: c.tier });

  return {
    timestamp: Date.now(),
    btcChange24h,
    winnerTier,
    winner,
    otherTier0: otherTier0.map(slim),
    otherTierC: otherTierC.map(slim),
  };
}

module.exports = { runScanner };
