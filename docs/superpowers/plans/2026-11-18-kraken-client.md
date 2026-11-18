# Kraken Client (Milestone 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Kraken client layer (`src/kraken/`) — signed REST (public + private), WebSocket v2 (public ticker/OHLC with auto-reconnect), and Kraken Futures public data — so later milestones can fetch candles, read balances, and place/cancel/amend orders through one tested interface.

**Architecture:** Three independent client modules under `src/kraken/` (`rest.js`, `ws.js`, `futures.js`) plus a tiny env-file loader (`src/config/env.js`) that reads Kraken credentials from `~/.config/cryptodash/env` without ever being logged. Each client is a factory function returning plain methods (no singletons), so tests can inject a fake base URL / WebSocket URL instead of hitting the real network. `rest.js` and `ws.js` carry no trading logic — they are thin, typed wrappers around Kraken's wire format; `engine/`, `broker/` and `data/` (later milestones) build on top.

**Tech Stack:** Node.js 20 (built-in global `fetch`, `node:crypto`, `node:http` for test mocks), `ws` npm package for the real WebSocket client, `node --test` for tests.

**Spec:** `docs/v2-design.md` §§3, 4, 6, 9, 10 (milestone 1 row); `CLAUDE.md` hard rules and "first task" note.

## Verified against the real Kraken API (2026-11-18, via official docs + current field reports — live order test deferred to Task 7)

