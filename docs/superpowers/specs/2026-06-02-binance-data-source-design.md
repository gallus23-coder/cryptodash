# Binance Data Source Migration Design

**Date:** 2026-06-02
**Status:** Approved

## Summary

Replace CoinGecko as the live data source with Binance public API. Store 1h OHLCV candles in SQLite. Use CoinGecko only for static metadata (name, image, market cap) fetched once per coin and market cap refreshed every 24h.

---

## Architecture

### Files

| File | Role |
|---|---|
| `server.js` | Express routes + cron scheduling only |
| `db.js` | SQLite init, schema, prepared-statement query helpers |
| `binance.js` | Ticker fetch, klines backfill, incremental candle fetch |
| `coingecko.js` | Metadata fetch (name/image/market_cap), 24h cap refresh |
| `public/index.html` | Unchanged — API response normalized to same field shape |
| `data/crypto.db` | New SQLite database |
| `data/rsi.json` | Kept — calculated from SQLite candles instead of CoinGecko |
| `data/signals.json` | Kept unchanged |
| `data/watchlist.json` | Kept — stores CoinGecko IDs as canonical coin keys |

### New dependency

`better-sqlite3` (synchronous, no async overhead, appropriate for local Pi app).

---

## SQLite Schema

```sql
-- Coin identity + CoinGecko metadata (fetched once, market_cap refreshed daily)
CREATE TABLE IF NOT EXISTS coin_meta (
  id                    TEXT PRIMARY KEY,  -- coingecko id: "bitcoin"
  symbol                TEXT NOT NULL,     -- binance symbol: "BTCUSDT"
  name                  TEXT NOT NULL,
  image                 TEXT NOT NULL,
  market_cap            REAL,
  meta_fetched_at       INTEGER NOT NULL,  -- unix ms
  market_cap_updated_at INTEGER NOT NULL   -- unix ms
);

-- 1-hour OHLCV candles from Binance
CREATE TABLE IF NOT EXISTS candles (
  symbol    TEXT    NOT NULL,   -- "BTCUSDT"
  open_time INTEGER NOT NULL,   -- unix ms (Binance kline open time)
  open      REAL    NOT NULL,
  high      REAL    NOT NULL,
  low       REAL    NOT NULL,
  close     REAL    NOT NULL,
  volume    REAL    NOT NULL,
  PRIMARY KEY (symbol, open_time)
);
CREATE INDEX IF NOT EXISTS idx_candles_sym_time ON candles(symbol, open_time DESC);
```

---

## Symbol Mapping

Hardcoded map for known coins; fallback derives symbol from CoinGecko metadata (`cgSymbol.toUpperCase() + 'USDT'`). Resolved symbol stored permanently in `coin_meta.symbol`.

```js
const SYMBOL_MAP = {
  bitcoin:       'BTCUSDT',
  ethereum:      'ETHUSDT',
  binancecoin:   'BNBUSDT',
  ripple:        'XRPUSDT',
  cardano:       'ADAUSDT',
  solana:        'SOLUSDT',
  'avalanche-2': 'AVAXUSDT',
  chainlink:     'LINKUSDT',
};
```

---

## Data Flow

### Startup sequence

1. `db.js` — create tables if not exist
2. For each coin in `watchlist.json`:
   - Not in `coin_meta` → CoinGecko fetch → insert (name, image, market_cap, symbol)
   - `market_cap_updated_at` > 24h ago → refresh market_cap from CoinGecko
   - No candles for symbol → backfill 90 days of 1h candles from Binance
3. Crons start

**Backfill cost:** 90 days × 24 candles/day = 2160 candles per coin → 3 Binance requests per coin (1000 candles/request). 8 coins = ~24 requests total. Completes in seconds.

### Cron schedule

| Interval | Job |
|---|---|
| Every 1 min | Check alerts — Binance `ticker/24hr` per unique alert coin symbol |
| Every 15 min | Fetch new candles → recalc RSI → update signals (Anthropic) |
| Every 24h | Refresh `market_cap` for all watchlist coins from CoinGecko |

