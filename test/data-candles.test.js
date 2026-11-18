'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOhlcvtCsv } = require('../src/data/candles');

test('parseOhlcvtCsv parses timestamp,open,high,low,close,volume,trades rows with no header', () => {
  const csv = [
    '1700000000,100.1,101.5,99.8,100.9,12.34,7',
    '1700003600,100.9,102.0,100.5,101.8,9.5,4',
  ].join('\n');

  const { rows, skipped } = parseOhlcvtCsv(csv);

  assert.equal(skipped, 0);
  assert.deepEqual(rows, [
    { ts: 1700000000, open: 100.1, high: 101.5, low: 99.8, close: 100.9, volume: 12.34, trades: 7 },
    { ts: 1700003600, open: 100.9, high: 102.0, low: 100.5, close: 101.8, volume: 9.5, trades: 4 },
  ]);
});

test('parseOhlcvtCsv skips malformed lines and reports how many were skipped', () => {
  const csv = [
    '1700000000,100.1,101.5,99.8,100.9,12.34,7',
    'not,a,valid,row',
    '1700003600,100.9,102.0,100.5,101.8,9.5,4',
    '',
  ].join('\n');

  const { rows, skipped } = parseOhlcvtCsv(csv);

  assert.equal(rows.length, 2);
  assert.equal(skipped, 1);
});

test('parseOhlcvtCsv skips a row with a blank field instead of inserting 0', () => {
  const csv = '1700000000,1,2,3,,5,6\n';

  const { rows, skipped } = parseOhlcvtCsv(csv);

  assert.equal(rows.length, 0);
  assert.equal(skipped, 1);
});

test('parseOhlcvtCsv returns an empty result for an empty string', () => {
  assert.deepEqual(parseOhlcvtCsv(''), { rows: [], skipped: 0 });
});

const { aggregateCandles } = require('../src/data/candles');

test('aggregateCandles builds one 4h bucket from four 1h candles aligned to UTC', () => {
  // 1970-01-01T00:00:00Z is itself a 4h boundary, so epoch-second bucketing
  // naturally aligns to 00/04/08/12/16/20 UTC without extra calendar math.
  const hour = 3600;
  const candles1h = [0, 1, 2, 3].map((i) => ({
    ts: i * hour, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 1, trades: 2,
  }));

  const result = aggregateCandles(candles1h, 4 * hour);

  assert.equal(result.length, 1);
  const bucket = result[0];
  assert.equal(bucket.ts, 0);
  assert.equal(bucket.open, 10); // first child's open
  assert.equal(bucket.close, 13.5); // last child's close
  assert.equal(bucket.high, 14); // max of the four highs
  assert.equal(bucket.low, 9); // min of the four lows
  assert.equal(bucket.volume, 4);
  assert.equal(bucket.trades, 8);
  assert.equal(bucket.closed, true); // bucket ends at 4h, last child ends at 4h too
});

test('aggregateCandles marks the newest bucket unclosed if the clock has not passed its end yet', () => {
  const hour = 3600;
  // Only 2 of the 4 hours a full 4h bucket would need have arrived so far.
  const candles1h = [0, 1].map((i) => ({
    ts: i * hour, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: 1,
  }));

  const result = aggregateCandles(candles1h, 4 * hour);

  assert.equal(result.length, 1);
  assert.equal(result[0].closed, false);
});

test('aggregateCandles still closes a sparse bucket (fewer than 4 child rows) once time has passed it', () => {
  const hour = 3600;
  // Only hour 0 traded (a real gap, not zero-filled) but hour 5 has already arrived,
  // meaning the clock is well past the first 4h bucket's end at hour 4.
  const candles1h = [
    { ts: 0, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: 1 },
    { ts: 5 * hour, open: 20, high: 21, low: 19, close: 20.5, volume: 1, trades: 1 },
  ];

  const result = aggregateCandles(candles1h, 4 * hour);

  const firstBucket = result.find((b) => b.ts === 0);
  assert.equal(firstBucket.closed, true);
  assert.equal(firstBucket.trades, 1); // only the one child row that actually traded
});

test('aggregateCandles treats a null trades value as contagious only when every child is null', () => {
  const hour = 3600;
  const candles1h = [
    { ts: 0, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: null },
    { ts: hour, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: null },
    { ts: 2 * hour, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: null },
    { ts: 3 * hour, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: null },
  ];

  const result = aggregateCandles(candles1h, 4 * hour);

  assert.equal(result[0].trades, null);
});

test('aggregateCandles closes the trailing bucket when an explicit nowTs has clearly passed its end, even if the last child row is older due to a gap', () => {
  const hour = 3600;
  // Hour 0 traded; hours 1-3 are a real no-trade gap. Without a clock reference,
  // lastChildTs=0 would make the [0,4h) bucket look "not yet closed".
  const candles1h = [{ ts: 0, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: 1 }];

  const result = aggregateCandles(candles1h, 4 * hour, { nowTs: 10 * hour });

  assert.equal(result[0].closed, true);
});

test('aggregateCandles without an explicit nowTs falls back to the default last-child-based closedness (unchanged)', () => {
  const hour = 3600;
  const candles1h = [{ ts: 0, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: 1 }];

  const result = aggregateCandles(candles1h, 4 * hour);

  assert.equal(result[0].closed, false);
});

const { findGapHours } = require('../src/data/candles');

test('findGapHours returns every expected step when nothing exists', () => {
  const hour = 3600;
  assert.deepEqual(findGapHours([], 0, 2 * hour, hour), [0, hour, 2 * hour]);
});

test('findGapHours returns nothing when every step is present', () => {
  const hour = 3600;
  assert.deepEqual(findGapHours([0, hour, 2 * hour], 0, 2 * hour, hour), []);
});

test('findGapHours reports only the missing steps, honoring real no-trade gaps', () => {
  const hour = 3600;
  // Hour 1 genuinely has no candle (e.g. a thin pair with zero trades that hour).
  const existing = [0, 2 * hour, 3 * hour];
  assert.deepEqual(findGapHours(existing, 0, 3 * hour, hour), [hour]);
});

const { buildCandlesFromTrades } = require('../src/data/candles');

test('buildCandlesFromTrades buckets trades into hourly OHLCV, dropping the trailing partial hour', () => {
  const hour = 3600;
  const trades = [
    { price: 100, volume: 1, time: 0 },
    { price: 102, volume: 2, time: 1800 },
    { price: 101, volume: 1, time: 3599 }, // completes hour 0: [0, 3600)
    { price: 105, volume: 1, time: hour },
    { price: 106, volume: 1, time: hour + 10 }, // completes hour 1: [3600, 7200)
    { price: 999, volume: 1, time: 2 * hour }, // starts hour 2 — trailing, not fully in range
  ];

  const result = buildCandlesFromTrades(trades, 2 * hour); // range covers through hour 1's close exactly

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    ts: 0, open: 100, high: 102, low: 100, close: 101, volume: 4, trades: 3, closed: true,
  });
  assert.deepEqual(result[1], {
    ts: hour, open: 105, high: 106, low: 105, close: 106, volume: 2, trades: 2, closed: true,
  });
});

test('buildCandlesFromTrades returns nothing for an empty trades list', () => {
  assert.deepEqual(buildCandlesFromTrades([], 10000), []);
});
