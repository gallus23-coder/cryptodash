'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine/playbook/rangeReversion');

function makeIndicators({ bollingerLower, bollingerMiddle, rsi2, dailyEma200Aligned, atr14 }) {
  return {
    bollinger20: { lower: bollingerLower, middle: bollingerMiddle }, rsi2, dailyEma200Aligned,
    atr14: atr14 || bollingerLower.map(() => 2),
  };
}

test('fires when close is below the lower Bollinger band, RSI(2)<10, and price is above daily EMA200', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [80], atr14: [4] });

  const candidate = evaluate('SOL', candles4h, indicators, 0, 'range');

  assert.ok(candidate);
  assert.equal(candidate.setup, 'range_reversion');
  assert.equal(candidate.entry, 95);
  assert.equal(candidate.atr, 4);
  assert.equal(candidate.default.stopAtr, 1.5);
  assert.equal(candidate.exitType, 'target_or_time');
  assert.equal(candidate.targetType, 'bollinger_middle');
  assert.equal(candidate.timeStopHours, 24);
});

test('does not fire when close is above the lower Bollinger band', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 98 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [80] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'range'), null);
});

test('does not fire when RSI(2) is 10 or above', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [10], dailyEma200Aligned: [80] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'range'), null);
});

test('does not fire when price is below its own daily EMA200 (not a real reversion-in-uptrend setup)', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [120] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'range'), null);
});

test('does not fire outside range regime', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [80] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'trend_up'), null);
});

test('does not fire when the daily EMA200 is not yet available (warm-up)', () => {
  const candles4h = [{ ts: 0, open: 100, high: 101, low: 94, close: 95 }];
  const indicators = makeIndicators({ bollingerLower: [96], bollingerMiddle: [100], rsi2: [5], dailyEma200Aligned: [null] });

  assert.equal(evaluate('SOL', candles4h, indicators, 0, 'range'), null);
});
