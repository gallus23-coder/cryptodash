'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulateEmaEquity, simulateTrendFollowerRealtime, aggregateTrades, zigzag } = require('../scripts/analysis/opportunity');

test('simulateEmaEquity: a single up-day that is also the crossover day must not count (no look-ahead)', () => {
  // Day 4: close=94, ema=95 -> below, signal false. Day 5: close=120, ema=95 -> above, signal
  // true, AND close[5] > close[4] (a big up day). The crossover is only knowable at day 5's
  // own close, so day 5's return must be computed from day 4's decided position (flat), not
  // today's own signal — equity must NOT capture the 94->120 move on the crossover day itself.
  const closes = [90, 91, 92, 93, 94, 120];
  const emaArr = [null, null, null, null, 95, 95];
  const timestamps = [0, 1, 2, 3, 4, 5];

  const { series, trades } = simulateEmaEquity(closes, emaArr, timestamps, 0, 5, 0);

  const lastPoint = series[series.length - 1];
  assert.equal(lastPoint.ts, 5);
  assert.equal(lastPoint.equity, 1, 'equity must be unchanged on the crossover day itself — the up move was never held');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].flippedTo, true);
});

test('simulateEmaEquity: a day AFTER a crossover correctly captures the move', () => {
  const closes = [90, 91, 92, 93, 94, 120, 130];
  const emaArr = [null, null, null, null, 95, 95, 95];
  const timestamps = [0, 1, 2, 3, 4, 5, 6];

  const { series } = simulateEmaEquity(closes, emaArr, timestamps, 0, 6, 0);

  const day5 = series.find((s) => s.ts === 5);
  const day6 = series.find((s) => s.ts === 6);
  assert.equal(day5.equity, 1); // crossover day itself: flat
  assert.equal(day6.equity, 130 / 120); // now holding from day 5's decided (long) position
});

test('simulateEmaEquity deducts the round-trip fee exactly once per flip', () => {
  const closes = [100, 100, 110, 110, 90];
  const emaArr = [null, 100, 100, 100, 100];
  const timestamps = [0, 1, 2, 3, 4];

  const { trades } = simulateEmaEquity(closes, emaArr, timestamps, 0, 4, 1.3);

  // day2: close 110 > ema 100 -> signal flips true -> 1 trade. day4: close 90 < ema 100 -> flips false -> 2nd trade.
  assert.equal(trades.length, 2);
});

test('simulateTrendFollowerRealtime enters on +entry% from the lowest close since the last exit, exits on the trailing stop', () => {
  const bars = [
    { ts: 0, close: 100 },
    { ts: 1, close: 95 }, // new low
    { ts: 2, close: 103 }, // 95 * 1.03 = 97.85 -> entry triggers here
    { ts: 3, close: 110 }, // new high since entry
    { ts: 4, close: 104 }, // 110 * (1-0.05) = 104.5 -> close 104 <= 104.5 -> exit
  ];
  const trades = simulateTrendFollowerRealtime(bars, { entryTriggerPct: 3, trailPct: 5 });

  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryTs, 2);
  assert.equal(trades[0].entryPrice, 103);
  assert.equal(trades[0].exitTs, 4);
  assert.equal(trades[0].exitPrice, 104);
});

test('simulateTrendFollowerRealtime never opens a second position while one is already open', () => {
  const bars = [
    { ts: 0, close: 100 },
    { ts: 1, close: 95 },
    { ts: 2, close: 103 }, // entry
    { ts: 3, close: 150 }, // big move up — must not open a second position
    { ts: 4, close: 149 },
  ];
  const trades = simulateTrendFollowerRealtime(bars, { entryTriggerPct: 3, trailPct: 5 });
  assert.equal(trades.length, 1, 'still open at series end counts as exactly one trade, never a second overlapping one');
  assert.equal(trades[0].stillOpen, true);
});

test('simulateTrendFollowerRealtime respects a filterFn that blocks a would-be entry bar, retrying on the next bar that clears both conditions', () => {
  const bars = [
    { ts: 0, close: 100 },
    { ts: 1, close: 95 },
    { ts: 2, close: 103 }, // would trigger entry, but filter blocks ts=2 specifically
    { ts: 3, close: 110 }, // filter allows this bar; entry trigger (>=97.85) still holds
  ];
  const trades = simulateTrendFollowerRealtime(bars, { entryTriggerPct: 3, trailPct: 5, filterFn: (ts) => ts !== 2 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryTs, 3, 'entry deferred to the next bar where the filter allows it');
  assert.equal(trades[0].entryPrice, 110);
});

test('simulateTrendFollowerRealtime never enters at all if the filter stays false for every remaining bar', () => {
  const bars = [
    { ts: 0, close: 100 },
    { ts: 1, close: 95 },
    { ts: 2, close: 103 },
    { ts: 3, close: 110 },
  ];
  const trades = simulateTrendFollowerRealtime(bars, { entryTriggerPct: 3, trailPct: 5, filterFn: () => false });
  assert.equal(trades.length, 0);
});

test('aggregateTrades reports win rate, avg win/loss, net per trade, and a compounded return', () => {
  const trades = [
    { entryPrice: 100, exitPrice: 110 }, // +10% gross
    { entryPrice: 100, exitPrice: 95 }, // -5% gross
  ];
  const result = aggregateTrades(trades, 1); // 1% round-trip fee

  assert.equal(result.trades, 2);
  assert.equal(result.winRate, 0.5);
  assert.ok(Math.abs(result.avgWinPct - 9) < 1e-9); // 10% - 1% fee
  assert.ok(Math.abs(result.avgLossPct - -6) < 1e-9); // -5% - 1% fee
  assert.ok(Math.abs(result.netPctPerTrade - 1.5) < 1e-9);
  const expectedCompounded = ((1 + 9 / 100) * (1 - 6 / 100) - 1) * 100;
  assert.ok(Math.abs(result.compoundedReturnPct - expectedCompounded) < 1e-9);
});

test('zigzag still confirms a pivot only after the reversal (descriptive use in §2, not traded)', () => {
  const bars = [{ ts: 0, close: 100 }, { ts: 1, close: 90 }, { ts: 2, close: 95 }];
  const pivots = zigzag(bars, 5);
  // The low at ts=1 only confirms once price rises back by >=5% from it (at ts=2) — it is not
  // visible as a confirmed pivot before that bar exists.
  assert.ok(pivots.some((p) => p.ts === 1 && p.kind === 'low'));
});
