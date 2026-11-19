'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeTradeR, computeExpectancy, computeDrawdown } = require('../src/backtest/stats');

test('computeTradeR divides P&L by the amount risked', () => {
  assert.equal(computeTradeR(50, 100), 0.5);
  assert.equal(computeTradeR(-25, 100), -0.25);
});

test('computeExpectancy averages R across trades and reports win rate', () => {
  const trades = [{ r: 1 }, { r: -0.5 }, { r: 2 }, { r: -1 }];
  const result = computeExpectancy(trades);

  assert.equal(result.count, 4);
  assert.equal(result.winRate, 0.5);
  assert.equal(result.expectancy, 0.375); // (1 - 0.5 + 2 - 1) / 4
});

test('computeExpectancy fails the gate with fewer than 30 trades even if expectancy is positive', () => {
  const trades = Array.from({ length: 29 }, () => ({ r: 1 }));
  assert.equal(computeExpectancy(trades).pass, false);
});

test('computeExpectancy fails the gate with 30+ trades if expectancy is not positive', () => {
  const trades = Array.from({ length: 30 }, () => ({ r: 0 }));
  assert.equal(computeExpectancy(trades).pass, false);
});

test('computeExpectancy passes the gate with 30+ trades and positive expectancy', () => {
  const trades = Array.from({ length: 30 }, (_, i) => ({ r: i % 2 === 0 ? 1 : -0.3 }));
  assert.equal(computeExpectancy(trades).pass, true);
});

test('computeExpectancy handles zero trades without dividing by zero', () => {
  assert.deepEqual(computeExpectancy([]), { count: 0, winRate: 0, expectancy: 0, pass: false });
});

test('computeDrawdown tracks the worst peak-to-trough drop as a percentage', () => {
  const result = computeDrawdown([100, 120, 90, 110]); // peak 120, trough 90 -> (120-90)/120 = 0.25
  assert.equal(result.peak, 120);
  assert.equal(result.maxDrawdownPct, 0.25);
});

test('computeDrawdown is zero for a monotonically rising series', () => {
  const result = computeDrawdown([100, 110, 120]);
  assert.equal(result.maxDrawdownPct, 0);
});