- **Order types (spot):** `market`, `limit`, `iceberg`, `stop-loss`, `take-profit`, `stop-loss-limit`, `take-profit-limit`, `trailing-stop`, `trailing-stop-limit`, `settle-position`.
- **Sell orders reserve the full balance immediately on placement, not on fill.** A second sell/stop order on the same holding while one is already open gets rejected with `EOrder:Insufficient funds` — confirms design §6's "one exit order per position" assumption; no code workaround needed, just handle the error distinctly.
- **OCO is UI-only on Kraken Pro (since Jan 2025), not exposed via the REST or WS API.** Design §6's fallback ("stop on Kraken, target watched in code" for reversion setups) is the only option — confirmed, no design change.
- **`close[ordertype]`/`close[price]` conditional-close params attach a secondary order that fires only when the *primary* order fills** — it is not a way to run two independent exit orders concurrently (same reservation problem applies once both are live).
- **`AmendOrder` (REST) supports changing `trigger_price` on an already-open triggered order (stop-loss, trailing-stop) in place**, preserving queue position and the order ID — this is the correct way to implement "tighten a stop, never loosen it" (design §5.3) instead of cancel+replace. The older `EditOrder` endpoint explicitly does *not* support amending triggered orders.
- **Signing:** `API-Sign` = base64(HMAC-SHA512(base64-decode(secret), path + SHA256(nonce + postdata))), where `path` is `/0/private/<Method>` and `postdata` is the URL-encoded body (including `nonce`).
- **WS v2 URLs:** public `wss://ws.kraken.com/v2` (no auth needed), private `wss://ws-auth.kraken.com/v2` (needs a token from REST `GetWebSocketsToken`, valid 15 min until a private subscription succeeds, then it doesn't expire for that connection). Milestone 1 only needs the public client (ticker + OHLC); private WS add_order is out of scope until `broker/live.js` (milestone 5+).
- **OHLC REST/WS:** the most recent candle in any response/stream is always the forming, not-yet-closed one — must never be treated as closed data (ties directly to the "completed candles only" hard rule).
- **Kraken Futures public `tickers`** needs no auth and returns `fundingRate`, `fundingRatePrediction`, `openInterest` per symbol (e.g. `PF_XBTUSD`).

## Global Constraints

- No secrets in the repo or in Claude's context; Kraken keys live in `~/.config/cryptodash/env` (outside the repo). Code may read that file to use the credentials; nothing may `console.log`/print its contents.
- Kraken key must have no withdraw permission — this is a human setup step, not something the client enforces in code.
- Completed candles only — the client must make the caller able to tell forming vs closed candles apart; it must never silently hand back a forming candle as if closed.
- One exit order per position — the client doesn't enforce this (that's `broker/`'s job later) but must surface Kraken's `EOrder:Insufficient funds` as a distinct, catchable error rather than a generic failure.
- Every order needs a client order ID — `addOrder`/`amendOrder` must accept and pass through a caller-supplied `cl_ord_id`; deriving it from a candidate ID is `broker/`'s job (later milestone).
- Tests run via `node --test test/` (existing convention: flat files in `test/`, `'use strict'`, `node:test` + `node:assert/strict`).

## Review Focus

- Nonce must be strictly increasing even when two private calls happen in the same millisecond, or Kraken returns `EAPI:Invalid nonce` and every later call in that process fails too → covered in Task 2.
- Kraken's own `error` array (e.g. `EAPI:Rate limit exceeded`, `EOrder:Insufficient funds`) must surface as a distinct, inspectable error, not get swallowed or treated the same as an HTTP/network failure → covered in Tasks 2 and 4.
- The OHLC response's/stream's last entry is the forming candle and must be flagged or excluded, not handed to callers as closed data → covered in Task 3.
- A dropped WebSocket connection must auto-reconnect *and* re-send every subscription that was active before the drop, not just reconnect and go silent → covered in Task 6.
- Placing a second sell/stop order on an already-reserved holding must come back as a specific, recognizable error (`EOrder:Insufficient funds`), not a crash or a generic "order failed" → covered in Tasks 4 and 7.

---

## Task 1: Env credential loader + `ws` dependency

**Files:**
- Create: `src/config/env.js`
- Test: `test/config-env.test.js`
- Modify: `package.json` (add `ws` dependency)

**Interfaces:**
- Produces: `loadEnvFile(filePath?)` → `{ [key]: string }`; `getKrakenCredentials()` → `{ apiKey, apiSecret }` (both `undefined` if unset); `DEFAULT_PATH` (string, `~/.config/cryptodash/env`).
- Consumed by: Task 2's `createRestClient` (via caller-supplied `apiKey`/`apiSecret`, not read internally — keeps `rest.js` network/credential-agnostic and easy to unit test).

- [ ] **Step 1: Add `ws` to `package.json`**

```bash
npm install ws
```

- [ ] **Step 2: Write the failing test**

Create `test/config-env.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadEnvFile, getKrakenCredentials } = require('../src/config/env');

function tmpEnvFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryptodash-env-'));
  const file = path.join(dir, 'env');
  fs.writeFileSync(file, contents);
  return file;
}

test('loadEnvFile returns {} when the file does not exist', () => {
  assert.deepEqual(loadEnvFile('/nonexistent/path/env'), {});
});

test('loadEnvFile parses KEY=VALUE lines, skips blanks and comments', () => {
  const file = tmpEnvFile([
    '# comment',
    '',
    'KRAKEN_API_KEY=fake_key_abc',
    'KRAKEN_API_SECRET=ZmFrZV9zZWNyZXQ=',
    '  SPACED = trimmed  ',
  ].join('\n'));
  assert.deepEqual(loadEnvFile(file), {
    KRAKEN_API_KEY: 'fake_key_abc',
    KRAKEN_API_SECRET: 'ZmFrZV9zZWNyZXQ=',
    SPACED: 'trimmed',
  });
});

test('getKrakenCredentials reads KRAKEN_API_KEY/KRAKEN_API_SECRET from a given file', () => {
  const file = tmpEnvFile('KRAKEN_API_KEY=fake_key\nKRAKEN_API_SECRET=fake_secret\n');
  assert.deepEqual(getKrakenCredentials(file), { apiKey: 'fake_key', apiSecret: 'fake_secret' });
});

test('getKrakenCredentials returns undefineds when the file is missing', () => {
  const creds = getKrakenCredentials('/nonexistent/path/env');
  assert.equal(creds.apiKey, undefined);
  assert.equal(creds.apiSecret, undefined);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/config-env.test.js`
Expected: FAIL — `Cannot find module '../src/config/env'`

- [ ] **Step 4: Write the implementation**

Create `src/config/env.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'cryptodash', 'env');

function loadEnvFile(filePath = DEFAULT_PATH) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function getKrakenCredentials(filePath = DEFAULT_PATH) {
  const env = loadEnvFile(filePath);
  return { apiKey: env.KRAKEN_API_KEY, apiSecret: env.KRAKEN_API_SECRET };
}

module.exports = { loadEnvFile, getKrakenCredentials, DEFAULT_PATH };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/config-env.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config/env.js test/config-env.test.js
git commit -m "feat(kraken): add env-file credential loader and ws dependency"
```

---

## Task 2: REST client core — signing, nonce, request plumbing

**Files:**
- Create: `src/kraken/rest.js`
- Test: `test/kraken-rest.test.js`

**Interfaces:**
- Produces: `createRestClient({ apiKey, apiSecret, baseUrl = 'https://api.kraken.com', getNonce })` → `{ publicRequest(endpoint, params), privateRequest(endpoint, params), sign(path, postdata, nonce, secret) }`. `sign` is exported on the instance (not just module-private) so later tasks' integration tests can cross-check real responses if needed.
- Throws: `KrakenApiError` (exported from the module) with `.errors` (the raw Kraken `error` array) when Kraken's own `result.error` is non-empty; a plain `Error` for transport/HTTP failures (status code in `.status`).
- Consumed by: Tasks 3 and 4 call `client.publicRequest`/`client.privateRequest` for each specific endpoint.

- [ ] **Step 1: Write the failing tests**

Create `test/kraken-rest.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { createRestClient, KrakenApiError } = require('../src/kraken/rest');

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function expectedSignature(path, postdata, nonce, secretB64) {
  const secret = Buffer.from(secretB64, 'base64');
  const hash = crypto.createHash('sha256').update(nonce + postdata).digest('binary');
  return crypto.createHmac('sha512', secret).update(path, 'latin1').update(hash, 'binary').digest('base64');
}

test('publicRequest GETs /0/public/<endpoint> with query params, no auth headers', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    captured = { method: req.method, url: req.url, headers: req.headers };
    res.end(JSON.stringify({ error: [], result: { unixtime: 123 } }));
  });
  const { port } = server.address();
  const client = createRestClient({ baseUrl: `http://127.0.0.1:${port}` });

  const result = await client.publicRequest('Time', {});

  assert.equal(captured.method, 'GET');
  assert.equal(captured.url, '/0/public/Time');
  assert.equal(captured.headers['api-key'], undefined);
  assert.deepEqual(result, { unixtime: 123 });
  server.close();
});

