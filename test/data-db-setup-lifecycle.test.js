'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, getSetupLifecycle, getAllSetupLifecycles, setSetupLifecycleStatus } = require('../src/data/db');

test('getSetupLifecycle defaults to trial with no statusTs when nothing is stored', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getSetupLifecycle(db, 'paper', 'trend_pullback'), { status: 'trial', statusTs: null });
});

test('setSetupLifecycleStatus then getSetupLifecycle round-trips', () => {
  const db = openDb(':memory:');
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'active', 1700000000);
  assert.deepEqual(getSetupLifecycle(db, 'paper', 'trend_pullback'), { status: 'active', statusTs: 1700000000 });
});

test('setSetupLifecycleStatus called twice for the same mode/setup overwrites, not duplicates', () => {
  const db = openDb(':memory:');
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'active', 1700000000);
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'auto_off', 1700003600);
  assert.deepEqual(getSetupLifecycle(db, 'paper', 'trend_pullback'), { status: 'auto_off', statusTs: 1700003600 });
});

test('paper and live are tracked independently for the same setup', () => {
  const db = openDb(':memory:');
  setSetupLifecycleStatus(db, 'paper', 'trend_pullback', 'active', 1700000000);
  assert.equal(getSetupLifecycle(db, 'live', 'trend_pullback').status, 'trial');
});

test('getAllSetupLifecycles defaults every known setup to trial and reflects stored overrides', () => {
  const db = openDb(':memory:');
  setSetupLifecycleStatus(db, 'paper', 'trend_breakout', 'active', 1700000000);
  const all = getAllSetupLifecycles(db, 'paper');
  assert.equal(all.trend_breakout, 'active');
  assert.equal(all.trend_pullback, 'trial');
  assert.equal(all.range_reversion, 'trial');
  assert.equal(all.oversold_bounce, 'trial');
});
