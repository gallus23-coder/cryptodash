'use strict';

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] - prev) * multiplier + prev;
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gainSum += delta;
    else lossSum += -delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function trueRange(curr, prev) {
  if (!prev) return curr.high - curr.low;
  return Math.max(
    curr.high - curr.low,
    Math.abs(curr.high - prev.close),
    Math.abs(curr.low - prev.close),
  );
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length === 0) return out;
  const trs = candles.map((c, i) => trueRange(c, i > 0 ? candles[i - 1] : null));
  out[0] = trs[0];
  if (candles.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += trs[i];
  let prevAtr = sum / period;
  out[period - 1] = prevAtr;
  for (let i = period; i < candles.length; i += 1) {
    prevAtr = (prevAtr * (period - 1) + trs[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

function adx(candles, period = 14) {
  const n = candles.length;
  const adxOut = new Array(n).fill(null);
  const plusDIOut = new Array(n).fill(null);
  const minusDIOut = new Array(n).fill(null);
  if (n < period + 1) return { adx: adxOut, plusDI: plusDIOut, minusDI: minusDIOut };

  const trs = [0];
  const plusDMs = [0];
  const minusDMs = [0];
  for (let i = 1; i < n; i += 1) {
    trs.push(trueRange(candles[i], candles[i - 1]));
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let trSum = 0, plusDMSum = 0, minusDMSum = 0;
  for (let i = 1; i <= period; i += 1) {
    trSum += trs[i]; plusDMSum += plusDMs[i]; minusDMSum += minusDMs[i];
  }

  const dxValues = new Array(n).fill(null);
  const setDI = (i, smoothedTR, smoothedPlusDM, smoothedMinusDM) => {
    const plusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
    const minusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;
    plusDIOut[i] = plusDI;
    minusDIOut[i] = minusDI;
    const diSum = plusDI + minusDI;
    dxValues[i] = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
  };

  setDI(period, trSum, plusDMSum, minusDMSum);
  let smoothedTR = trSum, smoothedPlusDM = plusDMSum, smoothedMinusDM = minusDMSum;
  for (let i = period + 1; i < n; i += 1) {
    smoothedTR = smoothedTR - smoothedTR / period + trs[i];
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDMs[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDMs[i];
    setDI(i, smoothedTR, smoothedPlusDM, smoothedMinusDM);
  }

  if (n >= period * 2) {
    let dxSum = 0;
    for (let i = period; i < period * 2; i += 1) dxSum += dxValues[i];
    let prevAdx = dxSum / period;
    adxOut[period * 2 - 1] = prevAdx;
    for (let i = period * 2; i < n; i += 1) {
      prevAdx = (prevAdx * (period - 1) + dxValues[i]) / period;
      adxOut[i] = prevAdx;
    }
  }

  return { adx: adxOut, plusDI: plusDIOut, minusDI: minusDIOut };
}

function choppiness(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  const trs = candles.map((c, i) => trueRange(c, i > 0 ? candles[i - 1] : null));
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const trSum = trs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    const highestHigh = Math.max(...window.map((c) => c.high));
    const lowestLow = Math.min(...window.map((c) => c.low));
    const range = highestHigh - lowestLow;
    out[i] = range === 0 ? 0 : (100 * Math.log10(trSum / range)) / Math.log10(period);
  }
  return out;
}

function bollinger(values, period = 20, mult = 2) {
  const middle = new Array(values.length).fill(null);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const stddev = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + mult * stddev;
    lower[i] = mean - mult * stddev;
  }
  return { middle, upper, lower };
}

function donchian(candles, period = 20) {
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    upper[i] = Math.max(...window.map((c) => c.high));
    lower[i] = Math.min(...window.map((c) => c.low));
  }
  return { upper, lower };
}

module.exports = { ema, rsi, atr, adx, choppiness, bollinger, donchian };
