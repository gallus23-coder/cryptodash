# Charts API (Milestone 7, Part C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Express endpoints the Charts tab (design §8.1) needs: candles, chart markers (trades + candidates), and regime history/current. No UI in this part; the next part builds the chart against this API, same split as the Decision log tab.

**Architecture:** `GET /api/candles` is nearly free — `getCandles` already exists from milestone 2 and is exactly the shape this endpoint needs. Markers need two new coin-scoped read functions (`trades` and `candidates` currently have no "by coin" query, only "by mode" or "by id"). Regime history is the interesting gap: design §7 lists a `regimes` table that was never built — `computeRegimeSeries` (milestone 3) is a pure function recomputed fresh every hour inside `runCycle` and discarded after use, with only the single current label persisted (`cycle_log.regime_label`). Rather than add a new table and a migration to backfill it (which can't actually backfill — the per-bar regime metrics for past hours were never stored, only the final label), this plan serves regime *history* directly from `cycle_log`'s existing `(ts, regime_label)` pairs, which already cover every real hour since milestone 5 started running, and serves the regime *current* endpoint by recomputing live with the exact same `computeRegimeSeries` call `runCycle` already makes — no new storage, no backfill problem.

**Tech Stack:** Express (existing `dashboard.js`/`src/server/app.js`), `better-sqlite3`, `node --test` with real in-process HTTP requests (same pattern as every prior server task).

**Spec:** `docs/v2-design.md` §8.1 (Charts tab — candles, trade/candidate markers, regime band, indicator panel), §9 (`GET /api/candles/:coin`, `GET /api/markers/:coin`, `GET /api/regime/current`, `GET /api/regime/history`).

**Depends on:** milestone 2 (`candles` table, `getCandles`), milestone 6 (`candidates`, `decisions`, `trades` with `candidate_id`), milestone 7 Part A (`dashboard.js`, password middleware, `src/server/app.js`).

## Global Constraints

- Every endpoint scopes by `mode` (default `paper`), same as every endpoint in Part A — never mixing paper/live data, and specifically re-checking the join-scoping bug class Part A's final review caught (`decisions`/`trades`/`candidates` joined without a mode filter) since markers join across these same tables.
- No ORM — `better-sqlite3` prepared statements only.
- Completed candles only — `getCandles` already only returns stored (closed) candles; this plan adds no new candle-writing path, so there's nothing new to get wrong here, but no endpoint in this plan should expose a forming candle either.

## Interpretation decisions

- **No `regimes` table is added.** Design §7 lists one, but nothing in milestones 1-6 ever wrote to it — `computeRegimeSeries` is pure and recomputed fresh every cycle, with only the final label persisted in `cycle_log`. A table whose rows could never be backfilled for the real history already logged (the per-bar trend/ADX/volatility/breadth metrics for past hours were never stored, only today's label) wouldn't actually solve the "show regime history" problem better than reading `cycle_log` directly, which already has one `(ts, regime_label)` row per real hour since milestone 5. If a future milestone needs the *metrics* behind historical regime labels (not just the label), that's the point to add the table — not here.
- **`GET /api/regime/current` recomputes live rather than reading a cache.** It calls `computeRegimeSeries` with the same inputs `runCycle` uses (BTC daily/4h candles, watchlist closes) — an on-demand dashboard read, not a hot path, so recomputing is cheap enough and guarantees the UI never shows a stale cached value.
- **Markers are coin-scoped, not cycle-scoped** (unlike Part A's `/api/decisions/:cycleId`) — a chart is "this coin over time," so `GET /api/markers/:coin` needs every trade and candidate for that coin across a date range, which is a new query shape (`getTradesByCoin`, `getCandidatesByCoin`) distinct from Part A's per-cycle and per-candidate-id lookups.

## Review Focus

- `GET /api/markers/:coin` must not mix modes — same bug class Part A's final review found and fixed in the scorecard/expanded-view joins; this plan's new coin-scoped queries must filter by `mode` directly (they're not joins across tables that could each have a different mode, but the discipline is the same: never read `trades`/`candidates` without a `mode` clause).
- `GET /api/regime/history` must return data for every real hour that has a `cycle_log` row, including the overwhelming majority that are `risk_off` — a thin result that only shows "interesting" regimes would make the band chart look like there are gaps in monitoring when there aren't.
- `GET /api/candles/:coin?tf=` with an invalid/unsupported `tf` value (anything other than `1h`/`4h`/`1d`) must return a sensible empty result or a `400`, not silently default to the wrong timeframe's data.
- A coin with zero trades and zero candidates in the requested range (true for most coins most of the time right now) must return `{ trades: [], candidates: [] }`, not an error — an empty chart overlay is valid, common data.

---

## Task 1: `GET /api/candles/:coin`

**Files:**
- Modify: `src/server/app.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `GET /api/candles/:coin?tf=1h&from=&to=` → `200` with an array of `{ ts, open, high, low, close, volume }` (from the existing `getCandles`). Unsupported `tf` → `400`.
- Consumed by: Part D's chart renderer (not this plan).

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:

```js
const { upsertCandles } = require('../src/data/db');

test('GET /api/candles/:coin returns candles for the requested timeframe and range', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    upsertCandles(db, [
      { coin: 'BTC', timeframe: '1h', ts: 1000, open: 100, high: 101, low: 99, close: 100.5, volume: 10, trades: 5 },
      { coin: 'BTC', timeframe: '1h', ts: 2000, open: 100.5, high: 102, low: 100, close: 101, volume: 12, trades: 6 },
      { coin: 'BTC', timeframe: '4h', ts: 1000, open: 100, high: 102, low: 99, close: 101, volume: 22, trades: 11 },
    ]);
    const res = await fetch(`http://127.0.0.1:${port}/api/candles/BTC?tf=1h&from=0&to=9999`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.equal(body[0].close, 100.5);
  } finally {
    server.close();
  }
});

test('GET /api/candles/:coin rejects an unsupported timeframe with 400', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/candles/BTC?tf=5m&from=0&to=9999`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/candles/:coin defaults to from=0 and a wide "to" when not given', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    upsertCandles(db, [{ coin: 'ETH', timeframe: '1h', ts: 5000, open: 1, high: 2, low: 1, close: 1.5, volume: 1, trades: 1 }]);
    const res = await fetch(`http://127.0.0.1:${port}/api/candles/ETH?tf=1h`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` for all 3 (no such route yet).

- [ ] **Step 3: Implement**

In `src/server/app.js`, add:

```js
  const { getCandles } = require('../data/db');
  const VALID_TIMEFRAMES = ['1h', '4h', '1d'];

  app.get('/api/candles/:coin', (req, res) => {
    const { tf, from, to } = req.query;
    const timeframe = tf || '1h';
    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ error: `unsupported timeframe: ${timeframe}` });
    }
    const fromTs = from !== undefined ? Number(from) : 0;
    const toTs = to !== undefined ? Number(to) : Math.floor(Date.now() / 1000);
    res.json(getCandles(db, req.params.coin, timeframe, fromTs, toTs));
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/app.js test/server-app.test.js
git commit -m "feat(server): add GET /api/candles/:coin"
```

---

## Task 2: `GET /api/markers/:coin`

**Files:**
- Modify: `src/data/db.js`
- Modify: `src/server/app.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `getTradesByCoin(db, mode, coin, fromTs, toTs)`, `getCandidatesByCoin(db, mode, coin, fromTs, toTs)` in `src/data/db.js`. `GET /api/markers/:coin?mode=&from=&to=` → `200` with `{ trades: [...], candidates: [...] }` — `trades` are real entries/exits for the chart's ▲/▼ markers, `candidates` are every candidate (taken or not) for the small-dot markers.
- Consumed by: Part D's chart renderer.

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:

```js
test('GET /api/markers/:coin returns trades and candidates for that coin, scoped to mode', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { coin: 'SOL', ts: 1700000000 });
    insertTrade(db, {
      mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: 1700000000, exitTs: 1700050000,
      entryPrice: 98.40, exitPrice: 102.0, units: 1, riskAmount: 5, pnl: 3.6, r: 0.72, exitReason: 'target',
      candidateId: 'c_20261118_10_SOL_trend_pullback',
    });
    // A live trade for the same coin must NOT appear when mode=paper (default).
    insertTrade(db, {
      mode: 'live', coin: 'SOL', setup: 'trend_pullback', entryTs: 1700000000, exitTs: 1700050000,
      entryPrice: 98.40, exitPrice: 95.0, units: 1, riskAmount: 5, pnl: -3.4, r: -0.68, exitReason: 'stop',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/markers/SOL`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trades.length, 1);
    assert.equal(body.trades[0].r, 0.72);
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].coin, 'SOL');
  } finally {
    server.close();
  }
});

test('GET /api/markers/:coin for a coin with no activity returns empty arrays, not an error', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/markers/ADA`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { trades: [], candidates: [] });
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` for both.

- [ ] **Step 3: Implement**

In `src/data/db.js`, add:

```js
function getTradesByCoin(db, mode, coin, fromTs, toTs) {
  return db.prepare(`
    SELECT id, mode, coin, setup, entry_ts AS entryTs, exit_ts AS exitTs,
      entry_price AS entryPrice, exit_price AS exitPrice, units, risk_amount AS riskAmount,
      pnl, r, exit_reason AS exitReason, candidate_id AS candidateId
    FROM trades WHERE mode = ? AND coin = ? AND entry_ts >= ? AND entry_ts <= ?
    ORDER BY entry_ts ASC
  `).all(mode, coin, fromTs, toTs);
}

function getCandidatesByCoin(db, mode, coin, fromTs, toTs) {
  return db.prepare('SELECT * FROM candidates WHERE mode = ? AND coin = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC')
    .all(mode, coin, fromTs, toTs).map(rowToCandidate);
}
```

Add both to `module.exports`.

In `src/server/app.js`, add:

```js
  const { getTradesByCoin, getCandidatesByCoin } = require('../data/db');

  app.get('/api/markers/:coin', (req, res) => {
    const mode = req.query.mode || 'paper';
    const fromTs = req.query.from !== undefined ? Number(req.query.from) : 0;
    const toTs = req.query.to !== undefined ? Number(req.query.to) : Math.floor(Date.now() / 1000);
    res.json({
      trades: getTradesByCoin(db, mode, req.params.coin, fromTs, toTs),
      candidates: getCandidatesByCoin(db, mode, req.params.coin, fromTs, toTs),
    });
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js src/server/app.js test/server-app.test.js
git commit -m "feat(server): add GET /api/markers/:coin (trades + candidates, mode-scoped)"
```

---

## Task 3: `GET /api/regime/history` and `GET /api/regime/current`

**Files:**
- Modify: `src/data/db.js`
- Modify: `src/server/app.js`
- Test: `test/server-app.test.js`

**Interfaces:**
- Produces: `getRegimeHistory(db, mode, fromTs, toTs)` in `src/data/db.js` — reads `cycle_log`'s `(ts, regime_label)` directly (every real hour, not just "interesting" ones). `GET /api/regime/history?mode=&from=&to=` → `200` with `[{ ts, label }]`. `GET /api/regime/current?mode=` → `200` with `{ label, ts }` from a live `computeRegimeSeries` call using the same real candle data `runCycle` uses, or `{ label: null, ts: null }` if there isn't enough candle history yet to compute one.

- [ ] **Step 1: Write the failing tests**

Add to `test/server-app.test.js`:

```js
test('GET /api/regime/history returns one row per cycle_log entry, including risk_off', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });
    insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 100 });

    const res = await fetch(`http://127.0.0.1:${port}/api/regime/history`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.equal(body[0].label, 'risk_off');
    assert.equal(body[1].label, 'trend_up');
  } finally {
    server.close();
  }
});

test('GET /api/regime/current returns null label when there is not enough candle history yet', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/regime/current`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.label, null);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server-app.test.js`
Expected: FAIL — `404` for both.

- [ ] **Step 3: Implement**

In `src/data/db.js`, add:

```js
function getRegimeHistory(db, mode, fromTs, toTs) {
  return db.prepare(`
    SELECT ts, regime_label AS label FROM cycle_log
    WHERE mode = ? AND ts >= ? AND ts <= ? AND regime_label IS NOT NULL
    ORDER BY ts ASC
  `).all(mode, fromTs, toTs);
}
```

Add `getTradesByCoin, getCandidatesByCoin, getRegimeHistory` (the first two from Task 2, if not already added) to `module.exports`.

In `src/server/app.js`, add:

```js
  const { getRegimeHistory, getCandles: getCandlesForRegime } = require('../data/db');
  const { computeRegimeSeries } = require('../engine/regime');
  const { COINS } = require('../engine/config');

  app.get('/api/regime/history', (req, res) => {
    const mode = req.query.mode || 'paper';
    const fromTs = req.query.from !== undefined ? Number(req.query.from) : 0;
    const toTs = req.query.to !== undefined ? Number(req.query.to) : Math.floor(Date.now() / 1000);
    res.json(getRegimeHistory(db, mode, fromTs, toTs));
  });

  app.get('/api/regime/current', (req, res) => {
    const nowTs = Math.floor(Date.now() / 1000);
    const btcDaily = getCandlesForRegime(db, 'BTC', '1d', 0, nowTs);
    const btc4h = getCandlesForRegime(db, 'BTC', '4h', 0, nowTs);
    const watchlistBy4h = {};
    for (const coin of COINS) {
      watchlistBy4h[coin] = getCandlesForRegime(db, coin, '4h', 0, nowTs).map((c) => ({ ts: c.ts, close: c.close }));
    }
    const series = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
    const latest = series.length > 0 ? series[series.length - 1] : null;
    res.json(latest ? { label: latest.label, ts: latest.ts } : { label: null, ts: null });
  });
```

(`getCandles` is already imported once from Task 1 — avoid a duplicate `const` declaration by either reusing that binding directly, or aliasing as shown; if Task 1's `const { getCandles } = require('../data/db');` is still in scope in the same `createApp` function body, just reuse `getCandles` directly here instead of the `getCandlesForRegime` alias.)

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server-app.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/data/db.js src/server/app.js test/server-app.test.js
git commit -m "feat(server): add GET /api/regime/history and /api/regime/current"
```

---

## Task 4: Real-run verification

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm real candle and regime data over HTTP**

```bash
timeout 6 node dashboard.js &
sleep 1
echo "--- candles ---"; curl -s "http://127.0.0.1:3000/api/candles/BTC?tf=1h&from=0&to=9999999999" | head -c 200
echo
echo "--- regime history ---"; curl -s "http://127.0.0.1:3000/api/regime/history" | head -c 300
echo
echo "--- regime current ---"; curl -s "http://127.0.0.1:3000/api/regime/current"
echo
echo "--- markers ---"; curl -s "http://127.0.0.1:3000/api/markers/BTC"
echo
wait 2>/dev/null
```
Expected: `candles` returns real stored BTC 1h candles (this session has 6+ months of backfilled history, per milestone 2); `regime history` returns real `(ts, label)` rows from every real cycle logged; `regime current` returns the actual live-computed regime (should match whatever `regime/history`'s most recent entry says, since both read the same real data); `markers` returns `{trades:[],candidates:[]}` or real data depending on whether BTC has had any real activity yet.

- [ ] **Step 2: Run the full suite one final time**

Run: `node --test test/`
Expected: PASS

## Part C exit check

- [ ] `node --test test/` passes (all new tests green: 3 candles tests, 2 markers tests, 2 regime tests — 7 new tests — plus every prior test unchanged).
- [ ] `/api/candles`, `/api/markers`, `/api/regime/history`, `/api/regime/current` all confirmed against the real Pi database, not just seeded `:memory:` fixtures.
- [ ] No UI yet — the next part builds the actual chart (lightweight-charts, vendored, already fetched into `public-v2/vendor/`) against this API.
