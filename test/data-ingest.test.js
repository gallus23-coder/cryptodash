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