test('privateRequest POSTs /0/private/<endpoint> with a correctly-signed body', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      captured = { method: req.method, url: req.url, headers: req.headers, body };
      res.end(JSON.stringify({ error: [], result: { ZGBP: '100.0000' } }));
    });
  });
  const { port } = server.address();
  const secret = Buffer.from('test-secret').toString('base64');
  let nonceCalls = 0;
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    apiSecret: secret,
    getNonce: () => 1700000000000 + (nonceCalls++),
  });

  const result = await client.privateRequest('Balance', {});

  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/0/private/Balance');
  assert.equal(captured.headers['api-key'], 'test-key');
  assert.equal(captured.body, 'nonce=1700000000000');
  const expected = expectedSignature('/0/private/Balance', 'nonce=1700000000000', '1700000000000', secret);
  assert.equal(captured.headers['api-sign'], expected);
  assert.deepEqual(result, { ZGBP: '100.0000' });
  server.close();
});

test('privateRequest rejects with KrakenApiError when Kraken returns errors', async () => {
  const server = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => res.end(JSON.stringify({ error: ['EOrder:Insufficient funds'], result: null })));
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k',
    apiSecret: Buffer.from('s').toString('base64'),
  });

  await assert.rejects(
    () => client.privateRequest('AddOrder', {}),
    (err) => err instanceof KrakenApiError && err.errors.includes('EOrder:Insufficient funds'),
  );
  server.close();
});

