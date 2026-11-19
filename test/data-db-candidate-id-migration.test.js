'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb, insertTrade, getTrades } = require('../src/data/db');

test('openDb adds candidate_id to a pre-existing trades table that predates this column', () => {
  // Uses a shared temp FILE (not :memory:) so the "pre-existing table" and the "migrated" connection
  // are provably the same database — a :memory: db is always fresh and can't distinguish "migration
  // ran" from "the column was in CREATE TABLE all along," which is exactly the bug this test exists
  // to catch (the real Pi database already has a trades table from milestone 5, without this column).
  const tmpPath = path.join(os.tmpdir(), `cryptodash-migration-test-${Date.now()}.db`);

  const raw = new Database(tmpPath);
  raw.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL, coin TEXT NOT NULL, setup TEXT NOT NULL,
      entry_ts INTEGER NOT NULL, exit_ts INTEGER NOT NULL,
      entry_price REAL NOT NULL, exit_price REAL NOT NULL,
      units REAL NOT NULL, risk_amount REAL NOT NULL,
      pnl REAL NOT NULL, r REAL NOT NULL, exit_reason TEXT NOT NULL
    );
  `);
  raw.close();

  const migrated = openDb(tmpPath);
  const columns = migrated.prepare("PRAGMA table_info(trades)").all().map((c) => c.name);
  assert.ok(columns.includes('candidate_id'));

  migrated.close();
  fs.unlinkSync(tmpPath);
  if (fs.existsSync(`${tmpPath}-wal`)) fs.unlinkSync(`${tmpPath}-wal`);
  if (fs.existsSync(`${tmpPath}-shm`)) fs.unlinkSync(`${tmpPath}-shm`);
});

test('insertTrade accepts a candidateId and getTrades returns it back out', () => {
  const db = openDb(':memory:');
  insertTrade(db, {
    mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 0, exitTs: 3600,
    entryPrice: 100, exitPrice: 110, units: 1, riskAmount: 5, pnl: 10, r: 2, exitReason: 'target',
    candidateId: 'c_20261118_10_BTC_trend_pullback',
  });
  const trades = getTrades(db, 'paper');
  assert.equal(trades[0].candidateId, 'c_20261118_10_BTC_trend_pullback');
});

test('insertTrade with no candidateId stores null (backtest trades never had one)', () => {
  const db = openDb(':memory:');
  insertTrade(db, {
    mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 0, exitTs: 3600,
    entryPrice: 100, exitPrice: 110, units: 1, riskAmount: 5, pnl: 10, r: 2, exitReason: 'target',
  });
  const trades = getTrades(db, 'paper');
  assert.equal(trades[0].candidateId, null);
});
