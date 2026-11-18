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
