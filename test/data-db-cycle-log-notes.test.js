'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb, insertCycleLog, getLatestMarketNote } = require('../src/data/db');

test('openDb adds market_note/plain_note_json to a pre-existing cycle_log table', () => {
  const tmpPath = path.join(os.tmpdir(), `cryptodash-cyclelog-migration-${Date.now()}.db`);
  const raw = new Database(tmpPath);
  raw.exec(`
    CREATE TABLE cycle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, mode TEXT NOT NULL, regime_label TEXT,
      candidates_count INTEGER NOT NULL, opened_count INTEGER NOT NULL, closed_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, error TEXT
    );
  `);
  raw.close();

  const migrated = openDb(tmpPath);
  const columns = migrated.prepare("PRAGMA table_info(cycle_log)").all().map((c) => c.name);
  assert.ok(columns.includes('market_note'));
  assert.ok(columns.includes('plain_note_json'));

  migrated.close();
  fs.unlinkSync(tmpPath);
  if (fs.existsSync(`${tmpPath}-wal`)) fs.unlinkSync(`${tmpPath}-wal`);
  if (fs.existsSync(`${tmpPath}-shm`)) fs.unlinkSync(`${tmpPath}-shm`);
});

test('insertCycleLog stores marketNote/plainNote when given, and getLatestMarketNote returns the newest one', () => {
  const db = openDb(':memory:');
  insertCycleLog(db, {
    ts: 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100,
  }); // no note this cycle — decide() was never called
  insertCycleLog(db, {
    ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 100,
    marketNote: 'Breadth improving, taking the pullback.', plainNote: { mood: 'positive', bullets: ['BTC uptrend'], botAction: 'Bought SOL' },
  });

  const latest = getLatestMarketNote(db, 'paper');
  assert.equal(latest.ts, 2000);
  assert.equal(latest.marketNote, 'Breadth improving, taking the pullback.');
  assert.equal(latest.plainNote.mood, 'positive');
});

test('getLatestMarketNote returns null when no cycle has ever had a note', () => {
  const db = openDb(':memory:');
  insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });
  assert.equal(getLatestMarketNote(db, 'paper'), null);
});
