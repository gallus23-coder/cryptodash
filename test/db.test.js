'use strict';
process.env.DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

db.initDb();

const COIN = 'bitcoin';
const INT  = '1m';
// 6 candles, 60 s apart, starting at t=1_000_000 ms
const BASE = 1000000;
const TC = Array.from({ length: 6 }, (_, i) => ({
  coin_id: COIN, interval: INT,
  time:   BASE + i * 60000,
  open:   100 + i,
  high:   110 + i,
  low:    90  + i,
  close:  105 + i,
  volume: 1000 + i * 100,
}));

test('getLastCandleTime returns null when no candles', () => {
  assert.equal(db.getLastCandleTime(COIN, INT), null);
});

test('insertCandles + getLastCandleTime returns max time', () => {
  db.insertCandles(TC);
  assert.equal(db.getLastCandleTime(COIN, INT), BASE + 5 * 60000);
});

test('getCloses returns all closes oldest-first', () => {
  assert.deepEqual(db.getCloses(COIN, INT, 6), TC.map(c => c.close));
});

test('getCloses limit returns most-recent N oldest-first', () => {
  // limit=3 → last 3 candles (indices 3,4,5), returned oldest-first
  assert.deepEqual(db.getCloses(COIN, INT, 3), TC.slice(3).map(c => c.close));
});

test('getCandles filters by since (inclusive)', () => {
  const since = BASE + 2 * 60000;
  const rows = db.getCandles(COIN, INT, since);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].time, since);
  assert.equal(rows[3].time, BASE + 5 * 60000);
});

test('getAggCandles aggregates into 5-minute buckets', () => {
  // bucketMs=300000 (5 min). Integer division:
  //   BASE=1_000_000 → 1000000/300000=3 → bucket=900000  → candles 0,1,2,3
  //   1_240_000      → 1240000/300000=4 → bucket=1200000 → candles 4,5
  const rows = db.getAggCandles(COIN, INT, 300000, BASE);
  assert.equal(rows.length, 2);

  const [b0, b1] = rows;
  assert.equal(b0.time,   900000);
  assert.equal(b0.open,   TC[0].open);
  assert.equal(b0.close,  TC[3].close);
  assert.equal(b0.high,   Math.max(...TC.slice(0,4).map(c => c.high)));
  assert.equal(b0.low,    Math.min(...TC.slice(0,4).map(c => c.low)));
  assert.equal(b0.volume, TC.slice(0,4).reduce((s,c) => s + c.volume, 0));

  assert.equal(b1.time,  1200000);
  assert.equal(b1.open,  TC[4].open);
  assert.equal(b1.close, TC[5].close);
});

test('getVolumes returns volumes oldest-first, limited to N', () => {
  // TC candles were inserted in earlier test; they have volumes 1000,1100,1200,1300,1400,1500
  const vols = db.getVolumes(COIN, INT, 3);
  assert.equal(vols.length, 3);
  // oldest-first: last 3 by DESC time reversed → indices 3,4,5 → 1300,1400,1500
  assert.equal(vols[0], 1300);
  assert.equal(vols[1], 1400);
  assert.equal(vols[2], 1500);
});

test('getVolumes returns empty array for unknown coin', () => {
  const vols = db.getVolumes('unknown', INT, 10);
  assert.equal(vols.length, 0);
});
