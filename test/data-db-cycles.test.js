'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCycleOneLiner, openDb, insertCycleLog, getCycleLogFiltered } = require('../src/data/db');

test('buildCycleOneLiner for a cycle with zero candidates says so plainly', () => {
  const line = buildCycleOneLiner({ regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, error: null });
  assert.match(line, /no candidates/i);
});

test('buildCycleOneLiner for a cycle with an error says so distinctly, not "no candidates"', () => {
  const line = buildCycleOneLiner({ regimeLabel: 'trend_up', candidatesCount: 0, openedCount: 0, closedCount: 0, error: 'claude cli failed: timeout' });
  assert.match(line, /error|failed|problem/i);
  assert.doesNotMatch(line, /no candidates/i);
});

test('buildCycleOneLiner for a cycle that opened a position says so with the count', () => {
  const line = buildCycleOneLiner({ regimeLabel: 'trend_up', candidatesCount: 2, openedCount: 1, closedCount: 0, error: null });
  assert.match(line, /1/);
  assert.match(line, /open/i);
});

test('buildCycleOneLiner for a cycle that closed a position says so with the count', () => {
  const line = buildCycleOneLiner({ regimeLabel: 'trend_up', candidatesCount: 0, openedCount: 0, closedCount: 1, error: null });
  assert.match(line, /1/);
  assert.match(line, /clos/i);
});

test('getCycleLogFiltered returns rows newest first, each with a oneLiner', () => {
  const db = openDb(':memory:');
  insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });
  insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });

  const rows = getCycleLogFiltered(db, { mode: 'paper' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, 2000); // newest first
  assert.ok(rows[0].oneLiner);
});

test('getCycleLogFiltered filters by regime', () => {
  const db = openDb(':memory:');
  insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });
  insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 100 });

  const rows = getCycleLogFiltered(db, { mode: 'paper', regime: 'trend_up' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].regimeLabel, 'trend_up');
});

test('getCycleLogFiltered respects limit', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 5; i += 1) {
    insertCycleLog(db, { ts: i * 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });
  }
  const rows = getCycleLogFiltered(db, { mode: 'paper', limit: 2 });
  assert.equal(rows.length, 2);
});
