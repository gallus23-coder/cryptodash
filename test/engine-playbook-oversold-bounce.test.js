'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine/playbook/oversoldBounce');

function makeCandles4hWith3DayFall() {
  // 18 bars = 3 days of 4h bars, falling, then the signal bar closes even lower.
  const candles = [];
  for (let i = 0; i <= 18; i += 1) {
    const price = 100 - i; // steadily falling
    candles.push({ ts: i, open: price + 1, high: price + 1, low: price - 1, close: price });
  }
  return candles;
}

test('fires when RSI(2)<5 on a 4h close after a 3-day fall, in downtrend', () => {
  const candles4h = makeCandles4hWith3DayFall();
  const rsi2 = new Array(candles4h.length).fill(50);
  rsi2[18] = 3;
  const ema20 = new Array(candles4h.length).fill(90);
  const atr14 = new Array(candles4h.length).fill(2.5);

  const candidate = evaluate('ADA', candles4h, { rsi2, ema20, atr14 }, 18, 'downtrend');

  assert.ok(candidate);
  assert.equal(candidate.setup, 'oversold_bounce');
  assert.equal(candidate.atr, 2.5);
  assert.equal(candidate.default.size, 0.5); // half size max, per design
  assert.equal(candidate.default.stopAtr, 1.0);
  assert.equal(candidate.exitType, 'ema_cross_or_time');
  assert.equal(candidate.emaPeriod, 20);
  assert.equal(candidate.timeStopHours, 12);
});

test('candidate includes a ranges object bounding size/stopAtr (no trailAtr for this exit type)', () => {
  const candles4h = makeCandles4hWith3DayFall();
  const rsi2 = new Array(candles4h.length).fill(50);
  rsi2[18] = 3;
  const ema20 = new Array(candles4h.length).fill(90);
  const atr14 = new Array(candles4h.length).fill(2.5);

  const candidate = evaluate('ADA', candles4h, { rsi2, ema20, atr14 }, 18, 'downtrend');

  assert.deepEqual(candidate.ranges, { size: [0, 0.5], stopAtr: [0.5, 2.0] });
});

test('does not fire when RSI(2) is 5 or above', () => {
  const candles4h = makeCandles4hWith3DayFall();
  const rsi2 = new Array(candles4h.length).fill(50);
  rsi2[18] = 5;
  const ema20 = new Array(candles4h.length).fill(90);

  assert.equal(evaluate('ADA', candles4h, { rsi2, ema20 }, 18, 'downtrend'), null);
});

test('does not fire when there has not actually been a 3-day fall', () => {
  const candles4h = makeCandles4hWith3DayFall().map((c, i) => ({ ...c, close: 100 + i })); // rising, not falling
  const rsi2 = new Array(candles4h.length).fill(3);
  const ema20 = new Array(candles4h.length).fill(90);

  assert.equal(evaluate('ADA', candles4h, { rsi2, ema20 }, 18, 'downtrend'), null);
});

test('does not fire outside downtrend regime', () => {
  const candles4h = makeCandles4hWith3DayFall();
  const rsi2 = new Array(candles4h.length).fill(50);
  rsi2[18] = 3;
  const ema20 = new Array(candles4h.length).fill(90);

  assert.equal(evaluate('ADA', candles4h, { rsi2, ema20 }, 18, 'range'), null);
});

test('does not fire before 18 bars (3 days) of history exist', () => {
  const candles4h = makeCandles4hWith3DayFall().slice(0, 10);
  const rsi2 = new Array(candles4h.length).fill(3);
  const ema20 = new Array(candles4h.length).fill(90);

  assert.equal(evaluate('ADA', candles4h, { rsi2, ema20 }, 9, 'downtrend'), null);
});
