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
  `);
  return db;
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

module.exports = { openDb, upsertCandles, getCandles, getLastCandleTime, getExistingTimes, DEFAULT_DB_PATH };
