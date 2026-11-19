'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, upsertCandles, getCandles } = require('../src/data/db');
const { ingestCoin } = require('../src/data/ingest');

function seedOneDayOfHourlyCandles(db, coin) {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    coin, timeframe: '1h', ts: i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 1, trades: 1,
  }));
  upsertCandles(db, rows);
}

test('ingestCoin stores new closed candles, excludes the forming one, and rebuilds closed 4h/1d from the trailing window', async () => {
  const db = openDb(':memory:');
  seedOneDayOfHourlyCandles(db, 'BTC');

  const fakeClient = {
    getOhlc: async () => ({
      candles: [
        { time: 86400, open: 100, high: 101, low: 99, close: 100, volume: 1, count: 1, closed: true },
        { time: 90000, open: 100, high: 500, low: 99, close: 100, volume: 1, count: 1, closed: false },
      ],
      last: 86400,
    }),
  };

  const result = await ingestCoin(db, fakeClient, 'BTC', 'XBTGBP', 90000 * 1000);

  assert.equal(result.inserted, 1); // only the closed candle
  assert.equal(result.dropped, 0);
  assert.equal(result.built4h, 6); // day 1's six 4h buckets, all closed by nowTs=90000
  assert.equal(result.built1d, 1); // day 1's one daily bucket

  const stored1h = getCandles(db, 'BTC', '1h', 0, 100000);
  assert.equal(stored1h.length, 25); // 24 seeded + 1 newly ingested
  assert.equal(stored1h.some((c) => c.ts === 90000), false); // forming candle never stored
});

test('ingestCoin drops an outlier candle before storing it', async () => {
  const db = openDb(':memory:');
  const fakeClient = {
    getOhlc: async () => ({
      candles: [
        { time: 0, open: 9300, high: 13000, low: 4.1, close: 4.1, volume: 20, count: 1, closed: true }, // outlier
        { time: 3600, open: 100, high: 101, low: 99, close: 100, volume: 1, count: 1, closed: true },
      ],
      last: 3600,
    }),
  };

  const result = await ingestCoin(db, fakeClient, 'BTC', 'XBTGBP', 7200 * 1000);

  assert.equal(result.inserted, 1);
  assert.equal(result.dropped, 1);
});

test('ingestCoin does not corrupt an already-correct trailing-edge daily candle when the rebuild window is not day-aligned', async () => {
  const db = openDb(':memory:');
  const DAY = 86400;
  // Days 0 and 1, every hour volume=1 — a correctly-built day1 1d candle has volume=24.
  const rows = Array.from({ length: 48 }, (_, i) => ({
    coin: 'BTC', timeframe: '1h', ts: i * 3600, open: 100, high: 100, low: 100, close: 100, volume: 1, trades: 1,
  }));
  upsertCandles(db, rows);
  // Pretend a previous ingestCoin run already correctly built day1's 1d candle.
  upsertCandles(db, [{ coin: 'BTC', timeframe: '1d', ts: DAY, open: 100, high: 100, low: 100, close: 100, volume: 24, trades: 24 }]);

  const fakeClient = {
    getOhlc: async () => ({
      candles: [{ time: 15 * DAY, open: 100, high: 100, low: 100, close: 100, volume: 1, count: 1, closed: false }],
      last: 0,
    }),
  };

  // now = 1 hour into day15. The real 14-day rebuild window reaches back to
  // nowHour - 14*DAY = 1 hour into day1 — not day-aligned, so a naive window
  // would exclude day1's very first hour from the rebuild.
  const now = (15 * DAY + 3600) * 1000;
  await ingestCoin(db, fakeClient, 'BTC', 'XBTGBP', now);

  const day1Candle = getCandles(db, 'BTC', '1d', DAY, DAY)[0];
  assert.equal(day1Candle.volume, 24); // must still be the full day, not truncated to 23
});
