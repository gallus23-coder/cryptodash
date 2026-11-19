'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SETUPS, SETUPS_BY_REGIME } = require('../src/engine/playbook');

test('SETUPS contains all four setups, each with an evaluate function', () => {
  assert.deepEqual(Object.keys(SETUPS).sort(), ['oversold_bounce', 'range_reversion', 'trend_breakout', 'trend_pullback']);
  for (const setup of Object.values(SETUPS)) assert.equal(typeof setup.evaluate, 'function');
});

test('every setup named in SETUPS_BY_REGIME exists in SETUPS', () => {
  for (const names of Object.values(SETUPS_BY_REGIME)) {
    for (const name of names) assert.ok(SETUPS[name], `${name} referenced in SETUPS_BY_REGIME but missing from SETUPS`);
  }
});

test('risk_off allows no setups; trend_up allows exactly the two trend setups', () => {
  assert.deepEqual(SETUPS_BY_REGIME.risk_off, []);
  assert.deepEqual(SETUPS_BY_REGIME.trend_up.sort(), ['trend_breakout', 'trend_pullback']);
});
