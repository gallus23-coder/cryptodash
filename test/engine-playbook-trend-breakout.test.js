'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine/playbook/trendBreakout');

function makeIndicators({ donchianUpper, adx, atr14 }) {
  return {
    donchian20: { upper: donchianUpper, lower: [] }, adx14: { adx },
    atr14: atr14 || donchianUpper.map(() => 2),
  };
}

test('fires when close breaks above the PRIOR bar\'s 20-bar high and ADX is rising', () => {
  // donchianUpper[i-1]=100 and donchianUpper[i]=110 are deliberately different —
  // close=105 is above the prior value but below the current one, so this fixture
  // only fires under the correct "exclude current bar" rule, not the buggy one.
  const candles4h = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1, open: 100, high: 106, low: 99, close: 105 },
  ];
  const indicators = makeIndicators({ donchianUpper: [100, 110], adx: [20, 25], atr14: [2, 3] });

  const candidate = evaluate('BTC', candles4h, indicators, 1, 'trend_up');

  assert.ok(candidate);
  assert.equal(candidate.coin, 'BTC');
  assert.equal(candidate.setup, 'trend_breakout');
  assert.equal(candidate.entry, 105);
  assert.equal(candidate.atr, 3);
  assert.equal(candidate.default.stopAtr, 2.0);
  assert.equal(candidate.default.trailAtr, 2.5);
  assert.equal(candidate.exitType, 'trailing_stop');
});

test('does not fire when close is below the prior 20-bar high', () => {
  const candles4h = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1, open: 100, high: 103, low: 99, close: 101 }, // below prior high of 102
  ];
  const indicators = makeIndicators({ donchianUpper: [102, 103], adx: [20, 25] });

  assert.equal(evaluate('BTC', candles4h, indicators, 1, 'trend_up'), null);
});

test('does not fire when ADX is falling even if price breaks out', () => {
  const candles4h = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1, open: 100, high: 106, low: 99, close: 105 },
  ];
  const indicators = makeIndicators({ donchianUpper: [102, 104], adx: [25, 20] }); // ADX falling

  assert.equal(evaluate('BTC', candles4h, indicators, 1, 'trend_up'), null);
});

test('does not fire outside trend_up regime', () => {
  const candles4h = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1, open: 100, high: 106, low: 99, close: 105 },
  ];
  const indicators = makeIndicators({ donchianUpper: [102, 104], adx: [20, 25] });

  assert.equal(evaluate('BTC', candles4h, indicators, 1, 'range'), null);
});

test('does not fire when there is no prior bar\'s Donchian value yet (warm-up)', () => {
  const candles4h = [{ ts: 0, open: 100, high: 106, low: 99, close: 105 }];
  const indicators = makeIndicators({ donchianUpper: [null], adx: [25] });

  assert.equal(evaluate('BTC', candles4h, indicators, 0, 'trend_up'), null);
});
