# Candle Store + Backfill (Milestone 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v2 candle store (`src/data/`) — SQLite schema, 1h storage, 4h/1d aggregation, Kraken OHLCVT CSV import, and trades-based gap-filling — so that by the end, the DB holds 6+ months of gap-free 1h GBP candles for BTC/ETH/SOL/XRP/ADA/LINK, with a gap-check report, and v1's `binance.js` is deleted.

**Architecture:** `src/data/db.js` owns the SQLite schema and prepared-statement queries (no logic). `src/data/candles.js` holds pure functions — CSV parsing, 1h→4h/1d aggregation, trades→hourly-candle building, gap detection — none of which touch the network or the DB, so they're trivial to unit-test. `scripts/backfill-candles.js` is the one-off orchestrator that wires `kraken/rest.js` (network) + `data/candles.js` (pure logic) + `data/db.js` (storage) together: import the user-provided CSV zips, pull the last ~30 days from REST OHLC, bridge the gap between them with rebuilt trades-based candles, then run the gap-check and build 4h/1d.

**Tech Stack:** Node.js 20, `better-sqlite3` (already a dependency), system `unzip` (already on the Pi, confirmed via `which unzip`) shelled out via `child_process.execFileSync`, `node --test`.

**Spec:** `docs/v2-design.md` §§3, 4, 7 (candles table); `CLAUDE.md` hard rules ("completed candles only", atomic writes, no ORM — prepared statements).

## Verified before writing this plan (2026-11-18)