### `/api/market` response assembly (per request)

1. Batch-fetch Binance `GET /api/v3/ticker/24hr` for all watchlist symbols
2. For each coin, read from SQLite:
   - Last 300 hourly closes → RSI-14
   - Last 168 closes → 7d sparkline
   - Last 2 closes → 1h change: `(close[-1] - close[-2]) / close[-2] * 100`
3. Read `coin_meta` for name / image / market_cap
4. Normalize into existing frontend field shape (zero frontend changes)

**Normalized response fields (per coin):**

```
id, name, symbol, image
current_price
price_change_percentage_1h_in_currency   ← from SQLite candles
price_change_percentage_24h              ← from Binance ticker
price_change_percentage_7d_in_currency   ← from SQLite candles (first vs last of 168)
market_cap                               ← from coin_meta
total_volume                             ← from Binance ticker
sparkline_in_7d.price                    ← array of 168 closes from SQLite
```

---

## Module Responsibilities

### `db.js`

- `initDb()` — open DB, create tables + index
- `upsertMeta(row)` — INSERT OR REPLACE into coin_meta
- `getMeta(id)` / `getAllMeta()` — read coin_meta
- `updateMarketCap(id, cap)` — update market_cap + market_cap_updated_at
- `insertCandles(rows)` — bulk INSERT OR REPLACE into candles
- `getLastCandleTime(symbol)` — max open_time for symbol (null if none)
- `getCloses(symbol, limit)` — last N closes ordered by open_time DESC

### `binance.js`

- `coinToSymbol(id)` — SYMBOL_MAP lookup (symbol stored in coin_meta used at runtime)
- `fetchTicker(symbol)` — `GET /api/v3/ticker/24hr?symbol=X`
- `fetchKlines(symbol, startTime, limit)` — `GET /api/v3/klines?symbol=X&interval=1h`
- `backfillCandles(symbol, db)` — paginate from 90 days ago to now, insert via db
- `fetchNewCandles(symbol, db)` — fetch since `getLastCandleTime(symbol) + 1ms`

### `coingecko.js`

- `fetchMetadata(id)` — `GET /api/v3/coins/{id}` → `{ symbol, name, image, market_cap }`
- `refreshMarketCaps(ids)` — `GET /api/v3/coins/markets?vs_currency=usd&ids=...` (batched)

### `server.js`

- Imports db, binance, coingecko modules
- On startup: init DB, seed metadata + backfill for all watchlist coins
- Routes: `/api/market`, `/api/watchlist`, `/api/rsi`, `/api/signals`, `/api/alerts`
- Crons: alert check (1 min), candle+RSI+signals (15 min), market_cap refresh (24h)
- `calculateRSI(closes)` moves to `db.js` (operates on candle data, co-located with `getCloses`)

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Binance returns 400 for unknown symbol | Log error, store `symbol = null` in coin_meta, row shows `—` for live fields |
| CoinGecko 429 on metadata fetch | Retry once after 2s; if still fails, watchlist POST returns 502 |
| CoinGecko 429 on 24h market_cap refresh | Skip that coin silently; retry on next 24h cycle |
| Stale candles after Pi reboot | Incremental fetch uses `lastOpenTime + 1ms` as startTime — auto catches up |
| RSI with < 15 closes | Returns `null` (unchanged behaviour) |
| Alert coin has `symbol = null` | Alert checker skips it, logs warning, alert stays armed |
| New coin added (backfill in progress) | `/api/market` returns row with `—` for sparkline/RSI/1h until candles arrive |

---

## What Does Not Change

- Frontend (`public/index.html`) — API response shape preserved exactly
- Alert storage (`alerts.json`, `triggered.json`)
- Signals storage (`signals.json`) and Anthropic API integration
- Watchlist storage format (`watchlist.json`, CoinGecko IDs)
- Desktop notification logic
- RSI algorithm (`calculateRSI` function body unchanged)
