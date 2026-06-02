# 1-Minute Candles Design

**Date:** 2026-06-02
**Status:** Approved

## Summary

Add 1-minute OHLCV candles alongside existing 1h candles. Single `candles` table with `(coin_id, interval, time)` unique key. New `/api/candles/:coinId` endpoint serves native 1m/1h candles and derived 5m/15m/4h/1d aggregations. Schema migration on startup via `PRAGMA table_info` detection.

---

## Schema

```sql
CREATE TABLE IF NOT EXISTS candles (
  coin_id  TEXT    NOT NULL,
  interval TEXT    NOT NULL,   -- "1m" or "1h"
  time     INTEGER NOT NULL,   -- unix ms
  open     REAL    NOT NULL,
  high     REAL    NOT NULL,
  low      REAL    NOT NULL,
  close    REAL    NOT NULL,
  volume   REAL    NOT NULL,
  UNIQUE (coin_id, interval, time)
);
CREATE INDEX IF NOT EXISTS idx_candles_cit ON candles(coin_id, interval, time DESC);
```

**Migration:** `initDb()` checks `PRAGMA table_info(candles)` for the `interval` column. If absent, DROP TABLE candles + recreate. 1h backfill re-runs naturally on next startup step.

---

## `db.js` Changes

Updated function signatures:

```js
// rows shape: { coin_id, interval, time, open, high, low, close, volume }
insertCandles(rows)

getLastCandleTime(coin_id, interval)   // MAX(time) for pair, or null
getCloses(coin_id, interval, limit)    // last N closes oldest-first (RSI input)
getCandles(coin_id, interval, since)   // rows WHERE time >= since, ORDER BY time ASC
getAggCandles(coin_id, srcInterval, bucketMs, since)  // SQL aggregation for derived intervals
```

`getAggCandles` SQL pattern (correct first-open / last-close per bucket via JOIN):

```sql
SELECT
  b.bucket,
  j_open.open   AS open,
  MAX(c.high)   AS high,
  MIN(c.low)    AS low,
  j_close.close AS close,
  SUM(c.volume) AS volume
FROM (
  SELECT
    (time / ?) * ? AS bucket,
    MIN(time) AS t_open,
    MAX(time) AS t_close
  FROM candles
  WHERE coin_id = ? AND interval = ? AND time >= ?
  GROUP BY bucket
) b
JOIN candles c       ON c.coin_id = ? AND c.interval = ? AND c.time >= ?
                     AND (c.time / ?) * ? = b.bucket
JOIN candles j_open  ON j_open.coin_id = ? AND j_open.interval = ?
                     AND j_open.time = b.t_open
JOIN candles j_close ON j_close.coin_id = ? AND j_close.interval = ?
                     AND j_close.time = b.t_close
GROUP BY b.bucket
ORDER BY b.bucket ASC
```

`bucketMs` values: 5m=300000, 15m=900000, 4h=14400000, 1d=86400000.

---

## `binance.js` Changes

`_klineToRow` updated to use `coin_id` + `interval`:

```js
function _klineToRow(coin_id, interval, k) {
  return {
    coin_id, interval,
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[7]),  // quoteVolume (USDT)
  };
}
```

`backfillCandles` gains `lookbackMs` param — single function handles both intervals:

```js
async function backfillCandles(coin_id, symbol, interval, lookbackMs, db)
```

Callers:
- `backfillCandles(id, meta.symbol, '1h', 90 * 24 * 3600 * 1000, db)` — 2160 candles
- `backfillCandles(id, meta.symbol, '1m',  7 * 24 * 3600 * 1000, db)` — 10080 candles

1m backfill: 11 pages of 1000. 200ms between pages. **2s delay between coins**.

`fetchNewCandles` gains `coin_id` + `interval` params:

```js
async function fetchNewCandles(coin_id, symbol, interval, db)
```

`fetchTicker` and `SYMBOL_MAP` unchanged.

---

## `server.js` Changes

### Startup

Both backfills run per coin:

```js
await backfillCandles(id, meta.symbol, '1h', 90 * 24 * 3600 * 1000, db);
await backfillCandles(id, meta.symbol, '1m',  7 * 24 * 3600 * 1000, db);
```

### Crons

New 1-min cron:

```js
async function update1mCandles() {
  for (const id of watchlist) {
    const meta = db.getMeta(id);
    if (!meta?.symbol) continue;
    await fetchNewCandles(id, meta.symbol, '1m', db);
  }
}
cron.schedule('* * * * *', update1mCandles);
```

Existing 15-min cron updated:

```js
await fetchNewCandles(id, meta.symbol, '1h', db);
```

### `/api/market`

```js
db.getCloses(id, '1h', 300)   // was: db.getCloses(meta.symbol, 300)
```

### `/api/candles/:coinId`

| `?interval=` | source | `bucketMs` | window |
|---|---|---|---|
| `1m` | 1m (native) | — | last 24h |
| `5m` | 1m | 300000 | last 7d |
| `15m` | 1m | 900000 | last 30d |
| `4h` | 1m | 14400000 | last 90d |
| `1h` | 1h (native) | — | last 90d |
| `1d` | 1h | 86400000 | last 1y |

```js
app.get('/api/candles/:coinId', (req, res) => {
  const { coinId } = req.params;
  const interval = req.query.interval || '1h';
  const windows = {
    '1m':  24*3600*1000,  '5m': 7*86400*1000,
    '15m': 30*86400*1000, '4h': 90*86400*1000,
    '1h':  90*86400*1000, '1d': 365*86400*1000,
  };
  const buckets = { '5m': 300000, '15m': 900000, '4h': 14400000, '1d': 86400000 };
  if (!windows[interval]) return res.status(400).json({ error: 'invalid interval' });
  const since = Date.now() - windows[interval];
  let candles;
  if (buckets[interval]) {
    const src = interval === '1d' ? '1h' : '1m';
    candles = db.getAggCandles(coinId, src, buckets[interval], since);
  } else {
    candles = db.getCandles(coinId, interval, since);
  }
  res.json(candles);
});
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Binance 429 during 1m backfill | Throw — startup logs error, coin skipped for 1m until next restart |
| `fetchNewCandles` 1m fails | Log + skip that coin; next 1-min cron retries |
| Unknown `interval` param | 400 `{ error: 'invalid interval' }` |
| No candles for requested range | Returns `[]` |
| `coin_id` not in watchlist | Returns `[]` (no auth needed — read-only endpoint) |
| Schema migration on startup | DROP + recreate + 1h backfill re-runs; 1m backfill also runs fresh |

---

## What Does Not Change

- `coingecko.js` — no changes
- `coin_meta` table — no changes
- `/api/market` response shape — unchanged (frontend unaffected)
- RSI algorithm (`calculateRSI`) — unchanged
- Alerts, signals, watchlist storage — unchanged
- `fetchTicker`, `SYMBOL_MAP` — unchanged
