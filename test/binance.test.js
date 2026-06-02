'use strict';
process.env.DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const binance = require('../binance');

db.initDb();

test('backfillCandles stores rows with correct shape (mocked fetch)', async () => {
  // Binance kline array: [openTime, open, high, low, close, vol, closeTime, quoteVol, ...]
  const mockKline = [
    1700000000000, '50000.00', '51000.00', '49000.00', '50500.00',
    '100', 1700003599999, '5050000.00', 100, '50', '4900000.00', '0',
  ];
  global.fetch = async () => ({ ok: true, json: async () => [mockKline] });

  await binance.backfillCandles('bitcoin', 'BTCUSDT', '1m', 7 * 24 * 3600 * 1000, db);

  const rows = db.getCandles('bitcoin', '1m', 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time,   1700000000000);
  assert.equal(rows[0].open,   50000);
  assert.equal(rows[0].high,   51000);
  assert.equal(rows[0].low,    49000);
  assert.equal(rows[0].close,  50500);
  assert.equal(rows[0].volume, 5050000); // k[7] quoteVolume
});

test('fetchNewCandles with no history falls back to backfill', async () => {
  let callCount = 0;
  global.fetch = async () => { callCount++; return { ok: true, json: async () => [] }; };

  await binance.fetchNewCandles('ethereum', 'ETHUSDT', '1m', db);
  assert.ok(callCount >= 1);
});
