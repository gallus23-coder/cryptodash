'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ema, rsi } = require('../src/engine/indicators');

test('ema seeds with an SMA then applies the standard multiplier', () => {
  // period=3 over [1,2,3,4,5,6,7]: seed = mean(1,2,3) = 2, multiplier = 2/(3+1) = 0.5
  // ema[3] = (4-2)*0.5+2 = 3; ema[4] = (5-3)*0.5+3 = 4; ema[5]=5; ema[6]=6
  const result = ema([1, 2, 3, 4, 5, 6, 7], 3);
  assert.deepEqual(result, [null, null, 2, 3, 4, 5, 6]);
});

test('ema returns all nulls when there is not enough data', () => {
  assert.deepEqual(ema([1, 2], 3), [null, null]);
});

test('rsi is exactly 100 when every change is a gain (no losses at all)', () => {
  const values = Array.from({ length: 20 }, (_, i) => 100 + i); // strictly increasing
  const result = rsi(values, 14);
  assert.equal(result[14], 100);
  assert.equal(result[19], 100);
});

test('rsi is exactly 0 when every change is a loss (no gains at all)', () => {
  const values = Array.from({ length: 20 }, (_, i) => 100 - i); // strictly decreasing
  const result = rsi(values, 14);
  assert.equal(result[14], 0);
});

test('rsi is 50 when price never moves at all (zero gain and zero loss)', () => {
  const values = Array.from({ length: 20 }, () => 100);
  const result = rsi(values, 14);
  assert.equal(result[14], 50);
});

test('rsi returns null before period+1 values are available', () => {
  const result = rsi([100, 101, 102], 14);
  assert.deepEqual(result, [null, null, null]);
});

const { atr, adx } = require('../src/engine/indicators');

test('atr converges to the constant true range of a perfectly steady series', () => {
  // high-low=2 every bar, close always mid-range, so TR=2 on every bar.
  const candles = Array.from({ length: 20 }, (_, i) => ({ high: 101 + i, low: 99 + i, close: 100 + i }));
  const result = atr(candles, 14);
  assert.equal(result[13], 2);
  assert.equal(result[19], 2);
});

test('atr is never negative or NaN even with gaps between bars', () => {
  const candles = [
    { high: 100, low: 98, close: 99 },
    { high: 110, low: 108, close: 109 }, // gapped up — TR driven by |high-prevClose|
  ];
  const result = atr(candles, 1);
  assert.ok(Number.isFinite(result[1]));
  assert.ok(result[1] > 0);
});

test('adx shows +DI clearly above -DI for a consistently trending-up series', () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    high: 100 + i * 2, low: 99 + i * 2, close: 99.5 + i * 2,
  }));
  const { adx: adxSeries, plusDI, minusDI } = adx(candles, 14);
  const lastIdx = candles.length - 1;
  assert.ok(plusDI[lastIdx] > minusDI[lastIdx], `expected +DI > -DI, got ${plusDI[lastIdx]} vs ${minusDI[lastIdx]}`);
  assert.ok(adxSeries[lastIdx] > 20, `expected a trending ADX reading, got ${adxSeries[lastIdx]}`);
});

test('adx stays low and finite for a perfectly flat series (no directional movement)', () => {
  const candles = Array.from({ length: 30 }, () => ({ high: 100, low: 100, close: 100 }));
  const { adx: adxSeries } = adx(candles, 14);
  const lastIdx = candles.length - 1;
  assert.ok(Number.isFinite(adxSeries[lastIdx]));
  assert.ok(adxSeries[lastIdx] < 10, `expected a near-zero ADX for a flat series, got ${adxSeries[lastIdx]}`);
});

const { choppiness, bollinger, donchian } = require('../src/engine/indicators');

test('choppiness is lower for a strong trend than for a sideways chop over the same span', () => {
  const trending = Array.from({ length: 20 }, (_, i) => ({ high: 101 + i, low: 100 + i, close: 100.5 + i }));
  const choppy = Array.from({ length: 20 }, (_, i) => {
    const base = 100 + (i % 2 === 0 ? 1 : -1); // oscillates, net movement near zero
    return { high: base + 1, low: base - 1, close: base };
  });
  const trendCI = choppiness(trending, 14)[19];
  const choppyCI = choppiness(choppy, 14)[19];
  assert.ok(trendCI >= 0 && trendCI <= 100);
  assert.ok(choppyCI >= 0 && choppyCI <= 100);
  assert.ok(trendCI < choppyCI, `expected trending CI (${trendCI}) < choppy CI (${choppyCI})`);
});

test('bollinger matches the textbook population-stddev example: [2,4,4,4,5,5,7,9], period 8', () => {
  // mean=5, population variance=4, stddev=2 (classic stats textbook example)
  const result = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  assert.equal(result.middle[7], 5);
  assert.equal(result.upper[7], 9);
  assert.equal(result.lower[7], 1);
});

test('bollinger has zero band width when every value in the window is identical', () => {
  const result = bollinger([10, 10, 10, 10], 4, 2);
  assert.equal(result.middle[3], 10);
  assert.equal(result.upper[3], 10);
  assert.equal(result.lower[3], 10);
});

test('donchian tracks the rolling highest-high and lowest-low over the period', () => {
  const candles = [
    { high: 10, low: 5 }, { high: 12, low: 6 }, { high: 8, low: 4 }, { high: 15, low: 9 },
  ];
  const result = donchian(candles, 3);
  // window for index 3 is candles[1..3]: highs {12,8,15} low-s {6,4,9}
  assert.equal(result.upper[3], 15);
  assert.equal(result.lower[3], 4);
  assert.equal(result.upper[1], null); // not enough data yet (needs 3 bars)
});
