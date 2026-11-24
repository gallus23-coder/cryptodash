'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canActivate, isFailingAutoOffThreshold, applyLifecycleFilter } = require('../src/engine/setupLifecycle');

test('canActivate is false with fewer than 30 trades even if expectancy is strongly positive', () => {
  const trades = Array.from({ length: 10 }, () => ({ r: 2 }));
  assert.equal(canActivate(trades), false);
});

test('canActivate is true with 30+ trades and positive expectancy', () => {
  const trades = Array.from({ length: 30 }, () => ({ r: 0.1 }));
  assert.equal(canActivate(trades), true);
});

test('canActivate is false with 30+ trades but non-positive expectancy', () => {
  const trades = Array.from({ length: 30 }, () => ({ r: -0.1 }));
  assert.equal(canActivate(trades), false);
});

test('isFailingAutoOffThreshold is false with fewer than 30 trades, regardless of how bad they are', () => {
  const trades = Array.from({ length: 10 }, () => ({ r: -5 }));
  assert.equal(isFailingAutoOffThreshold(trades), false);
});

test('isFailingAutoOffThreshold is true when the last 30 trades average below -0.2R', () => {
  const trades = Array.from({ length: 40 }, () => ({ r: -0.3 }));
  assert.equal(isFailingAutoOffThreshold(trades), true);
});

test('isFailingAutoOffThreshold only looks at the LAST 30 trades, not the whole history', () => {
  const badOld = Array.from({ length: 20 }, () => ({ r: -5 }));
  const goodRecent = Array.from({ length: 30 }, () => ({ r: 0.5 }));
  assert.equal(isFailingAutoOffThreshold([...badOld, ...goodRecent]), false);
});

test('applyLifecycleFilter removes an auto_off setup from every regime it appeared in', () => {
  const setupsByRegime = { trend_up: ['trend_breakout', 'trend_pullback'], range: ['range_reversion'], downtrend: [], risk_off: [] };
  const result = applyLifecycleFilter(setupsByRegime, { trend_breakout: 'auto_off', trend_pullback: 'active', range_reversion: 'trial' });
  assert.deepEqual(result.trend_up, ['trend_pullback']);
  assert.deepEqual(result.range, ['range_reversion']); // trial stays — still evaluated for shadow tracking
});
