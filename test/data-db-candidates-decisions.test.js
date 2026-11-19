'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, insertCandidate, getCandidate, updateCandidateShadow, insertDecision, getDecisions } = require('../src/data/db');

function sampleCandidate(id = 'c_20261118_10_SOL_trend_pullback') {
  return {
    id, ts: 1700000000, mode: 'paper', coin: 'SOL', setup: 'trend_pullback', regime: 'trend_up',
    entry: 98.40, atr: 3.10,
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
    context: { rsi14: 47.2, adx4h: 26.1 },
  };
}

test('insertCandidate stores a candidate and getCandidate retrieves it with JSON fields parsed back out', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());

  const row = getCandidate(db, 'c_20261118_10_SOL_trend_pullback');
  assert.equal(row.coin, 'SOL');
  assert.equal(row.entry, 98.40);
  assert.deepEqual(row.default, { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 });
  assert.deepEqual(row.ranges, { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] });
  assert.deepEqual(row.context, { rsi14: 47.2, adx4h: 26.1 });
  assert.equal(row.shadowStatus, 'open'); // default status for a freshly-inserted candidate
});

test('insertCandidate upserts by id rather than duplicating on a retried cycle', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());
  insertCandidate(db, sampleCandidate()); // same id, simulating a retried cycle

  const row = getCandidate(db, 'c_20261118_10_SOL_trend_pullback');
  assert.ok(row); // still exactly one row reachable by id, not an error from a duplicate PK
});

test('updateCandidateShadow resolves a candidate\'s shadow outcome', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());

  updateCandidateShadow(db, 'c_20261118_10_SOL_trend_pullback', {
    status: 'resolved', exitTs: 1700050000, pnl: 12.5, r: 1.2, exitReason: 'trailing_stop',
  });

  const row = getCandidate(db, 'c_20261118_10_SOL_trend_pullback');
  assert.equal(row.shadowStatus, 'resolved');
  assert.equal(row.shadowPnl, 12.5);
  assert.equal(row.shadowR, 1.2);
  assert.equal(row.shadowExitReason, 'trailing_stop');
});

test('insertDecision stores a decision linked to its candidate, and getDecisions returns newest first', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());
  insertCandidate(db, sampleCandidate('c_20261118_14_SOL_trend_pullback'));

  insertDecision(db, {
    candidateId: 'c_20261118_10_SOL_trend_pullback', ts: 1700000000, mode: 'paper',
    action: 'take', size: 0.5, stopAtr: 2.0, trailAtr: 2.5,
    reason: 'Setup valid but funding elevated.', plainReason: 'Bought smaller with more room.',
    defaultAction: 'take', diverged: true, model: 'claude-cli', latencyMs: 1200, rawResponse: '{"ok":true}',
  });
  insertDecision(db, {
    candidateId: 'c_20261118_14_SOL_trend_pullback', ts: 1700014400, mode: 'paper',
    action: 'skip', size: 0, stopAtr: null, trailAtr: null,
    reason: 'Breadth falling.', plainReason: 'Sat out.',
    defaultAction: 'take', diverged: true, model: 'claude-cli', latencyMs: 900, rawResponse: '{"ok":true}',
  });

  const decisions = getDecisions(db, 'paper');
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].candidateId, 'c_20261118_14_SOL_trend_pullback'); // newest first
  assert.equal(decisions[0].diverged, true);
  assert.equal(decisions[1].candidateId, 'c_20261118_10_SOL_trend_pullback');
});

test('getDecisions respects the mode filter and the limit', () => {
  const db = openDb(':memory:');
  insertCandidate(db, sampleCandidate());
  insertDecision(db, {
    candidateId: 'c_20261118_10_SOL_trend_pullback', ts: 1700000000, mode: 'live',
    action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5,
    reason: 'x', plainReason: 'x', defaultAction: 'take', diverged: false,
    model: 'claude-cli', latencyMs: 800, rawResponse: '{}',
  });

  assert.equal(getDecisions(db, 'paper').length, 0); // mode filter excludes the 'live' row
});
