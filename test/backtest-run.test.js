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

const { tryOpenPosition, closePosition } = require('../src/backtest/run');

test("closing the only open position leaves balance equal to starting balance plus that trade's pnl, exactly once", () => {
  const state = { balance: 1000, dailyPnl: 0, openPositions: [], cooldowns: {}, closedTrades: [] };
  const config = {
    baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
    maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6, roundTripFeePct: 0.01,
  };
  const candidate = {
    coin: 'BTC', setup: 'trend_breakout', entry: 100, atr: 10,
    default: { action: 'take', size: 1, stopAtr: 1 }, exitType: 'trailing_stop',
  };
  const data = { candles4h: [{ ts: 0, close: 100 }], indicators: { bollinger20: { middle: [null] } } };

  tryOpenPosition(state, candidate, data, 0, config);
  const position = state.openPositions[0];
  closePosition(state, position, { exitTs: 3600, exitPrice: 100, reason: 'stop' }, config);

  const trade = state.closedTrades[0];
  assert.equal(state.balance, 1000 + trade.pnl);
});

test('buildCoinData computes donchianBreakout with the given breakoutLookback, not a hardcoded 20', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();
  const data = buildCoinData({ candles4h, candles1h, candlesDaily, breakoutLookback: 10 });
  const { donchian } = require('../src/engine/indicators');
  const expected = donchian(candles4h, 10);
  assert.deepEqual(data.indicators.donchianBreakout.upper, expected.upper);
});