test('default nonce generator is strictly increasing even when called twice in the same tick', () => {
  const client = createRestClient({ baseUrl: 'http://unused' });
  const a = client._getNonce();
  const b = client._getNonce();
  assert.ok(b > a, `expected ${b} > ${a}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/kraken-rest.test.js`
Expected: FAIL — `Cannot find module '../src/kraken/rest'`

- [ ] **Step 3: Write the implementation**

Create `src/kraken/rest.js`:

```js
'use strict';
const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://api.kraken.com';

class KrakenApiError extends Error {
  constructor(errors) {
    super(`Kraken API error: ${errors.join(', ')}`);
    this.name = 'KrakenApiError';
    this.errors = errors;
  }
}

function sign(path, postdata, nonce, apiSecret) {
  const secretBuf = Buffer.from(apiSecret, 'base64');
  const hashDigest = crypto.createHash('sha256').update(nonce + postdata).digest('binary');
  return crypto
    .createHmac('sha512', secretBuf)
    .update(path, 'latin1')
    .update(hashDigest, 'binary')
    .digest('base64');
}

function makeDefaultNonce() {
  let last = 0;
  return () => {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
}

function createRestClient({ apiKey, apiSecret, baseUrl = DEFAULT_BASE_URL, getNonce } = {}) {
  const nonceFn = getNonce || makeDefaultNonce();

  async function publicRequest(endpoint, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const path = `/0/public/${endpoint}`;
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url);
    return parseResponse(res);
  }

  async function privateRequest(endpoint, params = {}) {
    const nonce = String(nonceFn());
    const postdata = new URLSearchParams({ nonce, ...params }).toString();
    const path = `/0/private/${endpoint}`;
    const signature = sign(path, postdata, nonce, apiSecret);
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': apiKey,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postdata,
    });
    return parseResponse(res);
  }

  async function parseResponse(res) {
    if (!res.ok) {
      const err = new Error(`Kraken HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (body.error && body.error.length > 0) throw new KrakenApiError(body.error);
    return body.result;
  }

  return { publicRequest, privateRequest, sign, _getNonce: nonceFn };
}

module.exports = { createRestClient, KrakenApiError, sign };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/kraken-rest.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/kraken/rest.js test/kraken-rest.test.js
git commit -m "feat(kraken): add signed REST client core (public/private request + nonce)"
```

---

## Task 3: REST public endpoints (time, asset pairs, ticker, OHLC)

**Files:**
- Modify: `src/kraken/rest.js`
- Test: `test/kraken-rest.test.js` (append), `test/kraken-rest-integration.test.js` (new, real network)

**Interfaces:**
- Produces on the client returned by `createRestClient`: `getServerTime()` → `{ unixtime, rfc1123 }`; `getAssetPairs(pairs?)` → Kraken's raw `result` object; `getTicker(pairs)` → raw `result`; `getOhlc(pair, { interval, since } = {})` → `{ candles: [{ time, open, high, low, close, vwap, volume, count, closed }], last }` where `candles` is **sorted oldest→newest with the forming candle's `closed` flag set to `false`** (it is always the last element) and every other candle's `closed` is `true`.
- Consumed by: milestone 2 (`data/candles.js`) will call `getOhlc`; nothing in this milestone consumes it beyond tests.

- [ ] **Step 1: Write the failing unit test (forming-candle flag, no real network)**

Append to `test/kraken-rest.test.js`:

```js
test('getOhlc marks the last candle as not closed and the rest as closed', async () => {
  const server = await startMockServer((req, res) => {
    res.end(JSON.stringify({
      error: [],
      result: {
        XXBTZGBP: [
          [1000, '10', '11', '9', '10.5', '10.2', '5', 3],
          [1060, '10.5', '12', '10', '11.5', '11', '6', 4],
        ],
        last: 1060,
      },
    }));
  });
  const { port } = server.address();
  const client = createRestClient({ baseUrl: `http://127.0.0.1:${port}` });

  const { candles, last } = await client.getOhlc('XXBTZGBP', { interval: 1 });

  assert.equal(candles.length, 2);
  assert.equal(candles[0].closed, true);
  assert.equal(candles[1].closed, false);
  assert.equal(candles[1].time, 1060);
  assert.equal(last, 1060);
  server.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/kraken-rest.test.js`
Expected: FAIL — `client.getOhlc is not a function`

- [ ] **Step 3: Implement the public endpoint methods**

In `src/kraken/rest.js`, inside `createRestClient`, add before the `return { ... }` line:

```js
  async function getServerTime() {
    return publicRequest('Time');
  }

  async function getAssetPairs(pairs) {
    return publicRequest('AssetPairs', pairs ? { pair: pairs.join(',') } : {});
  }

  async function getTicker(pairs) {
    return publicRequest('Ticker', { pair: pairs.join(',') });
  }

  async function getOhlc(pair, { interval = 1, since } = {}) {
    const params = { pair, interval: String(interval) };
    if (since !== undefined) params.since = String(since);
    const result = await publicRequest('OHLC', params);
    const { last, ...rest } = result;
    const rows = rest[Object.keys(rest)[0]];
    const candles = rows.map(([time, open, high, low, close, vwap, volume, count], i) => ({
      time, open: Number(open), high: Number(high), low: Number(low), close: Number(close),
      vwap: Number(vwap), volume: Number(volume), count,
      closed: i < rows.length - 1,
    }));
    return { candles, last };
  }
```

And change the final `return` statement to:

```js
  return { publicRequest, privateRequest, sign, _getNonce: nonceFn, getServerTime, getAssetPairs, getTicker, getOhlc };
```

- [ ] **Step 4: Run to verify the unit test passes**

Run: `node --test test/kraken-rest.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the real-network integration test**

Create `test/kraken-rest-integration.test.js` (always safe to run — public, read-only, free):

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRestClient } = require('../src/kraken/rest');

const client = createRestClient({});

test('getServerTime returns a plausible unixtime', async () => {
  const { unixtime } = await client.getServerTime();
  const nowSec = Date.now() / 1000;
  assert.ok(Math.abs(unixtime - nowSec) < 120, `server time ${unixtime} too far from local time ${nowSec}`);
});

test('getOhlc for XBT/GBP returns closed candles older than the forming one', async () => {
  const { candles, last } = await client.getOhlc('XXBTZGBP', { interval: 60 });
  assert.ok(candles.length > 1);
  assert.equal(candles[candles.length - 1].closed, false);
  assert.equal(candles[0].closed, true);
  assert.ok(typeof last === 'number');
});

test('getTicker for XBT/GBP returns a bid/ask', async () => {
  const result = await client.getTicker(['XXBTZGBP']);
  const ticker = result.XXBTZGBP;
  assert.ok(Number(ticker.a[0]) > 0);
  assert.ok(Number(ticker.b[0]) > 0);
});
```

- [ ] **Step 6: Run the integration test against the real Kraken API**

Run: `node --test test/kraken-rest-integration.test.js`
Expected: PASS (3 tests) — confirms real connectivity and the forming-candle rule against live data.

- [ ] **Step 7: Commit**

```bash
git add src/kraken/rest.js test/kraken-rest.test.js test/kraken-rest-integration.test.js
git commit -m "feat(kraken): add public REST endpoints (time, asset pairs, ticker, ohlc)"
```

---

## Task 4: REST private endpoints (balance, orders)

**Files:**
- Modify: `src/kraken/rest.js`
- Test: `test/kraken-rest.test.js` (append), `test/kraken-rest-integration.test.js` (append)

**Interfaces:**
- Produces: `getBalance()` → raw `result` (`{ [asset]: balanceString }`); `addOrder(params)` where `params` includes at least `pair`, `type` (`'buy'|'sell'`), `ordertype`, `volume`, and may include `price`, `price2`, `trigger`, `oflags`, `cl_ord_id`, `validate` — returns raw `result` (`{ txid: [...], descr: {...} }`); `amendOrder(params)` where `params` includes `txid` or `cl_ord_id` plus any of `order_qty`, `limit_price`, `trigger_price` — returns raw `result`; `cancelOrder(txid)` → raw `result`; `getOpenOrders()` → raw `result`.
- Consumed by: Task 7's manual verification script; later, `broker/live.js` (milestone 5+).

- [ ] **Step 1: Write the failing unit tests**

Append to `test/kraken-rest.test.js`:

```js
test('addOrder posts to /0/private/AddOrder with the given params plus nonce', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = body;
      res.end(JSON.stringify({ error: [], result: { txid: ['OABC-TEST'], descr: { order: 'buy 0.001 XXBTZGBP' } } }));
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
    getNonce: () => 1,
  });

  const result = await client.addOrder({
    pair: 'XXBTZGBP', type: 'buy', ordertype: 'limit', price: '10000', volume: '0.001',
    cl_ord_id: 'c_test_001', validate: true,
  });

  assert.equal(captured, 'nonce=1&pair=XXBTZGBP&type=buy&ordertype=limit&price=10000&volume=0.001&cl_ord_id=c_test_001&validate=true');
  assert.deepEqual(result.txid, ['OABC-TEST']);
  server.close();
});