- **Real Kraken pair codes for the 6 GBP coins** (via live `AssetPairs` call): BTC→`XBTGBP` (REST result key `XXBTZGBP`), ETH→`ETHGBP` (key `XETHZGBP`), SOL→`SOLGBP` (key `SOLGBP`), XRP→`XRPGBP` (key `XRPGBP`), ADA→`ADAGBP` (key `ADAGBP`), LINK→`LINKGBP` (key `LINKGBP`). The REST endpoints (`OHLC`, `Trades`) accept the altname (e.g. `XBTGBP`) as the `pair` param directly — no need to track the classic key separately. `rest.js`'s existing `getOhlc` already reads the response generically via `Object.keys(result)[0]`, so this needs no new mapping code in `rest.js` itself.
- **CSV format** (Kraken support article 360047124832): each row is `timestamp,open,high,low,close,volume,trades`, no header row. Timestamp is UNIX seconds. Volume is in the **base asset**. "Only intervals in which trades occurred are included (gaps are not zero-filled)" — so a real gap on a thin pair (e.g. an hour with zero LINK/GBP trades) is expected, correct behavior, not a bug to paper over.
- **Trades endpoint** (`GET /0/public/Trades?pair=XBTGBP`, live-checked): returns `result[key] = [[price, volume, time, side, orderType, misc, tradeId], ...]` plus `result.last` (a nanosecond-precision timestamp string to pass as the next page's `since`). `time` is seconds with sub-second precision (e.g. `1794946341.436875`). Volume is base-asset, matching the CSV.
- **Quarterly zips**: per the user's call, importing the last 2 quarterly OHLCVT zips (e.g. 2026Q2 + 2026Q3) plus REST's ~30-day OHLC window plus a trades-rebuilt bridge for the gap between them comfortably covers 6+ months. The user downloads these manually (not fetched by the assistant) and gives their local path(s).
- **`unzip` and `zip` are both installed** on this Pi (confirmed) — `zip` is used only to build small synthetic fixture zips in tests, `unzip` is used by the real orchestrator script.

## Global Constraints

- **Completed candles only** — a forming/in-progress candle at any timeframe (1h, 4h, 1d) must never be written to the DB.
- **No ORM** — `better-sqlite3` prepared statements only.
- **Atomic writes for any shared JSON** (write `.tmp` then rename) — not triggered by this milestone (no JSON files are written), noted for completeness.
- `src/engine/` purity rule doesn't apply here (this is `src/data/`), but the same discipline is followed anyway: `candles.js` takes plain data in and returns plain data out, no network/DB/clock inside it.
- Tests run via `node --test test/` (existing convention: flat files in `test/`, `'use strict'`, `node:test` + `node:assert/strict`).
- v1 files stay until their v2 equivalent exists, then get deleted (`CLAUDE.md`) — `binance.js`'s v2 equivalent (`rest.js#getOhlc` + `data/candles.js`) exists by the end of this plan, so it and its test get deleted in the last task.

## Review Focus

- A thin pair (LINK/GBP) can have genuine zero-trade hours — the gap-check must report these honestly as gaps, not crash or silently zero-fill them, and the aggregator must not treat a sparse 4h/1d bucket as invalid just because it has fewer than 4/24 child candles.
- The trades-endpoint pagination must stop advancing once `since` stops changing (end of available trades) instead of looping forever, and must never include the trailing partial hour that straddles the requested range's end.
- CSV import must reject/skip a row with an obviously malformed line (wrong field count or non-numeric fields) rather than crashing the whole import or silently inserting `NaN`.
- `upsertCandles` must be idempotent — re-importing the same CSV or re-running the REST OHLC pull twice must not create duplicate rows or corrupt existing ones (the `(coin, timeframe, ts)` primary key plus `ON CONFLICT ... DO UPDATE` is the mechanism; a test must prove the second insert overwrites rather than duplicating).
- 4h/1d aggregation must never mark the newest bucket `closed: true` purely because it reached 4 or 24 child rows if the bucket's end time hasn't actually elapsed relative to the data's latest timestamp — closedness is a time condition, not a row-count condition.

---

## Task 1: SQLite candle store (`src/data/db.js`)

**Files:**
- Create: `src/data/db.js`
- Test: `test/data-db.test.js`

**Interfaces:**
- Produces: `openDb(dbPath?)` → a `better-sqlite3` `Database` instance with the `candles` table created; `upsertCandles(db, rows)` where each row is `{ coin, timeframe, ts, open, high, low, close, volume, trades }` (`trades` may be `null`) → inserts or updates on `(coin, timeframe, ts)` conflict, returns the number of rows passed in; `getCandles(db, coin, timeframe, fromTs, toTs)` → array of rows ordered by `ts` ascending; `getLastCandleTime(db, coin, timeframe)` → latest `ts` or `null` if none; `getExistingTimes(db, coin, timeframe, fromTs, toTs)` → array of `ts` values in range, ascending. `DEFAULT_DB_PATH` (string, `data/cryptodash-v2.db`, distinct from v1's `data/crypto.db` so both can coexist during the migration).
- Consumed by: Task 2's tests (to prove round-tripping), and `scripts/backfill-candles.js` (Task 7).

- [ ] **Step 1: Write the failing tests**

Create `test/data-db.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, upsertCandles, getCandles, getLastCandleTime, getExistingTimes } = require('../src/data/db');

function freshDb() {
  return openDb(':memory:');
}

test('getLastCandleTime returns null when no candles exist', () => {
  const db = freshDb();
  assert.equal(getLastCandleTime(db, 'BTC', '1h'), null);
});

test('upsertCandles inserts rows and getCandles reads them back in order', () => {
  const db = freshDb();
  const rows = [
    { coin: 'BTC', timeframe: '1h', ts: 2000, open: 2, high: 3, low: 1, close: 2.5, volume: 10, trades: 5 },
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 8, trades: 3 },
  ];

  const count = upsertCandles(db, rows);

  assert.equal(count, 2);
  const result = getCandles(db, 'BTC', '1h', 0, 3000);
  assert.deepEqual(result.map((r) => r.ts), [1000, 2000]);
  assert.equal(result[0].close, 1.5);
  assert.equal(getLastCandleTime(db, 'BTC', '1h'), 2000);
});

test('upsertCandles is idempotent: re-inserting the same ts updates instead of duplicating', () => {
  const db = freshDb();
  upsertCandles(db, [{ coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 8, trades: 3 }]);
  upsertCandles(db, [{ coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2.5, low: 0.5, close: 1.9, volume: 9, trades: 4 }]);

  const result = getCandles(db, 'BTC', '1h', 0, 3000);

  assert.equal(result.length, 1);
  assert.equal(result[0].close, 1.9);
  assert.equal(result[0].volume, 9);
});

test('candles are isolated per coin and per timeframe', () => {
  const db = freshDb();
  upsertCandles(db, [
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: 1 },
    { coin: 'ETH', timeframe: '1h', ts: 1000, open: 2, high: 2, low: 2, close: 2, volume: 2, trades: 2 },
    { coin: 'BTC', timeframe: '4h', ts: 1000, open: 3, high: 3, low: 3, close: 3, volume: 3, trades: 3 },
  ]);

  assert.equal(getCandles(db, 'BTC', '1h', 0, 3000).length, 1);
  assert.equal(getCandles(db, 'BTC', '1h', 0, 3000)[0].close, 1);
  assert.equal(getCandles(db, 'ETH', '1h', 0, 3000)[0].close, 2);
  assert.equal(getCandles(db, 'BTC', '4h', 0, 3000)[0].close, 3);
});

test('getExistingTimes returns just the ts column in range, ascending', () => {
  const db = freshDb();
  upsertCandles(db, [
    { coin: 'BTC', timeframe: '1h', ts: 3000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
    { coin: 'BTC', timeframe: '1h', ts: 5000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
  ]);

  assert.deepEqual(getExistingTimes(db, 'BTC', '1h', 0, 4000), [1000, 3000]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data-db.test.js`
Expected: FAIL — `Cannot find module '../src/data/db'`

- [ ] **Step 3: Write the implementation**

Create `src/data/db.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data-db.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/data/db.js test/data-db.test.js
git commit -m "feat(data): add v2 candle store schema (coin, timeframe, ts primary key)"
```

---

## Task 2: CSV parsing (`src/data/candles.js` — part 1)

**Files:**
- Create: `src/data/candles.js`
- Test: `test/data-candles.test.js`

**Interfaces:**
- Produces: `parseOhlcvtCsv(csvText)` → array of `{ ts, open, high, low, close, volume, trades }` (all numbers; `ts` is an integer, the rest are floats, `trades` an integer). Malformed lines (wrong field count or a non-numeric field) are skipped, not thrown — the function returns `{ rows, skipped }` where `skipped` is the count of lines it dropped, so a caller can log how many were rejected without the whole import failing.
- Consumed by: Task 7's orchestrator script, which inserts `rows` via `coin`/`timeframe` it already knows (the CSV itself has no coin/timeframe column).

- [ ] **Step 1: Write the failing tests**

Create `test/data-candles.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOhlcvtCsv } = require('../src/data/candles');

test('parseOhlcvtCsv parses timestamp,open,high,low,close,volume,trades rows with no header', () => {
  const csv = [
    '1700000000,100.1,101.5,99.8,100.9,12.34,7',
    '1700003600,100.9,102.0,100.5,101.8,9.5,4',
  ].join('\n');

  const { rows, skipped } = parseOhlcvtCsv(csv);

  assert.equal(skipped, 0);
  assert.deepEqual(rows, [
    { ts: 1700000000, open: 100.1, high: 101.5, low: 99.8, close: 100.9, volume: 12.34, trades: 7 },
    { ts: 1700003600, open: 100.9, high: 102.0, low: 100.5, close: 101.8, volume: 9.5, trades: 4 },
  ]);
});

test('parseOhlcvtCsv skips malformed lines and reports how many were skipped', () => {
  const csv = [
    '1700000000,100.1,101.5,99.8,100.9,12.34,7',
    'not,a,valid,row',
    '1700003600,100.9,102.0,100.5,101.8,9.5,4',
    '',
  ].join('\n');

  const { rows, skipped } = parseOhlcvtCsv(csv);

  assert.equal(rows.length, 2);
  assert.equal(skipped, 1);
});

test('parseOhlcvtCsv returns an empty result for an empty string', () => {
  assert.deepEqual(parseOhlcvtCsv(''), { rows: [], skipped: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data-candles.test.js`
Expected: FAIL — `Cannot find module '../src/data/candles'`

- [ ] **Step 3: Write the implementation**

Create `src/data/candles.js`:

```js
'use strict';

function parseOhlcvtCsv(csvText) {
  const rows = [];
  let skipped = 0;
  for (const line of csvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(',');
    if (fields.length !== 7) {
      skipped += 1;
      continue;
    }
    const [ts, open, high, low, close, volume, trades] = fields.map(Number);
    if ([ts, open, high, low, close, volume, trades].some(Number.isNaN)) {
      skipped += 1;
      continue;
    }
    rows.push({ ts, open, high, low, close, volume, trades });
  }
  return { rows, skipped };
}

module.exports = { parseOhlcvtCsv };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data-candles.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/data/candles.js test/data-candles.test.js
git commit -m "feat(data): add Kraken OHLCVT CSV parser"
```

---

## Task 3: 1h → 4h/1d aggregation (`src/data/candles.js` — part 2)

**Files:**
- Modify: `src/data/candles.js`
- Test: `test/data-candles.test.js` (append)

**Interfaces:**
- Produces: `aggregateCandles(candles1h, bucketSeconds)` → array of `{ ts, open, high, low, close, volume, trades, closed }`, one row per bucket that has at least one child candle, sorted by `ts` ascending. `candles1h` must already be sorted by `ts` ascending (the caller — `db.js`'s `getCandles` — already returns rows in that order). `trades` is the sum of child `trades` values, or `null` if every child candle's `trades` is `null`. A bucket is `closed: true` only if `bucketEnd (= bucketStart + bucketSeconds) <= lastChildTs + 3600` (i.e. the latest 1h candle we have ends at or after this bucket's own end — so we're not guessing about data that hasn't arrived yet) — closedness is a time condition, not a row-count condition, so a bucket with only 1 of 4 expected hourly rows is still `closed: true` if the clock has moved past it (matches Review Focus item 1 and 5).
- Consumed by: Task 7's orchestrator (builds 4h with `bucketSeconds = 14400`, 1d with `86400`), and `getLastCandleTime`/`upsertCandles` from Task 1 to store only the `closed` rows.

- [ ] **Step 1: Write the failing tests**

Append to `test/data-candles.test.js`:

```js
const { aggregateCandles } = require('../src/data/candles');

test('aggregateCandles builds one 4h bucket from four 1h candles aligned to UTC', () => {
  // 1970-01-01T00:00:00Z is itself a 4h boundary, so epoch-second bucketing
  // naturally aligns to 00/04/08/12/16/20 UTC without extra calendar math.
  const hour = 3600;
  const candles1h = [0, 1, 2, 3].map((i) => ({
    ts: i * hour, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 1, trades: 2,
  }));

  const result = aggregateCandles(candles1h, 4 * hour);

  assert.equal(result.length, 1);
  const bucket = result[0];
  assert.equal(bucket.ts, 0);
  assert.equal(bucket.open, 10); // first child's open
  assert.equal(bucket.close, 13.5); // last child's close
  assert.equal(bucket.high, 14); // max of the four highs
  assert.equal(bucket.low, 9); // min of the four lows
  assert.equal(bucket.volume, 4);
  assert.equal(bucket.trades, 8);
  assert.equal(bucket.closed, true); // bucket ends at 4h, last child ends at 4h too
});

test('aggregateCandles marks the newest bucket unclosed if the clock has not passed its end yet', () => {
  const hour = 3600;
  // Only 2 of the 4 hours a full 4h bucket would need have arrived so far.
  const candles1h = [0, 1].map((i) => ({
    ts: i * hour, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: 1,
  }));

  const result = aggregateCandles(candles1h, 4 * hour);

  assert.equal(result.length, 1);
  assert.equal(result[0].closed, false);
});

test('aggregateCandles still closes a sparse bucket (fewer than 4 child rows) once time has passed it', () => {
  const hour = 3600;
  // Only hour 0 traded (a real gap, not zero-filled) but hour 5 has already arrived,
  // meaning the clock is well past the first 4h bucket's end at hour 4.
  const candles1h = [
    { ts: 0, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: 1 },
    { ts: 5 * hour, open: 20, high: 21, low: 19, close: 20.5, volume: 1, trades: 1 },
  ];

  const result = aggregateCandles(candles1h, 4 * hour);

  const firstBucket = result.find((b) => b.ts === 0);
  assert.equal(firstBucket.closed, true);
  assert.equal(firstBucket.trades, 1); // only the one child row that actually traded
});

test('aggregateCandles treats a null trades value as contagious only when every child is null', () => {
  const hour = 3600;
  const candles1h = [
    { ts: 0, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: null },
    { ts: hour, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: null },
    { ts: 2 * hour, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: null },
    { ts: 3 * hour, open: 10, high: 11, low: 9, close: 10.5, volume: 1, trades: null },
  ];

  const result = aggregateCandles(candles1h, 4 * hour);

  assert.equal(result[0].trades, null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-candles.test.js`
Expected: FAIL — `aggregateCandles is not a function` (or not exported)

- [ ] **Step 3: Implement**

In `src/data/candles.js`, add:

```js
function aggregateCandles(candles1h, bucketSeconds) {
  if (candles1h.length === 0) return [];
  const lastChildTs = candles1h[candles1h.length - 1].ts;
  const buckets = new Map();

  for (const c of candles1h) {
    const bucketStart = Math.floor(c.ts / bucketSeconds) * bucketSeconds;
    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, { ts: bucketStart, children: [] });
    }
    buckets.get(bucketStart).children.push(c);
  }

  const result = [];
  for (const [bucketStart, { children }] of buckets) {
    children.sort((a, b) => a.ts - b.ts);
    const first = children[0];
    const last = children[children.length - 1];
    const allTradesNull = children.every((c) => c.trades === null || c.trades === undefined);
    result.push({
      ts: bucketStart,
      open: first.open,
      close: last.close,
      high: Math.max(...children.map((c) => c.high)),
      low: Math.min(...children.map((c) => c.low)),
      volume: children.reduce((sum, c) => sum + c.volume, 0),
      trades: allTradesNull ? null : children.reduce((sum, c) => sum + (c.trades || 0), 0),
      closed: bucketStart + bucketSeconds <= lastChildTs + 3600,
    });
  }
  return result.sort((a, b) => a.ts - b.ts);
}

module.exports = { parseOhlcvtCsv, aggregateCandles };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-candles.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/data/candles.js test/data-candles.test.js
git commit -m "feat(data): add 1h to 4h/1d aggregation, UTC-aligned, time-based closedness"
```

---

## Task 4: Gap detection (`src/data/candles.js` — part 3)

**Files:**
- Modify: `src/data/candles.js`
- Test: `test/data-candles.test.js` (append)

**Interfaces:**
- Produces: `findGapHours(existingTs, fromTs, toTs, stepSeconds = 3600)` → sorted array of expected timestamps in `[fromTs, toTs]` (inclusive, stepping by `stepSeconds`) that are **not** present in `existingTs` (an array or `Set` of timestamps). Pure function, no DB access — callers pass in whatever `db.js#getExistingTimes` returned.
- Consumed by: Task 7's orchestrator, to build the gap-check report per coin.

- [ ] **Step 1: Write the failing tests**

Append to `test/data-candles.test.js`:

```js
const { findGapHours } = require('../src/data/candles');

test('findGapHours returns every expected step when nothing exists', () => {
  const hour = 3600;
  assert.deepEqual(findGapHours([], 0, 2 * hour, hour), [0, hour, 2 * hour]);
});

test('findGapHours returns nothing when every step is present', () => {
  const hour = 3600;
  assert.deepEqual(findGapHours([0, hour, 2 * hour], 0, 2 * hour, hour), []);
});

test('findGapHours reports only the missing steps, honoring real no-trade gaps', () => {
  const hour = 3600;
  // Hour 1 genuinely has no candle (e.g. a thin pair with zero trades that hour).
  const existing = [0, 2 * hour, 3 * hour];
  assert.deepEqual(findGapHours(existing, 0, 3 * hour, hour), [hour]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-candles.test.js`
Expected: FAIL — `findGapHours is not a function`

- [ ] **Step 3: Implement**

In `src/data/candles.js`, add:

```js
function findGapHours(existingTs, fromTs, toTs, stepSeconds = 3600) {
  const existing = new Set(existingTs);
  const gaps = [];
  for (let ts = fromTs; ts <= toTs; ts += stepSeconds) {
    if (!existing.has(ts)) gaps.push(ts);
  }
  return gaps;
}

module.exports = { parseOhlcvtCsv, aggregateCandles, findGapHours };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-candles.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/data/candles.js test/data-candles.test.js
git commit -m "feat(data): add pure gap-hour detection"
```

---

## Task 5: Trades endpoint + trades→hourly-candle building

**Files:**
- Modify: `src/kraken/rest.js`
- Modify: `src/data/candles.js`
- Test: `test/kraken-rest.test.js` (append), `test/data-candles.test.js` (append)

**Interfaces:**
- Produces on the REST client: `getTrades(pair, { since } = {})` → `{ trades: [{ price, volume, time }], last }` (`time` is seconds, possibly fractional; `last` is the opaque string Kraken returns, to be passed verbatim as the next page's `since` — never re-derive it from `time`, Kraken's `last` carries extra precision a float can't hold).
- Produces in `candles.js`: `buildCandlesFromTrades(trades, rangeEndTs)` → array of `{ ts, open, high, low, close, volume, trades, closed: true }` hourly candles, one per hour bucket that is **fully inside** `[minBucketStart, rangeEndTs)` — i.e. any bucket whose end (`bucketStart + 3600`) is `> rangeEndTs` is dropped (it's either the forming hour or past the range the caller asked to bridge). `trades` here is the count of trades in that hour (not `null` — we always know this exactly when building from raw trades).
- Consumed by: Task 7's orchestrator, to bridge the gap between the CSV import and the REST OHLC window.

- [ ] **Step 1: Write the failing tests**

Append to `test/kraken-rest.test.js`:

```js
test('getTrades fetches /0/public/Trades and normalizes rows, passing through last verbatim', async () => {
  const server = await startMockServer((req, res) => {
    res.end(JSON.stringify({
      error: [],
      result: {
        XBTGBP: [
          ['50000.1', '0.05', 1700000000.123, 'b', 'l', '', 1],
          ['50001.2', '0.02', 1700000010.456, 's', 'm', '', 2],
        ],
        last: '1700000010456000000',
      },
    }));
  });
  const { port } = server.address();
  const client = createRestClient({ baseUrl: `http://127.0.0.1:${port}` });

  const { trades, last } = await client.getTrades('XBTGBP', {});

  assert.deepEqual(trades, [
    { price: 50000.1, volume: 0.05, time: 1700000000.123 },
    { price: 50001.2, volume: 0.02, time: 1700000010.456 },
  ]);
  assert.equal(last, '1700000010456000000');
  server.close();
});

test('getTrades passes since through as a query param', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    captured = req.url;
    res.end(JSON.stringify({ error: [], result: { XBTGBP: [], last: '0' } }));
  });
  const { port } = server.address();
  const client = createRestClient({ baseUrl: `http://127.0.0.1:${port}` });

  await client.getTrades('XBTGBP', { since: '1700000000000000000' });

  assert.equal(captured, '/0/public/Trades?pair=XBTGBP&since=1700000000000000000');
  server.close();
});
```

Append to `test/data-candles.test.js`:

```js
const { buildCandlesFromTrades } = require('../src/data/candles');

test('buildCandlesFromTrades buckets trades into hourly OHLCV, dropping the trailing partial hour', () => {
  const hour = 3600;
  const trades = [
    { price: 100, volume: 1, time: 0 },
    { price: 102, volume: 2, time: 1800 },
    { price: 101, volume: 1, time: 3599 },
    { price: 105, volume: 1, time: hour }, // starts the next hour
    { price: 106, volume: 1, time: hour + 10 }, // this hour is NOT fully inside the range below
  ];

  const result = buildCandlesFromTrades(trades, 2 * hour - 1); // range ends just before hour 2 closes

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    ts: 0, open: 100, high: 102, low: 100, close: 101, volume: 4, trades: 3, closed: true,
  });
  assert.deepEqual(result[1], {
    ts: hour, open: 105, high: 106, low: 105, close: 106, volume: 2, trades: 2, closed: true,
  });
});

