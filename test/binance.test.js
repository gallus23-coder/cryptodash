'use strict';
process.env.DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const binance = require('../binance');

db.initDb();

test('backfillCandles stores rows with correct shape (mocked fetch)', async () => {
  const originalFetch = global.fetch;
  try {
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
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchNewCandles with no history falls back to backfill', async () => {
  const originalFetch = global.fetch;
  try {
    let callCount = 0;
    global.fetch = async () => { callCount++; return { ok: true, json: async () => [] }; };

    await binance.fetchNewCandles('ethereum', 'ETHUSDT', '1m', db);
    assert.equal(callCount, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchNewCandles incremental path fetches from lastTime+1 and stores new candle', async () => {
  const originalFetch = global.fetch;
  try {
    // Insert a candle for 'solana' so getLastCandleTime returns a non-null time.
    const lastTime = 1700100000000;
    db.insertCandles([{
      coin_id: 'solana', interval: '1h',
      time: lastTime, open: 100, high: 110, low: 90, close: 105, volume: 999,
    }]);

    // Confirm getLastCandleTime sees it.
    assert.equal(db.getLastCandleTime('solana', '1h'), lastTime);

    // New kline returned by the incremental fetch.
    const newTime = lastTime + 3600000;
    const newKline = [
      newTime, '106.00', '112.00', '104.00', '110.00',
      '200', newTime + 3599999, '21200.00', 150, '100', '11000.00', '0',
    ];

    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => [newKline] };
    };

    await binance.fetchNewCandles('solana', 'SOLUSDT', '1h', db);

    // Verify the URL included startTime = lastTime + 1.
    assert.ok(capturedUrl !== null, 'fetch should have been called');
    assert.ok(
      capturedUrl.includes(`startTime=${lastTime + 1}`),
      `Expected URL to contain startTime=${lastTime + 1}, got: ${capturedUrl}`,
    );

    // Verify the new candle was stored.
    const rows = db.getCandles('solana', '1h', newTime);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].time,  newTime);
    assert.equal(rows[0].close, 110);
  } finally {
    global.fetch = originalFetch;
  }
});