test('amendOrder posts to /0/private/AmendOrder with trigger_price', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = { url: req.url, body };
      res.end(JSON.stringify({ error: [], result: { amend_id: 'AMEND-1' } }));
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
    getNonce: () => 1,
  });

  const result = await client.amendOrder({ txid: 'OABC-TEST', trigger_price: '-50' });

  assert.equal(captured.url, '/0/private/AmendOrder');
  assert.equal(captured.body, 'nonce=1&txid=OABC-TEST&trigger_price=-50');
  assert.equal(result.amend_id, 'AMEND-1');
  server.close();
});

test('cancelOrder posts txid to /0/private/CancelOrder', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = body;
      res.end(JSON.stringify({ error: [], result: { count: 1 } }));
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
    getNonce: () => 1,
  });

  const result = await client.cancelOrder('OABC-TEST');

  assert.equal(captured, 'nonce=1&txid=OABC-TEST');
  assert.equal(result.count, 1);
  server.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/kraken-rest.test.js`
Expected: FAIL — `client.addOrder is not a function`

- [ ] **Step 3: Implement the private endpoint methods**

In `src/kraken/rest.js`, add before the final `return`:

```js
  async function getBalance() {
    return privateRequest('Balance');
  }

  async function addOrder(params) {
    return privateRequest('AddOrder', params);
  }

  async function amendOrder(params) {
    return privateRequest('AmendOrder', params);
  }

  async function cancelOrder(txid) {
    return privateRequest('CancelOrder', { txid });
  }

  async function getOpenOrders() {
    return privateRequest('OpenOrders');
  }
```

Update the final `return` statement to include `getBalance, addOrder, amendOrder, cancelOrder, getOpenOrders`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/kraken-rest.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Add the credential-gated integration test**

Append to `test/kraken-rest-integration.test.js`:

```js
const { getKrakenCredentials } = require('../src/config/env');

const creds = getKrakenCredentials();
const hasCreds = Boolean(creds.apiKey && creds.apiSecret);