test('buildCandlesFromTrades returns nothing for an empty trades list', () => {
  assert.deepEqual(buildCandlesFromTrades([], 10000), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/kraken-rest.test.js test/data-candles.test.js`
Expected: FAIL — `client.getTrades is not a function` and `buildCandlesFromTrades is not a function`

- [ ] **Step 3: Implement `getTrades` in `src/kraken/rest.js`**

Add before the final `return` in `createRestClient`:

```js
  async function getTrades(pair, { since } = {}) {
    const params = { pair };
    if (since !== undefined) params.since = since;
    const result = await publicRequest('Trades', params);
    const { last, ...rest } = result;
    const rows = rest[Object.keys(rest)[0]];
    const trades = rows.map(([price, volume, time]) => ({
      price: Number(price), volume: Number(volume), time,
    }));
    return { trades, last };
  }
```

Update the final `return` statement to include `getTrades`.

- [ ] **Step 4: Implement `buildCandlesFromTrades` in `src/data/candles.js`**

Add:

```js
function buildCandlesFromTrades(trades, rangeEndTs) {
  const buckets = new Map();
  for (const t of trades) {
    const bucketStart = Math.floor(t.time / 3600) * 3600;
    if (bucketStart + 3600 > rangeEndTs) continue; // forming or out-of-range hour
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart).push(t);
  }

  const result = [];
  for (const [bucketStart, bucketTrades] of buckets) {
    bucketTrades.sort((a, b) => a.time - b.time);
    result.push({
      ts: bucketStart,
      open: bucketTrades[0].price,
      close: bucketTrades[bucketTrades.length - 1].price,
      high: Math.max(...bucketTrades.map((t) => t.price)),
      low: Math.min(...bucketTrades.map((t) => t.price)),
      volume: bucketTrades.reduce((sum, t) => sum + t.volume, 0),
      trades: bucketTrades.length,
      closed: true,
    });
  }
  return result.sort((a, b) => a.ts - b.ts);
}

module.exports = { parseOhlcvtCsv, aggregateCandles, findGapHours, buildCandlesFromTrades };
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/kraken-rest.test.js test/data-candles.test.js`
Expected: PASS (all tests in both files)

- [ ] **Step 6: Commit**

```bash
git add src/kraken/rest.js src/data/candles.js test/kraken-rest.test.js test/data-candles.test.js
git commit -m "feat(kraken,data): add Trades endpoint and trades-to-hourly-candle builder"
```

---

## Task 6: Zip extraction + CSV file discovery

**Files:**
- Create: `src/data/ohlcvtImport.js`
- Test: `test/data-ohlcvt-import.test.js`

**Interfaces:**
- Produces: `extractZip(zipPath, destDir)` → runs the system `unzip` (via `child_process.execFileSync('unzip', ['-o', zipPath, '-d', destDir])`), returns nothing, throws if `unzip` exits non-zero. `findCsvFile(destDir, altname, intervalMinutes)` → the absolute path to the matching `${altname}_${intervalMinutes}.csv` file, searched recursively under `destDir` (case-insensitive filename match), or throws a descriptive error listing the `.csv` filenames it did find if there's no match (so a naming-convention surprise in the real zip fails loudly with useful info, not a silent `undefined`).
- Consumed by: Task 7's orchestrator script.

- [ ] **Step 1: Write the failing tests**

Create `test/data-ohlcvt-import.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { extractZip, findCsvFile } = require('../src/data/ohlcvtImport');

function makeFixtureZip() {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-src-'));
  fs.writeFileSync(path.join(srcDir, 'XBTGBP_60.csv'), '1700000000,1,2,3,4,5,6\n');
  fs.writeFileSync(path.join(srcDir, 'ETHGBP_60.csv'), '1700000000,1,2,3,4,5,6\n');
  fs.writeFileSync(path.join(srcDir, 'XBTGBP_1440.csv'), '1700000000,1,2,3,4,5,6\n');
  const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-zip-')), 'fixture.zip');
  execFileSync('zip', ['-j', zipPath, ...fs.readdirSync(srcDir).map((f) => path.join(srcDir, f))]);
  return zipPath;
}

test('extractZip unzips into destDir', () => {
  const zipPath = makeFixtureZip();
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-dest-'));

  extractZip(zipPath, destDir);

  assert.ok(fs.existsSync(path.join(destDir, 'XBTGBP_60.csv')));
  assert.ok(fs.existsSync(path.join(destDir, 'ETHGBP_60.csv')));
});

test('findCsvFile locates the right interval file for a pair', () => {
  const zipPath = makeFixtureZip();
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-dest-'));
  extractZip(zipPath, destDir);

  const found = findCsvFile(destDir, 'XBTGBP', 60);

  assert.equal(path.basename(found), 'XBTGBP_60.csv');
});

test('findCsvFile throws a descriptive error when no match exists, listing what it did find', () => {
  const zipPath = makeFixtureZip();
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-dest-'));
  extractZip(zipPath, destDir);

  assert.throws(
    () => findCsvFile(destDir, 'DOGEGBP', 60),
    (err) => err.message.includes('DOGEGBP_60.csv') && err.message.includes('XBTGBP_60.csv'),
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/data-ohlcvt-import.test.js`
Expected: FAIL — `Cannot find module '../src/data/ohlcvtImport'`

- [ ] **Step 3: Implement**

Create `src/data/ohlcvtImport.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-o', zipPath, '-d', destDir]);
}

function walkCsvFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCsvFiles(full));
    else if (entry.name.toLowerCase().endsWith('.csv')) out.push(full);
  }
  return out;
}

function findCsvFile(destDir, altname, intervalMinutes) {
  const wanted = `${altname}_${intervalMinutes}.csv`.toLowerCase();
  const candidates = walkCsvFiles(destDir);
  const match = candidates.find((f) => path.basename(f).toLowerCase() === wanted);
  if (!match) {
    const found = candidates.map((f) => path.basename(f)).join(', ') || '(no .csv files found at all)';
    throw new Error(`No file named ${altname}_${intervalMinutes}.csv under ${destDir}. Found: ${found}`);
  }
  return match;
}

module.exports = { extractZip, findCsvFile };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/data-ohlcvt-import.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/data/ohlcvtImport.js test/data-ohlcvt-import.test.js
git commit -m "feat(data): add OHLCVT zip extraction and CSV file discovery"
```

---

## Task 7: Backfill orchestrator script

**Files:**
- Create: `scripts/backfill-candles.js`

**Interfaces:**
- Consumes: everything from Tasks 1–6 (`db.js`, `candles.js`, `ohlcvtImport.js`, `rest.js#getTrades`/`getOhlc`).
- Produces: a CLI script (not unit-tested — it's a one-off orchestrator wiring already-tested pure/IO pieces together; the orchestration itself is proven by the real run in Task 9) run as `node scripts/backfill-candles.js <zip1> [<zip2> ...]`.

- [ ] **Step 1: Write the script**

Create `scripts/backfill-candles.js`:

```js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDb, upsertCandles, getLastCandleTime, getExistingTimes, getCandles } = require('../src/data/db');
const { parseOhlcvtCsv, aggregateCandles, findGapHours, buildCandlesFromTrades } = require('../src/data/candles');
const { extractZip, findCsvFile } = require('../src/data/ohlcvtImport');
const { createRestClient } = require('../src/kraken/rest');

const COINS = {
  BTC: 'XBTGBP', ETH: 'ETHGBP', SOL: 'SOLGBP',
  XRP: 'XRPGBP', ADA: 'ADAGBP', LINK: 'LINKGBP',
};
const HOUR = 3600;
const SIX_MONTHS_SECONDS = 186 * 24 * HOUR;

async function importCsvZips(db, zipPaths) {
  for (const zipPath of zipPaths) {
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-'));
    console.log(`Extracting ${zipPath} -> ${destDir}`);
    extractZip(zipPath, destDir);
    for (const [coin, altname] of Object.entries(COINS)) {
      const csvPath = findCsvFile(destDir, altname, 60);
      const csvText = fs.readFileSync(csvPath, 'utf8');
      const { rows, skipped } = parseOhlcvtCsv(csvText);
      const dbRows = rows.map((r) => ({ coin, timeframe: '1h', ...r }));
      const count = upsertCandles(db, dbRows);
      console.log(`  ${coin}: imported ${count} rows from ${path.basename(csvPath)} (${skipped} skipped)`);
    }
  }
}

async function pullRecentFromRest(db, client) {
  for (const [coin, altname] of Object.entries(COINS)) {
    const { candles } = await client.getOhlc(altname, { interval: 60 });
    const closedRows = candles.filter((c) => c.closed).map((c) => ({ coin, timeframe: '1h', ...c }));
    const count = upsertCandles(db, closedRows);
    console.log(`${coin}: imported ${count} closed candles from REST OHLC`);
  }
}

async function bridgeGaps(db, client, csvEndByCoin) {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  for (const [coin, altname] of Object.entries(COINS)) {
    const csvEnd = csvEndByCoin[coin]; // last ts from the CSV import, captured before the REST pull ran
    const restStart = getFirstRestTs(db, coin, nowHour);
    if (csvEnd === null || restStart === null || csvEnd + HOUR >= restStart) continue; // no gap to bridge

    console.log(`${coin}: bridging gap ${new Date(csvEnd * 1000).toISOString()} -> ${new Date(restStart * 1000).toISOString()}`);
    let since = String(csvEnd * 1_000_000_000); // Kraken 'since' is nanoseconds
    let lastSince = null;
    const rangeEnd = restStart;
    while (since !== lastSince) {
      const { trades, last } = await client.getTrades(altname, { since });
      if (trades.length === 0) break;
      const candles = buildCandlesFromTrades(trades, rangeEnd);
      if (candles.length > 0) {
        upsertCandles(db, candles.map((c) => ({ coin, timeframe: '1h', ...c })));
      }
      lastSince = since;
      since = last;
      if (trades[trades.length - 1].time >= rangeEnd) break;
    }
  }
}

function getFirstRestTs(db, coin, nowHour) {
  const existing = getExistingTimes(db, coin, '1h', nowHour - 720 * HOUR, nowHour);
  return existing.length > 0 ? existing[0] : null;
}

function reportGaps(db) {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const fromTs = nowHour - SIX_MONTHS_SECONDS;
  console.log(`\nGap report for the last 6 months (${new Date(fromTs * 1000).toISOString()} -> ${new Date(nowHour * 1000).toISOString()}):`);
  for (const coin of Object.keys(COINS)) {
    const existing = getExistingTimes(db, coin, '1h', fromTs, nowHour);
    const gaps = findGapHours(existing, fromTs, nowHour, HOUR);
    const expected = Math.floor((nowHour - fromTs) / HOUR) + 1;
    console.log(`  ${coin}: ${existing.length}/${expected} hours present, ${gaps.length} missing`);
    if (gaps.length > 0 && gaps.length <= 20) {
      console.log(`    missing: ${gaps.map((ts) => new Date(ts * 1000).toISOString()).join(', ')}`);
    } else if (gaps.length > 20) {
      console.log(`    missing (first 10): ${gaps.slice(0, 10).map((ts) => new Date(ts * 1000).toISOString()).join(', ')} ...`);
    }
  }
}

function buildHigherTimeframes(db) {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const fromTs = nowHour - SIX_MONTHS_SECONDS;
  for (const coin of Object.keys(COINS)) {
    const hourly = getCandles(db, coin, '1h', fromTs, nowHour);
    for (const [timeframe, seconds] of [['4h', 4 * HOUR], ['1d', 24 * HOUR]]) {
      const built = aggregateCandles(hourly, seconds).filter((c) => c.closed);
      upsertCandles(db, built.map((c) => ({ coin, timeframe, ...c })));
      console.log(`${coin}: built ${built.length} ${timeframe} candles`);
    }
  }
}

async function main() {
  const zipPaths = process.argv.slice(2);
  if (zipPaths.length === 0) {
    console.error('Usage: node scripts/backfill-candles.js <zip1> [<zip2> ...]');
    process.exit(1);
  }
  const db = openDb();
  const client = createRestClient({});

  await importCsvZips(db, zipPaths);
  // Capture each coin's last CSV-era ts *before* the REST pull extends the DB's
  // max ts for that coin — bridgeGaps needs the CSV boundary, not the post-pull one.
  const csvEndByCoin = {};
  for (const coin of Object.keys(COINS)) csvEndByCoin[coin] = getLastCandleTime(db, coin, '1h');

  await pullRecentFromRest(db, client);
  await bridgeGaps(db, client, csvEndByCoin);
  buildHigherTimeframes(db);
  reportGaps(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Sanity-check the script loads without a syntax error**

Run: `node -e "require('./scripts/backfill-candles.js')" </dev/null; echo "exit: $?"`
Expected: the script prints its usage message and exits 1 (no zip args given) — proves it loads and runs its argument check, not a syntax/require error.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-candles.js
git commit -m "feat(data): add backfill orchestrator script (CSV import, REST pull, gap bridge, report)"
```

---

## Task 8: Delete v1's `binance.js`

**Files:**
- Delete: `binance.js`, `test/binance.test.js`

v2's equivalent now exists (`src/kraken/rest.js#getOhlc` for the REST pull, `src/data/candles.js` + `scripts/backfill-candles.js` for backfill/aggregation), so per `CLAUDE.md`'s v1→v2 rule this file is deleted now. `server.js` (v1's Express app) still `require('./binance')` — that's fine to leave dangling: the v1 `crypto-dashboard` systemd service is already stopped and disabled (confirmed via `systemctl is-active crypto-dashboard` → `inactive`), and `server.js` itself gets replaced wholesale in a later milestone (7+), not touched here.

- [ ] **Step 1: Confirm nothing in `src/` or `scripts/` depends on `binance.js`**

Run: `grep -rn "require.*binance" src/ scripts/ test/ --include=*.js`
Expected: only `test/binance.test.js` and `server.js` (outside `src/`/`scripts/`) reference it — confirming the deletion is isolated to v1's own files.

- [ ] **Step 2: Delete the files**

```bash
git rm binance.js test/binance.test.js
```

- [ ] **Step 3: Run the full test suite to confirm nothing else broke**

Run: `node --test test/`
Expected: same pass/skip counts as before, minus `binance.test.js`'s 3 tests (2 of which were already failing pre-existing v1 issues, unrelated to this change) — no new failures.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: delete v1 binance.js now that v2's candle store replaces it"
```

---

## Task 9: Run the real backfill and confirm the "done when" criteria

This is the manual step that needs the user's downloaded zip files.

- [ ] **Step 1: Get the zip paths from the user**

Ask for the local paths to the two quarterly OHLCVT zips they downloaded (2026Q2 + 2026Q3), e.g. `/home/gallus23/Downloads/Kraken_OHLCVT_2026Q2.zip`.

- [ ] **Step 2: Run the backfill**

Run: `node scripts/backfill-candles.js <zip1> <zip2>`

Watch the output for:
- Each coin's CSV import count (per zip) and any skipped-line counts.
- Each coin's REST OHLC pull count.
- Any gap-bridge activity (should be small — a few weeks at most, from end of Q3 2026 to the start of the REST OHLC window).
- The final gap report.

- [ ] **Step 3: If the real CSV filenames don't match `${altname}_60.csv`**

`findCsvFile`'s error message lists every `.csv` filename it actually found — use that to confirm the real naming convention. If it differs (e.g. a different separator or case), fix `findCsvFile`'s matching in `src/data/ohlcvtImport.js`, add a regression test for the real pattern observed, and re-run.

- [ ] **Step 4: Confirm the done-when criteria**

- 6+ months of 1h candles exist per coin: `sqlite3 data/cryptodash-v2.db "SELECT coin, MIN(ts), MAX(ts), COUNT(*) FROM candles WHERE timeframe='1h' GROUP BY coin;"` — `MAX(ts) - MIN(ts)` should be ≥ ~186 days in seconds for every coin.
- The gap report from Step 2 is readable and, for BTC/ETH (the most liquid pairs), shows zero or near-zero missing hours. Thinner pairs (LINK, ADA) may show some genuine no-trade gaps — that's expected per Kraken's own "gaps are not zero-filled" note, not a defect.
- 4h and 1d candles exist: `sqlite3 data/cryptodash-v2.db "SELECT timeframe, COUNT(*) FROM candles GROUP BY timeframe;"` shows non-zero counts for `1h`, `4h`, and `1d`.

Report the actual gap numbers back — if any coin has a suspiciously large gap (e.g. hundreds of missing hours, not a handful), that's a real bug to debug (systematic-debugging), not something to wave through.

---

## Milestone 2 exit check

- [ ] `node --test test/` passes (offline tests green; no new failures beyond the pre-existing, unrelated v1 ones already accepted in milestone 1).
- [ ] `scripts/backfill-candles.js` run against the user's real zip files, with a gap report reviewed by the user.
- [ ] `binance.js` and its test deleted.
- [ ] `data/cryptodash-v2.db` holds 6+ months of 1h candles for all 6 coins, plus 4h/1d built from them.
