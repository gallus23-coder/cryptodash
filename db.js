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
  // Migrate derivatives_history: add open_interest_usd column if missing.
  const derivCols = _db.pragma('table_info(derivatives_history)');
  if (derivCols.length > 0 && !derivCols.some(c => c.name === 'open_interest_usd')) {
    console.log('[db] migrating derivatives_history: adding open_interest_usd column');
    _db.exec('ALTER TABLE derivatives_history ADD COLUMN open_interest_usd REAL');
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
    CREATE TABLE IF NOT EXISTS derivatives_history (
      coin_id            TEXT    NOT NULL,
      time               INTEGER NOT NULL,
      funding_rate       REAL,
      open_interest      REAL,               -- raw coin quantity (e.g. number of BTC)
      open_interest_usd  REAL,               -- USD notional (open_interest × price at time of fetch)
      UNIQUE(coin_id, time)
    );
    CREATE INDEX IF NOT EXISTS idx_deriv_cit ON derivatives_history(coin_id, time DESC);
    CREATE TABLE IF NOT EXISTS signal_history (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      coin_id             TEXT    NOT NULL,
      timestamp           TEXT    NOT NULL,
      signal              TEXT    NOT NULL,
      market_phase        TEXT,
      rsi                 REAL,
      macd_hist           REAL,
      volume_ratio        REAL,
      price_usd           REAL,
      price_gbp           REAL,
      derivatives_context TEXT,
      summary             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sighist_cit ON signal_history(coin_id, timestamp DESC);
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

// Returns the open-time of the most recent COMPLETED candle (2nd-most-recent row),
// i.e. the candle before the currently-forming one. Returns null if < 2 rows exist.
function getLastClosedCandleTime(coin_id, interval) {
  const row = prepare(
    'SELECT time FROM candles WHERE coin_id = ? AND interval = ? ORDER BY time DESC LIMIT 1 OFFSET 1'
  ).get(coin_id, interval);
  return row ? row.time : null;
}

// Returns closes oldest-first (required for RSI calculation).
function getCloses(coin_id, interval, limit) {
  const rows = prepare(
    'SELECT close FROM candles WHERE coin_id = ? AND interval = ? ORDER BY time DESC LIMIT ?'
  ).all(coin_id, interval, limit);
  return rows.map(r => r.close).reverse();
}

// Returns volumes oldest-first (last N by time, reversed).
function getVolumes(coin_id, interval, limit) {
  const rows = prepare(
    'SELECT volume FROM candles WHERE coin_id = ? AND interval = ? ORDER BY time DESC LIMIT ?'
  ).all(coin_id, interval, limit);
  return rows.map(r => r.volume).reverse();
}

// Returns last N candles as {high, low, close} oldest-first (for ATR etc).
function getOHLCLimit(coin_id, interval, limit) {
  const rows = prepare(
    'SELECT high, low, close FROM candles WHERE coin_id = ? AND interval = ? ORDER BY time DESC LIMIT ?'
  ).all(coin_id, interval, limit);
  return rows.reverse();
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

// Look up coin_meta by Binance symbol (e.g. "DOTUSDT"). Used by scanner auto-add.
function getMetaBySymbol(symbol) {
  return prepare('SELECT * FROM coin_meta WHERE symbol = ?').get(symbol) || null;
}

// ── derivatives history ───────────────────────────────────────────────────────

function upsertDerivatives({ coin_id, time, funding_rate, open_interest, open_interest_usd }) {
  prepare(`
    INSERT OR REPLACE INTO derivatives_history
      (coin_id, time, funding_rate, open_interest, open_interest_usd)
    VALUES
      (@coin_id, @time, @funding_rate, @open_interest, @open_interest_usd)
  `).run({ coin_id, time, funding_rate, open_interest, open_interest_usd });
}

// Returns most-recent row at or before `cutoffMs` ago. Used for 24h trend calc.
function getDerivativesAgo(coin_id, msAgo) {
  const cutoff = Date.now() - msAgo;
  return prepare(
    'SELECT * FROM derivatives_history WHERE coin_id = ? AND time <= ? ORDER BY time DESC LIMIT 1'
  ).get(coin_id, cutoff);
}

function getLatestDerivativesTime() {
  try {
    const row = prepare('SELECT MAX(time) as t FROM derivatives_history').get();
    return row?.t ?? null;
  } catch { return null; }
}

function pruneDerivatives(keepMs) {
  const cutoff = Date.now() - keepMs;
  const result = _db.prepare(
    'DELETE FROM derivatives_history WHERE time < ?'
  ).run(cutoff);
  if (result.changes > 0) {
    console.log(`[db] pruned ${result.changes} old derivatives rows`);
  }
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

function getSignalHistory(coinId, from, to) {
  return prepare(`
    SELECT timestamp, signal, market_phase, rsi, macd_hist, volume_ratio,
           price_usd, price_gbp, derivatives_context, summary
    FROM signal_history
    WHERE coin_id = ?
      AND timestamp >= ?
      AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(coinId, from, to);
}

function insertSignalHistory(row) {
  prepare(`
    INSERT INTO signal_history
      (coin_id, timestamp, signal, market_phase, rsi, macd_hist, volume_ratio,
       price_usd, price_gbp, derivatives_context, summary)
    VALUES
      (@coin_id, @timestamp, @signal, @market_phase, @rsi, @macd_hist, @volume_ratio,
       @price_usd, @price_gbp, @derivatives_context, @summary)
  `).run(row);
}

module.exports = {
  initDb, upsertMeta, getMeta, getAllMeta, updateMarketCap, getMetaBySymbol,
  upsertDerivatives, getDerivativesAgo, pruneDerivatives, getLatestDerivativesTime,
  insertCandles, getLastCandleTime, getLastClosedCandleTime, getCloses, getVolumes, getOHLCLimit, getCandles, getAggCandles,
  calculateRSI, pruneCandles, insertSignalHistory, getSignalHistory,
};
