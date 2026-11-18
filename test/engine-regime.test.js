'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { labelRegime } = require('../src/engine/regime');

function baseMetrics(overrides = {}) {
  return {
    btcAboveEma200: true, ema200SlopeFalling: false, adx: 25, choppiness: 40,
    breadthPct: 70, volatilityRankPct: 50, btc24hChangePct: 0, positioning: null,
    ...overrides,
  };
}

test('risk_off when volatility rank exceeds the 90th percentile', () => {
  const { label } = labelRegime(baseMetrics({ volatilityRankPct: 95 }));
  assert.equal(label, 'risk_off');
});

test('risk_off when BTC has dropped more than 6% in 24h', () => {
  const { label } = labelRegime(baseMetrics({ btc24hChangePct: -7 }));
  assert.equal(label, 'risk_off');
});

test('risk_off wins even when trend_up conditions are also true (first match wins)', () => {
  const { label } = labelRegime(baseMetrics({ volatilityRankPct: 95, btcAboveEma200: true, adx: 30, breadthPct: 80 }));
  assert.equal(label, 'risk_off');
});

test('trend_up when BTC is above EMA200, ADX > 22, and breadth >= 60%', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: true, adx: 23, breadthPct: 60 }));
  assert.equal(label, 'trend_up');
});

test('not trend_up when breadth is just under 60%', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: true, adx: 30, breadthPct: 59 }));
  assert.notEqual(label, 'trend_up');
});

test('downtrend when BTC is below EMA200 and the EMA200 slope is falling', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: false, ema200SlopeFalling: true, breadthPct: 10 }));
  assert.equal(label, 'downtrend');
});

test('range is the fallback when nothing else matches', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: false, ema200SlopeFalling: false, adx: 10, breadthPct: 40 }));
  assert.equal(label, 'range');
});

test('echoes the input metrics back unchanged alongside the label', () => {
  const metrics = baseMetrics();
  const result = labelRegime(metrics);
  assert.deepEqual(result.metrics, metrics);
});
