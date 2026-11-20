'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  openDb, insertConfigVersion, getActiveConfigVersion, getPendingConfigVersion,
  approveConfigVersion, rejectConfigVersion, supersedePendingConfigVersions,
} = require('../src/data/db');

function sampleConfigJson(overrides = {}) {
  return { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {}, ...overrides };
}

test('getActiveConfigVersion returns a synthetic default when nothing has ever been marked active', () => {
  const db = openDb(':memory:');
  const active = getActiveConfigVersion(db, 'paper');
  assert.equal(active.id, null);
  assert.equal(active.config.riskLevel, 'normal');
  assert.deepEqual(active.config.disabledSetups, []);
});

test('insertConfigVersion creates a pending row; getPendingConfigVersion finds it', () => {
  const db = openDb(':memory:');
  const id = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'cautious' }), backtestJson: { summary: 'x' } });
  const pending = getPendingConfigVersion(db, 'paper');
  assert.equal(pending.id, id);
  assert.equal(pending.config.riskLevel, 'cautious');
  assert.equal(pending.status, 'pending');
});

test('submitting a second draft supersedes the first pending one', () => {
  const db = openDb(':memory:');
  const firstId = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'cautious' }), backtestJson: {} });
  supersedePendingConfigVersions(db, 'paper');
  const secondId = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'normal' }), backtestJson: {} });

  const pending = getPendingConfigVersion(db, 'paper');
  assert.equal(pending.id, secondId);
  assert.notEqual(firstId, secondId);
});

test('approveConfigVersion promotes a pending version to active and demotes the previous active one', () => {
  const db = openDb(':memory:');
  const firstId = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'cautious' }), backtestJson: {} });
  approveConfigVersion(db, 'paper', firstId);

  const secondId = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson({ riskLevel: 'normal' }), backtestJson: {} });
  approveConfigVersion(db, 'paper', secondId);

  const active = getActiveConfigVersion(db, 'paper');
  assert.equal(active.id, secondId);
  assert.equal(getPendingConfigVersion(db, 'paper'), null);
});

test('approveConfigVersion throws if the version is not currently pending', () => {
  const db = openDb(':memory:');
  const id = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson(), backtestJson: {} });
  approveConfigVersion(db, 'paper', id);
  assert.throws(() => approveConfigVersion(db, 'paper', id));
});

test('rejectConfigVersion sets status to rejected and is a dead end', () => {
  const db = openDb(':memory:');
  const id = insertConfigVersion(db, { mode: 'paper', configJson: sampleConfigJson(), backtestJson: {} });
  rejectConfigVersion(db, 'paper', id);
  assert.equal(getPendingConfigVersion(db, 'paper'), null);
  assert.throws(() => approveConfigVersion(db, 'paper', id));
  assert.throws(() => rejectConfigVersion(db, 'paper', id));
});
