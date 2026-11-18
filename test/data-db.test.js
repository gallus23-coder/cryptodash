'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, upsertCandles, getCandles, getLastCandleTime, getExistingTimes } = require('../src/data/db');

function freshDb() {
  return openDb(':memory:');
}

test('getLastCandleTime returns null when no candles exist', () => {
  const db = freshDb();
  assert.equal(getLastCandleTime(db, 'BTC', '1h'), null);
});

test('upsertCandles inserts rows and getCandles reads them back in order', () => {
  const db = freshDb();
  const rows = [
    { coin: 'BTC', timeframe: '1h', ts: 2000, open: 2, high: 3, low: 1, close: 2.5, volume: 10, trades: 5 },
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 8, trades: 3 },
  ];

  const count = upsertCandles(db, rows);

  assert.equal(count, 2);
  const result = getCandles(db, 'BTC', '1h', 0, 3000);
  assert.deepEqual(result.map((r) => r.ts), [1000, 2000]);
  assert.equal(result[0].close, 1.5);
  assert.equal(getLastCandleTime(db, 'BTC', '1h'), 2000);
});

test('upsertCandles is idempotent: re-inserting the same ts updates instead of duplicating', () => {
  const db = freshDb();
  upsertCandles(db, [{ coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 8, trades: 3 }]);
  upsertCandles(db, [{ coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2.5, low: 0.5, close: 1.9, volume: 9, trades: 4 }]);

  const result = getCandles(db, 'BTC', '1h', 0, 3000);

  assert.equal(result.length, 1);
  assert.equal(result[0].close, 1.9);
  assert.equal(result[0].volume, 9);
});

test('candles are isolated per coin and per timeframe', () => {
  const db = freshDb();
  upsertCandles(db, [
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: 1 },
    { coin: 'ETH', timeframe: '1h', ts: 1000, open: 2, high: 2, low: 2, close: 2, volume: 2, trades: 2 },
    { coin: 'BTC', timeframe: '4h', ts: 1000, open: 3, high: 3, low: 3, close: 3, volume: 3, trades: 3 },
  ]);

  assert.equal(getCandles(db, 'BTC', '1h', 0, 3000).length, 1);
  assert.equal(getCandles(db, 'BTC', '1h', 0, 3000)[0].close, 1);
  assert.equal(getCandles(db, 'ETH', '1h', 0, 3000)[0].close, 2);
  assert.equal(getCandles(db, 'BTC', '4h', 0, 3000)[0].close, 3);
});

test('getExistingTimes returns just the ts column in range, ascending', () => {
  const db = freshDb();
  upsertCandles(db, [
    { coin: 'BTC', timeframe: '1h', ts: 3000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
    { coin: 'BTC', timeframe: '1h', ts: 5000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
  ]);

  assert.deepEqual(getExistingTimes(db, 'BTC', '1h', 0, 4000), [1000, 3000]);
});
