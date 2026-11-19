'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFourHourBoundary, utcDayKey, freshState } = require('../src/scheduler/cycle');

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
});

test('freshState accepts a custom starting balance', () => {
  assert.equal(freshState(500).balance, 500);
});
