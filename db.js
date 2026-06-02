// db.js
'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'crypto.db');
let _db;

const _stmts = new Map();
function prepare(sql) {
  if (!_stmts.has(sql)) _stmts.set(sql, _db.prepare(sql));
  return _stmts.get(sql);
}

function initDb() {
  _stmts.clear();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  // Migrate old schema: if candles table exists but lacks interval column, drop it.
  // 1h backfill re-runs automatically on next startup.
  const cols = _db.pragma('table_info(candles)');
  if (cols.length > 0 && !cols.some(c => c.name === 'interval')) {
    console.log('[db] migrating candles table to new schema');
    _db.exec('DROP TABLE IF EXISTS candles');
  }
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
      coin_id  TEXT    NOT NULL,
      interval TEXT    NOT NULL,
      time     INTEGER NOT NULL,
      open     REAL    NOT NULL,
      high     REAL    NOT NULL,
      low      REAL    NOT NULL,
      close    REAL    NOT NULL,
      volume   REAL    NOT NULL,
      UNIQUE (coin_id, interval, time)
    );
    CREATE INDEX IF NOT EXISTS idx_candles_cit ON candles(coin_id, interval, time DESC);
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

// rows: [{ coin_id, interval, time, open, high, low, close, volume }, ...]
function insertCandles(rows) {
  const ins = prepare(`
    INSERT INTO candles (coin_id, interval, time, open, high, low, close, volume)
    VALUES (@coin_id, @interval, @time, @open, @high, @low, @close, @volume)
    ON CONFLICT(coin_id, interval, time) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume
  `);
  _db.transaction(rs => { for (const r of rs) ins.run(r); })(rows);
}

function getLastCandleTime(coin_id, interval) {
  const row = prepare(
    'SELECT MAX(time) AS t FROM candles WHERE coin_id = ? AND interval = ?'
  ).get(coin_id, interval);
  return row ? row.t : null;
}

// Returns closes oldest-first (required for RSI calculation).
function getCloses(coin_id, interval, limit) {
  const rows = prepare(
    'SELECT close FROM candles WHERE coin_id = ? AND interval = ? ORDER BY time DESC LIMIT ?'
  ).all(coin_id, interval, limit);
  return rows.map(r => r.close).reverse();
}

// Returns full candle rows for time >= since, oldest-first.
function getCandles(coin_id, interval, since) {
  return prepare(
    'SELECT time, open, high, low, close, volume FROM candles ' +
    'WHERE coin_id = ? AND interval = ? AND time >= ? ORDER BY time ASC'
  ).all(coin_id, interval, since);
}

// Aggregate native candles into larger time buckets.
// srcInterval: source interval to read ('1m' or '1h')
// bucketMs: target bucket size in ms (e.g. 300000 for 5m)
// since: start of window as unix ms
const _AGG_SQL = `
  SELECT
    b.bucket       AS time,
    j_open.open    AS open,
    MAX(c.high)    AS high,
    MIN(c.low)     AS low,
    j_close.close  AS close,
    SUM(c.volume)  AS volume
  FROM (
    SELECT
      CAST(time / ? AS INTEGER) * ? AS bucket,
      MIN(time)      AS t_open,
      MAX(time)      AS t_close
    FROM candles
    WHERE coin_id = ? AND interval = ? AND time >= ?
    GROUP BY bucket
  ) b
  JOIN candles c
    ON c.coin_id = ? AND c.interval = ? AND c.time >= ?
   AND CAST(c.time / ? AS INTEGER) * ? = b.bucket
  JOIN candles j_open
    ON j_open.coin_id = ? AND j_open.interval = ? AND j_open.time = b.t_open
  JOIN candles j_close
    ON j_close.coin_id = ? AND j_close.interval = ? AND j_close.time = b.t_close
  GROUP BY b.bucket
  ORDER BY b.bucket ASC
`;

function getAggCandles(coin_id, srcInterval, bucketMs, since) {
  return prepare(_AGG_SQL).all(
    bucketMs, bucketMs,
    coin_id, srcInterval, since,
    coin_id, srcInterval, since,
    bucketMs, bucketMs,
    coin_id, srcInterval,
    coin_id, srcInterval,
  );
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

// Prune candles older than keepMs for a given interval. Called daily.
function pruneCandles(interval, keepMs) {
  const cutoff = Date.now() - keepMs;
  const result = _db.prepare(
    'DELETE FROM candles WHERE interval = ? AND time < ?'
  ).run(interval, cutoff);
  if (result.changes > 0) {
    console.log(`[db] pruned ${result.changes} old ${interval} candles`);
  }
}

module.exports = {
  initDb, upsertMeta, getMeta, getAllMeta, updateMarketCap,
  insertCandles, getLastCandleTime, getCloses, getCandles, getAggCandles,
  calculateRSI, pruneCandles,
};
