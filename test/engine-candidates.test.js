'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidateId, attachContext } = require('../src/engine/candidates');

test('buildCandidateId formats as c_YYYYMMDD_HH_COIN_setup in UTC', () => {
  const ts = Date.UTC(2026, 10, 18, 10, 0, 0) / 1000; // 2026-11-18 10:00 UTC
  assert.equal(buildCandidateId(ts, 'SOL', 'trend_pullback'), 'c_20261118_10_SOL_trend_pullback');
});

test('buildCandidateId pads single-digit hours and handles month/day boundaries', () => {
  const ts = Date.UTC(2026, 0, 1, 4, 0, 0) / 1000; // 2026-01-01 04:00 UTC
  assert.equal(buildCandidateId(ts, 'BTC', 'oversold_bounce'), 'c_20260101_04_BTC_oversold_bounce');
});

test('attachContext adds rsi14 and adx4h from the indicator arrays at index i', () => {
  const candidate = { coin: 'BTC', setup: 'trend_pullback' };
  const indicators = { rsi14: [null, 47.2], adx14: { adx: [null, 26.1] } };
  const result = attachContext(candidate, indicators, 1);
  assert.deepEqual(result.context, { rsi14: 47.2, adx4h: 26.1 });
  assert.equal(result.coin, 'BTC'); // original fields preserved
});

test('attachContext passes through nulls during indicator warmup without throwing', () => {
  const candidate = { coin: 'BTC', setup: 'trend_pullback' };
  const indicators = { rsi14: [null], adx14: { adx: [null] } };
  const result = attachContext(candidate, indicators, 0);
  assert.deepEqual(result.context, { rsi14: null, adx4h: null });
});
