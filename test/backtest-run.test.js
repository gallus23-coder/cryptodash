'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCoinData } = require('../src/backtest/run');

function makeFixture() {
  const DAY = 24 * 3600, FOUR_H = 4 * 3600;
  const candlesDaily = Array.from({ length: 230 }, (_, i) => ({ ts: i * DAY, close: 100 + i * 0.1 }));
  const candles4h = Array.from({ length: 230 * 6 }, (_, i) => {
    const price = 100 + i * 0.02;
    return { ts: i * FOUR_H, open: price, high: price + 1, low: price - 1, close: price };
  });
  const candles1h = Array.from({ length: 230 * 24 }, (_, i) => {
    const price = 100 + i * (0.02 / 4);
    return { ts: i * 3600, open: price, high: price + 0.5, low: price - 0.5, close: price };
  });
  return { candles4h, candles1h, candlesDaily };
}

test('buildCoinData returns one indicator value per 4h candle, with dailyEma200Aligned look-ahead-safe', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();

  const data = buildCoinData({ candles4h, candles1h, candlesDaily });

  assert.equal(data.indicators.ema20.length, candles4h.length);
  assert.equal(data.indicators.dailyEma200Aligned.length, candles4h.length);
  assert.equal(data.indicators.adx14.adx.length, candles4h.length);
  // Well past warm-up (the fixture has 230 days / 1380 4h-bars), everything should be populated.
  const lastIdx = candles4h.length - 1;
  assert.ok(data.indicators.ema20[lastIdx] !== null);
  assert.ok(data.indicators.dailyEma200Aligned[lastIdx] !== null);
});

test('buildCoinData builds ema20By4hTs keyed by each 4h candle\'s own ts, skipping warm-up nulls', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();

  const data = buildCoinData({ candles4h, candles1h, candlesDaily });

  assert.equal(data.ema20By4hTs.size, candles4h.length - 19); // ema20 needs 20 bars, so 19 are null
  const lastBar = candles4h[candles4h.length - 1];
  assert.equal(data.ema20By4hTs.get(lastBar.ts), data.indicators.ema20[candles4h.length - 1]);
  assert.equal(data.ema20By4hTs.has(candles4h[0].ts), false); // index 0 is warm-up, should be skipped
});
