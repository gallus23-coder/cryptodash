'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'cryptodash-v2.db');

function openDb(dbPath = process.env.CRYPTODASH_DB_PATH || DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      coin      TEXT    NOT NULL,
      timeframe TEXT    NOT NULL,
      ts        INTEGER NOT NULL,
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      trades    INTEGER,
      PRIMARY KEY (coin, timeframe, ts)
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL, coin TEXT NOT NULL, setup TEXT NOT NULL,
      entry_ts INTEGER NOT NULL, exit_ts INTEGER NOT NULL,
      entry_price REAL NOT NULL, exit_price REAL NOT NULL,
      units REAL NOT NULL, risk_amount REAL NOT NULL,
      pnl REAL NOT NULL, r REAL NOT NULL, exit_reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_state (
      mode TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cycle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, mode TEXT NOT NULL, regime_label TEXT,
      candidates_count INTEGER NOT NULL, opened_count INTEGER NOT NULL, closed_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, error TEXT
    );
  `);
  return db;
}

function insertTrade(db, trade) {
  db.prepare(`
    INSERT INTO trades (mode, coin, setup, entry_ts, exit_ts, entry_price, exit_price, units, risk_amount, pnl, r, exit_reason)
    VALUES (@mode, @coin, @setup, @entryTs, @exitTs, @entryPrice, @exitPrice, @units, @riskAmount, @pnl, @r, @exitReason)
  `).run(trade);
}

function getTrades(db, mode) {
  return db.prepare(`
    SELECT id, mode, coin, setup,
      entry_ts AS entryTs, exit_ts AS exitTs,
      entry_price AS entryPrice, exit_price AS exitPrice,
      units, risk_amount AS riskAmount, pnl, r, exit_reason AS exitReason
    FROM trades WHERE mode = ? ORDER BY exit_ts ASC
  `).all(mode);
}

function saveSchedulerState(db, mode, state) {
  db.prepare(`
    INSERT INTO scheduler_state (mode, state_json, updated_ts) VALUES (@mode, @stateJson, @updatedTs)
    ON CONFLICT(mode) DO UPDATE SET state_json = excluded.state_json, updated_ts = excluded.updated_ts
  `).run({ mode, stateJson: JSON.stringify(state), updatedTs: Date.now() });
}

function loadSchedulerState(db, mode) {
  const row = db.prepare('SELECT state_json FROM scheduler_state WHERE mode = ?').get(mode);
  return row ? JSON.parse(row.state_json) : null;
}

function insertCycleLog(db, row) {
  db.prepare(`
    INSERT INTO cycle_log (ts, mode, regime_label, candidates_count, opened_count, closed_count, duration_ms, error)
    VALUES (@ts, @mode, @regimeLabel, @candidatesCount, @openedCount, @closedCount, @durationMs, @error)
  `).run({ error: null, ...row });
}

function getCycleLog(db, mode, limit = 50) {
  return db.prepare('SELECT * FROM cycle_log WHERE mode = ? ORDER BY ts DESC LIMIT ?').all(mode, limit);
}

function upsertCandles(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO candles (coin, timeframe, ts, open, high, low, close, volume, trades)
    VALUES (@coin, @timeframe, @ts, @open, @high, @low, @close, @volume, @trades)
    ON CONFLICT(coin, timeframe, ts) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, volume = excluded.volume, trades = excluded.trades
  `);
  const insertMany = db.transaction((items) => {
    for (const row of items) stmt.run({ trades: null, ...row });
  });
  insertMany(rows);
  return rows.length;
}

function getCandles(db, coin, timeframe, fromTs, toTs) {
  return db.prepare(`
    SELECT ts, open, high, low, close, volume, trades FROM candles
    WHERE coin = ? AND timeframe = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(coin, timeframe, fromTs, toTs);
}

function getLastCandleTime(db, coin, timeframe) {
  const row = db.prepare(`
    SELECT MAX(ts) as maxTs FROM candles WHERE coin = ? AND timeframe = ?
  `).get(coin, timeframe);
  return row.maxTs ?? null;
}

function getExistingTimes(db, coin, timeframe, fromTs, toTs) {
  return db.prepare(`
    SELECT ts FROM candles WHERE coin = ? AND timeframe = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC
  `).all(coin, timeframe, fromTs, toTs).map((r) => r.ts);
}

module.exports = {
  openDb, upsertCandles, getCandles, getLastCandleTime, getExistingTimes, DEFAULT_DB_PATH,
  insertTrade, getTrades, saveSchedulerState, loadSchedulerState, insertCycleLog, getCycleLog,
};