test('getBalance returns the account balance (requires configured Kraken keys)', { skip: !hasCreds && 'no Kraken keys configured in ~/.config/cryptodash/env' }, async () => {
  const authedClient = createRestClient(creds);
  const balance = await authedClient.getBalance();
  assert.equal(typeof balance, 'object');
});
```

- [ ] **Step 6: Run the integration file**

Run: `node --test test/kraken-rest-integration.test.js`
Expected: PASS (4 tests), with the balance test reporting `skipped` (no keys configured yet — expected until Task 7's manual setup).

- [ ] **Step 7: Commit**

```bash
git add src/kraken/rest.js test/kraken-rest.test.js test/kraken-rest-integration.test.js
git commit -m "feat(kraken): add private REST endpoints (balance, add/amend/cancel order)"
```

---

## Task 5: Kraken Futures public client (funding rate, open interest)

**Files:**
- Create: `src/kraken/futures.js`
- Test: `test/kraken-futures.test.js`

**Interfaces:**
- Produces: `createFuturesClient({ baseUrl = 'https://futures.kraken.com/derivatives/api/v3' } = {})` → `{ getTickers(), getFundingContext(tickers, symbol) }`. `getTickers()` → array of raw ticker objects. `getFundingContext(tickers, symbol)` → `{ symbol, fundingRate, fundingRatePrediction, openInterest } | null` if the symbol isn't found.
- Consumed by: milestone 3 (`engine/regime.js`, per design §5.1 "Positioning"); nothing in this milestone.

- [ ] **Step 1: Write the failing tests**

Create `test/kraken-futures.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createFuturesClient } = require('../src/kraken/futures');

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('getTickers fetches /tickers and returns the tickers array', async () => {
  const server = await startMockServer((req, res) => {
    res.end(JSON.stringify({
      result: 'success',
      tickers: [{ symbol: 'PF_XBTUSD', fundingRate: 0.0001, fundingRatePrediction: 0.0002, openInterest: 12345 }],
    }));
  });
  const { port } = server.address();
  const client = createFuturesClient({ baseUrl: `http://127.0.0.1:${port}` });

  const tickers = await client.getTickers();

  assert.equal(tickers.length, 1);
  assert.equal(tickers[0].symbol, 'PF_XBTUSD');
  server.close();
});

test('getTickers throws when Kraken Futures reports an error result', async () => {
  const server = await startMockServer((req, res) => {
    res.end(JSON.stringify({ result: 'error', error: 'someError' }));
  });
  const { port } = server.address();
  const client = createFuturesClient({ baseUrl: `http://127.0.0.1:${port}` });

  await assert.rejects(() => client.getTickers());
  server.close();
});

test('getFundingContext extracts funding/OI fields for a known symbol', () => {
  const client = createFuturesClient({});
  const tickers = [{ symbol: 'PF_XBTUSD', fundingRate: 0.0001, fundingRatePrediction: 0.0002, openInterest: 12345 }];

  const ctx = client.getFundingContext(tickers, 'PF_XBTUSD');

  assert.deepEqual(ctx, { symbol: 'PF_XBTUSD', fundingRate: 0.0001, fundingRatePrediction: 0.0002, openInterest: 12345 });
});

