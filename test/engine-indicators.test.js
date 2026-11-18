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
