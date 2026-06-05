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
    if (i >= 26) {
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
  return avg20 === 0 ? null : volumes[volumes.length - 1] / avg20;
}

// ATR-14 (simplified): average of (high - low) over last 14 candles.
// candles: array of {high, low, close} oldest-first, needs >= 14 entries.
function calcATR(candles, period = 14) {
  if (candles.length < period) return null;
  const last = candles.slice(-period);
  return last.reduce((sum, c) => sum + (c.high - c.low), 0) / period;
}

module.exports = { calcEMA, calcMACD, calcBollingerBands, calcStochRSI, calcVolumeRatio, calcATR };
