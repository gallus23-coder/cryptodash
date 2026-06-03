'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ind = require('../indicators');

// ── calcEMA ───────────────────────────────────────────────────────────────────

test('calcEMA returns null for insufficient data', () => {
  assert.equal(ind.calcEMA([1, 2, 3], 12), null);
});

test('calcEMA of constant series equals the constant', () => {
  const closes = Array(20).fill(5);
  const result = ind.calcEMA(closes, 12);
  assert.ok(Math.abs(result - 5) < 0.001, `expected ~5, got ${result}`);
});

test('calcEMA exact period length returns SMA', () => {
  // With exactly `period` values, result is the SMA (no smoothing loop runs)
  const closes = [2, 4, 6, 8]; // period=4, SMA=5
  assert.ok(Math.abs(ind.calcEMA(closes, 4) - 5) < 0.001);
});

// ── calcMACD ──────────────────────────────────────────────────────────────────

test('calcMACD returns null for fewer than 35 closes', () => {
  assert.equal(ind.calcMACD(Array(34).fill(100)), null);
});

test('calcMACD returns null for exactly 34 closes', () => {
  assert.equal(ind.calcMACD(Array(34).fill(100)), null);
});

test('calcMACD returns shape for 35+ closes', () => {
  const result = ind.calcMACD(Array(60).fill(100));
  assert.ok(result !== null);
  assert.ok('macd' in result && 'signal' in result && 'histogram' in result);
});

test('calcMACD constant price → macd and signal near zero', () => {
  const result = ind.calcMACD(Array(60).fill(100));
  assert.ok(Math.abs(result.macd) < 0.001);
  assert.ok(Math.abs(result.signal) < 0.001);
  assert.ok(Math.abs(result.histogram) < 0.001);
});

test('calcMACD histogram = macd - signal', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.3) * 5);
  const result = ind.calcMACD(closes);
  assert.ok(Math.abs(result.histogram - (result.macd - result.signal)) < 0.0001);
});

// ── calcBollingerBands ────────────────────────────────────────────────────────

test('calcBollingerBands returns null for fewer than 20 closes', () => {
  assert.equal(ind.calcBollingerBands(Array(19).fill(100)), null);
});

test('calcBollingerBands constant series: all bands equal, bandwidth zero', () => {
  const bb = ind.calcBollingerBands(Array(20).fill(100));
  assert.ok(bb !== null);
  assert.ok(Math.abs(bb.upper - 100) < 0.001);
  assert.ok(Math.abs(bb.middle - 100) < 0.001);
  assert.ok(Math.abs(bb.lower - 100) < 0.001);
  assert.ok(Math.abs(bb.bandwidthPct) < 0.001);
});

test('calcBollingerBands: upper > middle > lower for varying prices', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const bb = ind.calcBollingerBands(closes);
  assert.ok(bb.upper > bb.middle);
  assert.ok(bb.lower < bb.middle);
  assert.ok(bb.bandwidthPct > 0);
});

test('calcBollingerBands uses only last 20 closes', () => {
  // 25 closes: first 5 are extreme outliers — should not affect result
  const closes = [...Array(5).fill(99999), ...Array(20).fill(100)];
  const bb = ind.calcBollingerBands(closes);
  assert.ok(Math.abs(bb.middle - 100) < 0.001);
});

// ── calcVolumeRatio ───────────────────────────────────────────────────────────

test('calcVolumeRatio returns null for fewer than 21 volumes', () => {
  assert.equal(ind.calcVolumeRatio(Array(20).fill(1)), null);
});

test('calcVolumeRatio: current double average returns 2', () => {
  const volumes = [...Array(20).fill(1), 2];
  assert.ok(Math.abs(ind.calcVolumeRatio(volumes) - 2) < 0.001);
});

test('calcVolumeRatio: current equal to average returns 1', () => {
  const volumes = Array(21).fill(5);
  assert.ok(Math.abs(ind.calcVolumeRatio(volumes) - 1) < 0.001);
});

test('calcVolumeRatio returns null when average is zero', () => {
  assert.equal(ind.calcVolumeRatio(Array(21).fill(0)), null);
});

// ── calcStochRSI ──────────────────────────────────────────────────────────────

test('calcStochRSI returns null for fewer than 28 closes', () => {
  assert.equal(ind.calcStochRSI(Array(27).fill(100)), null);
});

test('calcStochRSI returns k and d for 28+ closes', () => {
  const result = ind.calcStochRSI(Array(60).fill(100));
  assert.ok(result !== null);
  assert.ok('k' in result && 'd' in result);
});

test('calcStochRSI k and d are in [0, 100]', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.5) * 10);
  const result = ind.calcStochRSI(closes);
  assert.ok(result.k >= 0 && result.k <= 100, `k=${result.k} out of range`);
  assert.ok(result.d >= 0 && result.d <= 100, `d=${result.d} out of range`);
});
