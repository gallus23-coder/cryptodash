'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETUP_PARAMS, SETUP_PARAM_BOUNDS, clampSetupParams, resolveSetupParams } = require('../src/engine/setupParams');

test('DEFAULT_SETUP_PARAMS matches today\'s hardcoded setup values', () => {
  assert.deepEqual(DEFAULT_SETUP_PARAMS.trend_pullback, { rsiMin: 40, rsiMax: 55, defaultStopAtr: 1.5, defaultTrailAtr: 2.5 });
  assert.deepEqual(DEFAULT_SETUP_PARAMS.trend_breakout, { lookback: 20, defaultStopAtr: 2.0, defaultTrailAtr: 3.0 });
  assert.deepEqual(DEFAULT_SETUP_PARAMS.range_reversion, { rsi2Max: 10, defaultStopAtr: 1.5, timeStopHours: 24 });
  assert.deepEqual(DEFAULT_SETUP_PARAMS.oversold_bounce, { rsi2Max: 5, lookbackBars: 18, defaultStopAtr: 1.0, timeStopHours: 12 });
});

test('clampSetupParams clamps a value above its bound down to the max', () => {
  const clamped = clampSetupParams('trend_breakout', { lookback: 999, defaultStopAtr: 2.0, defaultTrailAtr: 3.0 });
  assert.equal(clamped.lookback, SETUP_PARAM_BOUNDS.trend_breakout.lookback[1]);
});

test('clampSetupParams clamps a value below its bound up to the min', () => {
  const clamped = clampSetupParams('oversold_bounce', { rsi2Max: -5, lookbackBars: 18, defaultStopAtr: 1.0, timeStopHours: 12 });
  assert.equal(clamped.rsi2Max, SETUP_PARAM_BOUNDS.oversold_bounce.rsi2Max[0]);
});

test('clampSetupParams fills in any missing key with its default before clamping', () => {
  const clamped = clampSetupParams('range_reversion', {});
  assert.deepEqual(clamped, DEFAULT_SETUP_PARAMS.range_reversion);
});

test('clampSetupParams never leaves trend_pullback\'s rsiMin >= rsiMax, even if both are independently in-bounds but inverted', () => {
  const clamped = clampSetupParams('trend_pullback', { rsiMin: 55, rsiMax: 50, defaultStopAtr: 1.5, defaultTrailAtr: 2.5 });
  assert.ok(clamped.rsiMin < clamped.rsiMax);
});

test('resolveSetupParams returns clamped defaults for every setup when no override is given', () => {
  const resolved = resolveSetupParams();
  assert.deepEqual(resolved.trend_pullback, DEFAULT_SETUP_PARAMS.trend_pullback);
  assert.deepEqual(resolved.oversold_bounce, DEFAULT_SETUP_PARAMS.oversold_bounce);
});

test('resolveSetupParams merges a partial override for one setup without touching the others', () => {
  const resolved = resolveSetupParams({ trend_breakout: { lookback: 30 } });
  assert.equal(resolved.trend_breakout.lookback, 30);
  assert.equal(resolved.trend_breakout.defaultStopAtr, DEFAULT_SETUP_PARAMS.trend_breakout.defaultStopAtr);
  assert.deepEqual(resolved.range_reversion, DEFAULT_SETUP_PARAMS.range_reversion);
});
