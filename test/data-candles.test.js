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

test('parseOhlcvtCsv returns an empty result for an empty string', () => {
  assert.deepEqual(parseOhlcvtCsv(''), { rows: [], skipped: 0 });
});
