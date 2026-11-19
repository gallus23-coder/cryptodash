'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine/playbook/trendPullback');

function makeIndicators({ ema20, ema50, rsi14, atr14 }) {
  return { ema20, ema50, rsi14, atr14: atr14 || ema20.map(() => 2) };
}

test('fires when the bar dips to EMA20/50 and closes back above it, with RSI(14) in 40-55', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }]; // low 94 <= ema20 95, close 97 > 95
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48], atr14: [3] });

  const candidate = evaluate('ETH', candles4h, indicators, 0, 'trend_up');

  assert.ok(candidate);
  assert.equal(candidate.setup, 'trend_pullback');
  assert.equal(candidate.entry, 97);
  assert.equal(candidate.atr, 3);
  assert.equal(candidate.default.stopAtr, 1.5);
  assert.equal(candidate.default.trailAtr, 2.5);
});

test('candidate includes a ranges object bounding size/stopAtr/trailAtr', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }];
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48], atr14: [3] });

  const candidate = evaluate('ETH', candles4h, indicators, 0, 'trend_up');

  assert.deepEqual(candidate.ranges, { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] });
});

test('does not fire when RSI(14) is outside the 40-55 band', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }];
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [70] });

  assert.equal(evaluate('ETH', candles4h, indicators, 0, 'trend_up'), null);
});

test('does not fire when the bar never touched EMA20 or EMA50', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 98, close: 99 }]; // low 98 > both EMAs
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48] });

  assert.equal(evaluate('ETH', candles4h, indicators, 0, 'trend_up'), null);
});

test('does not fire when the close stays below BOTH EMAs (no bounce, just a breakdown)', () => {
  // close=89 is below min(ema20=95, ema50=90) — a genuine break of the whole pullback zone,
  // not just a dip to one EMA that held above the other.
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 88, close: 89 }];
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48] });

  assert.equal(evaluate('ETH', candles4h, indicators, 0, 'trend_up'), null);
});

test('does not fire outside trend_up regime', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 97 }];
  const indicators = makeIndicators({ ema20: [95], ema50: [90], rsi14: [48] });

  assert.equal(evaluate('ETH', candles4h, indicators, 0, 'range'), null);
});
