'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFourHourBoundary, utcDayKey, freshState, persistCycleResults, selectBroker } = require('../src/scheduler/cycle');
const { openDb, getTrades, loadSchedulerState } = require('../src/data/db');

test('isFourHourBoundary is true exactly at 00/04/08/12/16/20 UTC', () => {
  const HOUR = 3600;
  assert.equal(isFourHourBoundary(0), true);
  assert.equal(isFourHourBoundary(4 * HOUR), true);
  assert.equal(isFourHourBoundary(20 * HOUR), true);
  assert.equal(isFourHourBoundary(24 * HOUR), true); // next day's 00:00
});

test('isFourHourBoundary is false at any other hour', () => {
  const HOUR = 3600;
  assert.equal(isFourHourBoundary(1 * HOUR), false);
  assert.equal(isFourHourBoundary(14 * HOUR), false);
});

test('utcDayKey groups all timestamps within the same UTC day', () => {
  const DAY = 86400;
  assert.equal(utcDayKey(0), 0);
  assert.equal(utcDayKey(DAY - 1), 0);
  assert.equal(utcDayKey(DAY), 1);
});

test('freshState defaults to a £1000 starting balance with no open positions', () => {
  const state = freshState();
  assert.equal(state.balance, 1000);
  assert.equal(state.weeklyPeakBalance, 1000);
  assert.deepEqual(state.openPositions, []);
  assert.deepEqual(state.cooldowns, {});
  assert.equal(state.killSwitchActive, false);
  assert.equal(state.pausedByOperator, false);
});

test('freshState accepts a custom starting balance', () => {
  assert.equal(freshState(500).balance, 500);
});

test('persistCycleResults rolls back all trade inserts if a later one fails, so trades and scheduler_state stay consistent', () => {
  const db = openDb(':memory:');
  const state = freshState();
  state.closedTrades = [
    { coin: 'BTC', setup: 'trend_pullback', entryTs: 0, exitTs: 3600, entryPrice: 100, exitPrice: 110, units: 1, riskAmount: 5, pnl: 10, r: 2, exitReason: 'target' },
    { setup: 'trend_pullback', entryTs: 3600, exitTs: 7200, entryPrice: 100, exitPrice: 90, units: 1, riskAmount: 5, pnl: -10, r: -2, exitReason: 'stop' }, // missing `coin` — throws on insert
  ];

  assert.throws(() => persistCycleResults(db, 'paper', state));

  assert.equal(getTrades(db, 'paper').length, 0); // first trade's insert must not survive the second's failure
  assert.equal(loadSchedulerState(db, 'paper'), null); // state must never be saved if the drain didn't fully commit
});

test('selectBroker returns the real live broker module for mode "live" and the real paper broker module for mode "paper"', () => {
  const liveBroker = require('../src/broker/live');
  const paperBroker = require('../src/broker/paper');
  assert.equal(selectBroker('live'), liveBroker);
  assert.equal(selectBroker('paper'), paperBroker);
});

test('selectBroker honors injected overrides, for testability', () => {
  const fakeLive = { marker: 'fake-live' };
  const fakePaper = { marker: 'fake-paper' };
  assert.equal(selectBroker('live', { liveBroker: fakeLive, paperBroker: fakePaper }), fakeLive);
  assert.equal(selectBroker('paper', { liveBroker: fakeLive, paperBroker: fakePaper }), fakePaper);
});
