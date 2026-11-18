'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRestClient } = require('../src/kraken/rest');

const client = createRestClient({});

test('getServerTime returns a plausible unixtime', async () => {
  const { unixtime } = await client.getServerTime();
  const nowSec = Date.now() / 1000;
  assert.ok(Math.abs(unixtime - nowSec) < 120, `server time ${unixtime} too far from local time ${nowSec}`);
});

test('getOhlc for XBT/GBP returns closed candles older than the forming one', async () => {
  const { candles, last } = await client.getOhlc('XXBTZGBP', { interval: 60 });
  assert.ok(candles.length > 1);
  assert.equal(candles[candles.length - 1].closed, false);
  assert.equal(candles[0].closed, true);
  assert.ok(typeof last === 'number');
});

test('getTicker for XBT/GBP returns a bid/ask', async () => {
  const result = await client.getTicker(['XXBTZGBP']);
  const ticker = result.XXBTZGBP;
  assert.ok(Number(ticker.a[0]) > 0);
  assert.ok(Number(ticker.b[0]) > 0);
});
