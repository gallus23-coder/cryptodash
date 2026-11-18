'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sizePosition, checkFeeViability } = require('../src/engine/risk');

test('sizePosition risks exactly riskPct of balance, sized by stop distance', () => {
  // balance=10000, risk 0.5% = 50. entry=100, stop=98 (2% stop distance = 2 per unit).
  // units = riskAmount / stopDistancePerUnit = 50 / 2 = 25. stakeValue = 25*100 = 2500.
  const result = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 98 });

  assert.equal(result.riskAmount, 50);
  assert.equal(result.units, 25);
  assert.equal(result.stakeValue, 2500);
});

test('sizePosition scales down for a wider stop (more distance, fewer units for the same risk)', () => {
  const tight = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 98 });
  const wide = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 90 });

  assert.ok(wide.units < tight.units, `expected a wider stop to produce fewer units: ${wide.units} vs ${tight.units}`);
  assert.equal(wide.riskAmount, tight.riskAmount); // same £ risked either way
});

test('checkFeeViability passes when ATR% is at least 4x the round-trip fee', () => {
  assert.equal(checkFeeViability({ atrPct: 2.6, roundTripFeePct: 0.65 }), true); // 2.6 = 4*0.65 exactly
  assert.equal(checkFeeViability({ atrPct: 3, roundTripFeePct: 0.65 }), true);
});

test('checkFeeViability fails when ATR% is below 4x the round-trip fee', () => {
  assert.equal(checkFeeViability({ atrPct: 2, roundTripFeePct: 0.65 }), false);
});