test('getFundingContext returns null for an unknown symbol', () => {
  const client = createFuturesClient({});
  assert.equal(client.getFundingContext([], 'PF_XBTUSD'), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/kraken-futures.test.js`
Expected: FAIL — `Cannot find module '../src/kraken/futures'`

- [ ] **Step 3: Implement**

Create `src/kraken/futures.js`:

```js
'use strict';

const DEFAULT_BASE_URL = 'https://futures.kraken.com/derivatives/api/v3';

function createFuturesClient({ baseUrl = DEFAULT_BASE_URL } = {}) {
  async function getTickers() {
    const res = await fetch(`${baseUrl}/tickers`);
    if (!res.ok) {
      const err = new Error(`Kraken Futures HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (body.result !== 'success') throw new Error(`Kraken Futures error: ${JSON.stringify(body)}`);
    return body.tickers;
  }

  function getFundingContext(tickers, symbol) {
    const ticker = tickers.find((t) => t.symbol === symbol);
    if (!ticker) return null;
    return {
      symbol,
      fundingRate: ticker.fundingRate,
      fundingRatePrediction: ticker.fundingRatePrediction,
      openInterest: ticker.openInterest,
    };
  }

  return { getTickers, getFundingContext };
}

module.exports = { createFuturesClient };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/kraken-futures.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Add a real-network smoke test**

Create `test/kraken-futures-integration.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFuturesClient } = require('../src/kraken/futures');

test('real Kraken Futures tickers include PF_XBTUSD funding/OI', async () => {
  const client = createFuturesClient({});
  const tickers = await client.getTickers();
  const ctx = client.getFundingContext(tickers, 'PF_XBTUSD');
  assert.ok(ctx, 'expected to find PF_XBTUSD in the tickers list');
  assert.equal(typeof ctx.fundingRate, 'number');
  assert.equal(typeof ctx.openInterest, 'number');
});
```

- [ ] **Step 6: Run it**

Run: `node --test test/kraken-futures-integration.test.js`
Expected: PASS (1 test)

- [ ] **Step 7: Commit**

```bash
git add src/kraken/futures.js test/kraken-futures.test.js test/kraken-futures-integration.test.js
git commit -m "feat(kraken): add Kraken Futures public client for funding rate and open interest"
```

---

## Task 6: WebSocket v2 public client (ticker + OHLC, auto-reconnect + resubscribe)

**Files:**
- Create: `src/kraken/ws.js`
- Test: `test/kraken-ws.test.js`, `test/kraken-ws-integration.test.js`

**Interfaces:**
- Produces: `class KrakenPublicWs extends EventEmitter` with `constructor({ url = 'wss://ws.kraken.com/v2', reconnectDelayMs = 2000 } = {})`; methods `connect()`, `subscribeTicker(symbols)`, `subscribeOhlc(symbols, interval)`, `close()`; emits `'open'`, `'message'` (every parsed frame), `'<channel>'` (e.g. `'ticker'`, `'ohlc'`, keyed off `msg.channel`), `'close'`, `'error'`. On reconnect, re-sends every subscription made since `connect()` was last called.
- Consumed by: milestone 2+ (`data/candles.js` for live candle updates); nothing in this milestone beyond tests.

- [ ] **Step 1: Write the failing reconnect/resubscribe test (local WS server, no real network)**

Create `test/kraken-ws.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { KrakenPublicWs } = require('../src/kraken/ws');

function startWsServer() {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0 }, () => resolve(wss));
  });
}

test('auto-reconnects and re-sends subscriptions after the connection drops', async () => {
  const wss = await startWsServer();
  const port = wss.address().port;
  const received = [];
  let connectionCount = 0;

  wss.on('connection', (socket) => {
    connectionCount += 1;
    socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    if (connectionCount === 1) {
      // Drop the first connection shortly after it subscribes, to force a reconnect.
      setTimeout(() => socket.close(), 200);
    }
  });

  const client = new KrakenPublicWs({ url: `ws://127.0.0.1:${port}`, reconnectDelayMs: 100 });
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));
  client.subscribeTicker(['BTC/GBP']);

  await new Promise((resolve) => setTimeout(resolve, 600)); // let it drop, reconnect, and resubscribe

  client.close();
  wss.close();

  assert.ok(connectionCount >= 2, `expected at least 2 connections, got ${connectionCount}`);
  assert.deepEqual(received[0], { method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/GBP'] } });
  assert.ok(received.length >= 2, 'expected the subscription to be re-sent after reconnect');
  assert.deepEqual(received[received.length - 1], { method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/GBP'] } });
});

test('emits channel-named events keyed off msg.channel', async () => {
  const wss = await startWsServer();
  const port = wss.address().port;
  wss.on('connection', (socket) => {
    socket.on('message', () => {
      socket.send(JSON.stringify({ channel: 'ticker', type: 'update', data: [{ symbol: 'BTC/GBP', last: 50000 }] }));
    });
  });

  const client = new KrakenPublicWs({ url: `ws://127.0.0.1:${port}` });
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));
  client.subscribeTicker(['BTC/GBP']);

  const msg = await new Promise((resolve) => client.once('ticker', resolve));

  client.close();
  wss.close();

  assert.equal(msg.data[0].symbol, 'BTC/GBP');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/kraken-ws.test.js`
Expected: FAIL — `Cannot find module '../src/kraken/ws'`

- [ ] **Step 3: Implement**

Create `src/kraken/ws.js`:

```js
'use strict';
const WebSocket = require('ws');
const EventEmitter = require('events');

const DEFAULT_PUBLIC_URL = 'wss://ws.kraken.com/v2';

class KrakenPublicWs extends EventEmitter {
  constructor({ url = DEFAULT_PUBLIC_URL, reconnectDelayMs = 2000 } = {}) {
    super();
    this.url = url;
    this.reconnectDelayMs = reconnectDelayMs;
    this.subscriptions = [];
    this.closedByUser = false;
    this.ws = null;
  }

  connect() {
    this.closedByUser = false;
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.emit('open');
      for (const sub of this.subscriptions) this._send(sub);
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.emit('message', msg);
      if (msg.channel) this.emit(msg.channel, msg);
    });

    this.ws.on('close', () => {
      this.emit('close');
      if (!this.closedByUser) setTimeout(() => this.connect(), this.reconnectDelayMs);
    });

    this.ws.on('error', (err) => this.emit('error', err));
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  subscribeTicker(symbols) {
    const sub = { method: 'subscribe', params: { channel: 'ticker', symbol: symbols } };
    this.subscriptions.push(sub);
    this._send(sub);
  }

  subscribeOhlc(symbols, interval) {
    const sub = { method: 'subscribe', params: { channel: 'ohlc', symbol: symbols, interval } };
    this.subscriptions.push(sub);
    this._send(sub);
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
  }
}

module.exports = { KrakenPublicWs, DEFAULT_PUBLIC_URL };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/kraken-ws.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the real-network smoke test**

Create `test/kraken-ws-integration.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { KrakenPublicWs } = require('../src/kraken/ws');

test('receives at least one real ticker update for BTC/GBP', async () => {
  const client = new KrakenPublicWs({});
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));
  client.subscribeTicker(['BTC/GBP']);

  const msg = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a ticker update')), 10000);
    client.once('ticker', (m) => { clearTimeout(timer); resolve(m); });
  });

  client.close();
  assert.equal(msg.channel, 'ticker');
});
```

- [ ] **Step 6: Run it**

Run: `node --test test/kraken-ws-integration.test.js`
Expected: PASS (1 test, within ~10s)

- [ ] **Step 7: Commit**

```bash
git add src/kraken/ws.js test/kraken-ws.test.js test/kraken-ws-integration.test.js
git commit -m "feat(kraken): add WebSocket v2 public client with auto-reconnect and resubscribe"
```

---

## Task 7: Manual live verification (real tiny order) + design doc update

This is the milestone's "done when" criterion from `docs/v2-design.md` §10 ("place/cancel a tiny limit order") and `CLAUDE.md`'s first-task instruction, now that Tasks 1–6 give us the client to do it with. **This touches real funds (tiny amounts) and real orders on Kraken — stop and get explicit go-ahead from the user before running Step 2, even though amounts are small.**

**Files:**
- Create: `scripts/verify-kraken-orders.js` (throwaway manual-run script, not part of the app)
- Modify: `docs/v2-design.md` §6 (replace "To verify against the real Kraken API in milestone 1" with the confirmed findings already captured at the top of this plan)

- [ ] **Step 1: Set up credentials (user does this directly, not through the assistant)**

Tell the user to create `~/.config/cryptodash/env` themselves (e.g. `nano ~/.config/cryptodash/env`) with:
```
KRAKEN_API_KEY=<their real key>
KRAKEN_API_SECRET=<their real secret>
```
using a Kraken API key with **query + trade permissions only, no withdraw**. Do not paste the real values into the assistant conversation — the key must never enter Claude's context per `CLAUDE.md`.

- [ ] **Step 2: Write the verification script**

Create `scripts/verify-kraken-orders.js`:

```js
'use strict';
const { createRestClient } = require('../src/kraken/rest');
const { getKrakenCredentials } = require('../src/config/env');

async function main() {
  const creds = getKrakenCredentials();
  if (!creds.apiKey || !creds.apiSecret) {
    console.error('No Kraken keys found in ~/.config/cryptodash/env');
    process.exit(1);
  }
  const client = createRestClient(creds);

  const balanceBefore = await client.getBalance();
  console.log('Balance OK, GBP:', balanceBefore.ZGBP);

  const ticker = await client.getTicker(['XXBTZGBP']);
  const price = Number(ticker.XXBTZGBP.a[0]);
  const farBelowMarket = (price * 0.5).toFixed(1); // won't fill, just proving add/cancel works

  const order = await client.addOrder({
    pair: 'XXBTZGBP', type: 'buy', ordertype: 'limit',
    price: farBelowMarket, volume: '0.0001', oflags: 'post',
    cl_ord_id: `c_verify_${Date.now()}`,
  });
  console.log('Placed order:', order.txid);

  const cancel = await client.cancelOrder(order.txid[0]);
  console.log('Cancelled:', cancel);

  // Reservation check: this should be rejected once a sell/stop reserves the full holding.
  // Only run manually and only if the account holds a tiny BTC balance to test against —
  // read the printed error, don't assume; then cancel whichever order actually went through.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Ask the user for explicit go-ahead, then run it**

Confirm with the user before running `node scripts/verify-kraken-orders.js` (touches their real Kraken account, even at micro size). Run it, read the output together, and confirm: balance call works, order placement + cancel works, and (if they're willing to test it) a second sell order against an already-reserved holding returns `EOrder:Insufficient funds` as predicted.

- [ ] **Step 4: Update the design doc with the confirmed behavior**

In `docs/v2-design.md`, replace the line "To verify against the real Kraken API in milestone 1." under §6 with a short confirmed note matching what Step 3 observed (expected: matches the "Verified against the real Kraken API" section at the top of this plan).

- [ ] **Step 5: Delete the throwaway script and commit the doc update**

```bash
rm scripts/verify-kraken-orders.js
git add docs/v2-design.md
git commit -m "docs: confirm Kraken stop/trailing/OCO behavior against the real API (milestone 1)"
```

---

## Milestone 1 exit check

- [ ] `node --test test/kraken-rest.test.js test/kraken-futures.test.js test/kraken-ws.test.js test/config-env.test.js` all pass with no real network.
- [ ] `node --test test/kraken-rest-integration.test.js test/kraken-futures-integration.test.js test/kraken-ws-integration.test.js` all pass against the real Kraken API.
- [ ] Task 7 confirmed live: balance fetch, order place + cancel, and the insufficient-funds behavior on a second sell order.
- [ ] `docs/v2-design.md` §6 updated from "to verify" to the confirmed behavior.
