// db.js
'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'crypto.db');
let _db;

const _stmts = new Map();
function prepare(sql) {
  if (!_stmts.has(sql)) _stmts.set(sql, _db.prepare(sql));
  return _stmts.get(sql);
}

function initDb() {
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS coin_meta (
      id                    TEXT PRIMARY KEY,
      symbol                TEXT NOT NULL,
      name                  TEXT NOT NULL,
      image                 TEXT NOT NULL,
      market_cap            REAL,
      meta_fetched_at       INTEGER NOT NULL,
      market_cap_updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candles (
      symbol    TEXT    NOT NULL,
      open_time INTEGER NOT NULL,
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      PRIMARY KEY (symbol, open_time)
    );
    CREATE INDEX IF NOT EXISTS idx_candles_sym_time ON candles(symbol, open_time DESC);
  `);
}

function upsertMeta(row) {
  prepare(`
    INSERT OR REPLACE INTO coin_meta
      (id, symbol, name, image, market_cap, meta_fetched_at, market_cap_updated_at)
    VALUES
      (@id, @symbol, @name, @image, @market_cap, @meta_fetched_at, @market_cap_updated_at)
  `).run(row);
}

function getMeta(id) {
  return prepare('SELECT * FROM coin_meta WHERE id = ?').get(id);
}

function getAllMeta() {
  return prepare('SELECT * FROM coin_meta').all();
}

function updateMarketCap(id, market_cap) {
  prepare('UPDATE coin_meta SET market_cap = ?, market_cap_updated_at = ? WHERE id = ?')
    .run(market_cap, Date.now(), id);
}

function insertCandles(rows) {
  const ins = prepare(`
    INSERT OR REPLACE INTO candles (symbol, open_time, open, high, low, close, volume)
    VALUES (@symbol, @open_time, @open, @high, @low, @close, @volume)
  `);
  _db.transaction(rs => { for (const r of rs) ins.run(r); })(rows);
}

function getLastCandleTime(symbol) {
  const row = prepare('SELECT MAX(open_time) AS t FROM candles WHERE symbol = ?').get(symbol);
  return row ? row.t : null;
}

// Returns closes oldest-first (required for RSI calculation).
function getCloses(symbol, limit) {
  const rows = prepare(
    'SELECT close FROM candles WHERE symbol = ? ORDER BY open_time DESC LIMIT ?'
  ).all(symbol, limit);
  return rows.map(r => r.close).reverse();
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

module.exports = {
  initDb, upsertMeta, getMeta, getAllMeta, updateMarketCap,
  insertCandles, getLastCandleTime, getCloses, calculateRSI,
};
