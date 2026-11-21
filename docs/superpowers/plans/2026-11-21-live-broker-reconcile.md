# Live Broker + Reconcile-on-Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/broker/live.js` (real Kraken order placement, same call shape as `paper.js`) and `src/broker/reconcile.js` (startup DB-vs-Kraken check), and wire `live.js` into `runCycle`'s `mode === 'live'` path — closing the last untestable item in the go-live checklist (§11: "Reconcile, kill switch and daily loss limit all tested deliberately") while staying fully dormant: nothing in the real system currently calls `runCycle` with `mode === 'live'`.

**Architecture:** `live.js` exports `tryOpenPosition`/`evaluateExit`/`closePosition` with the same parameter shapes `paper.js` already uses, plus a trailing `krakenClient` argument that `paper.js`'s functions silently ignore (JS ignores extra call arguments). Every exit type funnels through one server-side `stop-loss` order per position, amended (tightened) in place each cycle for trailing exits, or cancelled-and-market-sold in code for target/time/EMA-cross exits — never a second order type, matching the milestone-1-confirmed fact that Kraken itself rejects a second sell order on the same holding. `reconcile.js` is a standalone, fully tested, currently-uncalled function (no live scheduler entry point exists yet to call it from).

**Tech Stack:** Existing Node.js engine/broker/scheduler code. `node:test` with hand-written fake `krakenClient` objects (matching this codebase's existing `fakeDeps` pattern in `test/engine-decide-orchestration.test.js`, not `node:test`'s `mock.fn` API, which nothing in this repo currently uses).

**Spec:** `docs/superpowers/specs/2026-11-21-live-broker-reconcile-design.md` (full design, approved 2026-11-21). Also `docs/v2-design.md` §6 (execution mechanics), §13 Stage A ("Client order IDs + reconcile on startup"), `CLAUDE.md` (one exit order per position; stops only tighten; `src/engine/` purity — not touched by this plan, `live.js`/`reconcile.js` live in `src/broker/`, which already does network I/O like `paper.js` does simulated fills).

**Known, unavoidable limitation (carried from the spec):** the Kraken account holds zero funds. No real order can be placed to prove this code end-to-end. Every test in this plan uses a hand-written fake `krakenClient`. Milestone 10 proper must re-verify this for real once the account is funded.

## Global Constraints

- One exit order per position at all times (Kraken-enforced, confirmed milestone 1) — every exit type uses the same single server-side `stop-loss` order, never a second order type.
- Stops only tighten (`CLAUDE.md`) — `amendOrder` is only ever called with a trigger price higher (tighter) than the current one, never lower.
- Every order carries a client order ID built from the candidate ID (`CLAUDE.md`, design doc §6) — entry orders use `candidate.id` directly as `cl_ord_id`; the stop order and any market-close order use `${candidate.id}_<suffix>` so each order has a distinct, deterministic, idempotent ID.
- `paper.js` gets zero source changes — every new call site in `cycle.js` adds a trailing argument paper's functions already silently ignore.
- No live scheduler, no live systemd service, no dashboard UI in this plan — those are explicitly out of scope per the spec's Non-goals.

## Review Focus

- An entry that times out must not leave an orphaned limit order on Kraken — the cancel must actually fire, and a test must assert the fake's `cancelOrder` was called with the right txid (Task 1).
- `amendOrder` must never be called with a looser trigger price than the order already has — a test must cover an unfavorable price move where the stop should stay put (Task 2).
- `reconcile`'s three mismatch types must be independently detectable in the same call — a test with two simultaneous mismatches must report both (Task 4).
- Live mode must stay provably dormant — a grep-based check (not a unit test, since it's an absence-of-callers property) confirms nothing in `scheduler.js`/`dashboard.js` ever constructs a `runCycle` call with `mode === 'live'` (Task 3).
- Live's `closePosition` must use the real fee carried on the `exit` object, never recompute one the way `paper.js`'s simulated `fillExit` does — a test must prove the P&L calculation uses `exit.feeAmount` directly (Task 2).

---

## Task 1: `live.js` — entry placement (`tryOpenPosition`) and the shared order-polling helper

**Files:**
- Create: `src/broker/live.js`
- Modify: `src/engine/config.js`
- Test: `test/broker-live.test.js`

**Interfaces:**
- Consumes: `sizePosition`, `checkFeeViability`, `checkGuardrails` from `src/engine/risk.js` (unchanged); `COIN_ALTNAMES` from `src/engine/config.js` (unchanged).
- Produces: `pollOrderStatus(krakenClient, txid, { timeoutMs, pollMs, sleep, now })` → the closed order object, or `null` on timeout/cancellation — a shared helper Task 2 also uses. `tryOpenPosition(state, candidate, data, i, config, krakenClient, deps = {})` → the opened position object (pushed onto `state.openPositions`) or `null` if blocked/timed out — same call shape as `paper.js`'s `tryOpenPosition`, with the trailing `krakenClient`/`deps` arguments `paper.js` doesn't have.
- Consumed by: Task 2 (`pollOrderStatus`, within the same file), Task 3 (`cycle.js`'s wiring).

- [ ] **Step 1: Add the new config fields**

In `src/engine/config.js`, add to `DEFAULT_RISK_CONFIG`:

```js
const DEFAULT_RISK_CONFIG = {
  baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
  maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6,
  dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08,
  roundTripFeePct: 0.65, // percent, matches checkFeeViability's expected units
  claudeModel: 'claude-sonnet-5', claudeEffort: 'low', claudeTimeoutMs: 30000,
  liveOrderPollMs: 10000, liveOrderTimeoutMs: 15 * 60 * 1000, liveMarketOrderTimeoutMs: 60000,
};
```

No test needed for this step alone — Step 2 below asserts `DEFAULT_RISK_CONFIG.liveOrderTimeoutMs` as part of a real `tryOpenPosition` test.

- [ ] **Step 2: Write the failing tests**

Create `test/broker-live.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tryOpenPosition } = require('../src/broker/live');
const { DEFAULT_RISK_CONFIG } = require('../src/engine/config');

function makeCandidate(overrides = {}) {
  return {
    id: 'c_20261121_12_BTC_trend_pullback', coin: 'BTC', setup: 'trend_pullback',
    entry: 60000, atr: 1200, exitType: 'trailing_stop',
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    timeStopHours: undefined,
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return { balance: 10000, openPositions: [], cooldowns: {}, ...overrides };
}

function makeData() {
  return { candles4h: [{ ts: 1700000000 }], indicators: { bollinger20: { middle: [59000] } } };
}

function instantSleep() { return Promise.resolve(); }

test('tryOpenPosition opens a position when the entry fills within the poll window', async () => {
  const krakenClient = {
    addOrder: async (params) => {
      if (params.ordertype === 'limit') return { txid: ['ENTRY-TXID-1'] };
      return { txid: ['STOP-TXID-1'] };
    },
    queryOrders: (() => {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls === 1) return { 'ENTRY-TXID-1': { status: 'open' } };
        return { 'ENTRY-TXID-1': { status: 'closed', price: '60005.00000', fee: '1.50000' } };
      };
    })(),
    cancelOrder: async () => { throw new Error('cancelOrder should not be called on a fill'); },
  };

  const state = makeState();
  const position = await tryOpenPosition(state, makeCandidate(), makeData(), 0, DEFAULT_RISK_CONFIG, krakenClient, { sleep: instantSleep, now: Date.now });

  assert.ok(position);
  assert.equal(position.entryPrice, 60005);
  assert.equal(position.entryFee, 1.5);
  assert.equal(position.stopOrderTxid, 'STOP-TXID-1');
  assert.equal(state.openPositions.length, 1);
  assert.equal(state.openPositions[0], position);
});

test('tryOpenPosition cancels and opens nothing when the entry never fills within the timeout', async () => {
  let cancelledTxid = null;
  const krakenClient = {
    addOrder: async () => ({ txid: ['ENTRY-TXID-2'] }),
    queryOrders: async () => ({ 'ENTRY-TXID-2': { status: 'open' } }), // never fills
    cancelOrder: async (txid) => { cancelledTxid = txid; return { count: 1 }; },
  };

  const times = [0, 1000, 2000, 16 * 60 * 1000]; // last value exceeds the 15-minute default timeout
  let callIndex = 0;
  const now = () => times[Math.min(callIndex++, times.length - 1)];

  const state = makeState();
  const position = await tryOpenPosition(state, makeCandidate(), makeData(), 0, DEFAULT_RISK_CONFIG, krakenClient, { sleep: instantSleep, now });

  assert.equal(position, null);
  assert.equal(cancelledTxid, 'ENTRY-TXID-2');
  assert.equal(state.openPositions.length, 0);
});

test('tryOpenPosition never calls addOrder when a guardrail blocks the candidate', async () => {
  let addOrderCalled = false;
  const krakenClient = {
    addOrder: async () => { addOrderCalled = true; return { txid: ['SHOULD-NOT-HAPPEN'] }; },
    queryOrders: async () => { throw new Error('should not be called'); },
    cancelOrder: async () => { throw new Error('should not be called'); },
  };

  // max open positions already reached (DEFAULT_RISK_CONFIG.maxOpenPositions is 3)
  const state = makeState({
    openPositions: [
      { coin: 'ETH', riskPct: 0.005, exposurePct: 0.1 },
      { coin: 'SOL', riskPct: 0.005, exposurePct: 0.1 },
      { coin: 'XRP', riskPct: 0.005, exposurePct: 0.1 },
    ],
  });
  const position = await tryOpenPosition(state, makeCandidate(), makeData(), 0, DEFAULT_RISK_CONFIG, krakenClient, { sleep: instantSleep, now: Date.now });

  assert.equal(position, null);
  assert.equal(addOrderCalled, false);
});

test('tryOpenPosition never calls addOrder when the fee-viability check fails', async () => {
  let addOrderCalled = false;
  const krakenClient = {
    addOrder: async () => { addOrderCalled = true; return { txid: ['SHOULD-NOT-HAPPEN'] }; },
    queryOrders: async () => { throw new Error('should not be called'); },
    cancelOrder: async () => { throw new Error('should not be called'); },
  };

  // atr=100 on entry=60000 is 0.17% ATR, well under 4x the 0.65% round-trip fee
  const candidate = makeCandidate({ atr: 100 });
  const position = await tryOpenPosition(makeState(), candidate, makeData(), 0, DEFAULT_RISK_CONFIG, krakenClient, { sleep: instantSleep, now: Date.now });

  assert.equal(position, null);
  assert.equal(addOrderCalled, false);
});
```

- [ ] **Step 2b: Run to verify they fail**

Run: `node --test test/broker-live.test.js`
Expected: FAIL — `Cannot find module '../src/broker/live'`

- [ ] **Step 3: Implement**

Create `src/broker/live.js`:

```js
'use strict';
const { sizePosition, checkFeeViability, checkGuardrails } = require('../engine/risk');
const { COIN_ALTNAMES } = require('../engine/config');

async function pollOrderStatus(krakenClient, txid, { timeoutMs, pollMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const statusResult = await krakenClient.queryOrders([txid]);
    const order = statusResult[txid];
    if (order.status === 'closed') return order;
    if (order.status === 'canceled') return null;
    await sleep(pollMs);
  }
  return null;
}

async function tryOpenPosition(state, candidate, data, i, config, krakenClient, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;

  const atrPct = (candidate.atr / candidate.entry) * 100;
  if (!checkFeeViability({ atrPct, roundTripFeePct: config.roundTripFeePct })) return null;

  const stopPrice = candidate.entry - candidate.default.stopAtr * candidate.atr;
  const riskPct = config.baseRiskPct * candidate.default.size;
  const sizing = sizePosition({ balance: state.balance, riskPct, entryPrice: candidate.entry, stopPrice });
  const exposurePct = sizing.stakeValue / state.balance;
  const barTs = data.candles4h[i].ts;

  const gate = checkGuardrails(
    { openPositions: state.openPositions.map((p) => ({ coin: p.coin, riskPct: p.riskPct, exposurePct: p.exposurePct })), cooldowns: state.cooldowns },
    { coin: candidate.coin, riskPct, exposurePct, ts: barTs },
    config,
  );
  if (!gate.allowed) return null;

  const pair = COIN_ALTNAMES[candidate.coin];
  const entryPlaced = await krakenClient.addOrder({
    pair, type: 'buy', ordertype: 'limit', price: String(candidate.entry), volume: String(sizing.units),
    oflags: 'post', cl_ord_id: candidate.id,
  });
  const entryTxid = entryPlaced.txid[0];

  const entryOrder = await pollOrderStatus(krakenClient, entryTxid, {
    timeoutMs: config.liveOrderTimeoutMs, pollMs: config.liveOrderPollMs, sleep, now,
  });
  if (!entryOrder) {
    await krakenClient.cancelOrder(entryTxid);
    return null;
  }

  const stopOrderPlaced = await krakenClient.addOrder({
    pair, type: 'sell', ordertype: 'stop-loss', price: String(stopPrice), volume: String(sizing.units),
    cl_ord_id: `${candidate.id}_exit`,
  });

  const position = {
    coin: candidate.coin, setup: candidate.setup, entryTs: barTs, candidateId: candidate.id,
    entryPrice: Number(entryOrder.price), units: sizing.units, riskAmount: sizing.riskAmount,
    riskPct, exposurePct, initialStopPrice: stopPrice, atrAtEntry: candidate.atr,
    exitType: candidate.exitType, trailAtr: candidate.default.trailAtr,
    targetPrice: candidate.exitType === 'target_or_time' ? data.indicators.bollinger20.middle[i] : undefined,
    timeStopTs: candidate.timeStopHours !== undefined ? barTs + candidate.timeStopHours * 3600 : undefined,
    entryFee: Number(entryOrder.fee),
    stopOrderTxid: stopOrderPlaced.txid[0],
  };
  state.openPositions.push(position);
  return position;
}

module.exports = { pollOrderStatus, tryOpenPosition };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/broker-live.test.js`
Expected: PASS (4/4)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/broker/live.js src/engine/config.js test/broker-live.test.js
git commit -m "feat(broker): add live.js tryOpenPosition (real Kraken limit entry, poll-and-cancel-on-timeout) + shared pollOrderStatus helper"
```

---

## Task 2: `live.js` — exit management (`evaluateExit`, `closePosition`)

**Files:**
- Modify: `src/broker/live.js`
- Test: `test/broker-live.test.js`

**Interfaces:**
- Consumes: `pollOrderStatus` from Task 1 (same file).
- Produces: `evaluateExit(position, context, krakenClient, config, deps = {})` → `{ exitTs, exitPrice, reason, feeAmount }` or `null` — same return shape as `paper.js`'s `evaluateExit`, plus `feeAmount` (which `paper.js`'s doesn't carry — `cycle.js`'s Task 3 wiring reads it off the object either way, since `paper.js`'s `closePosition` doesn't need it and live's does). `closePosition(state, position, exit, config)` → mutates `state`, same shape as `paper.js`'s `closePosition`, but uses `exit.feeAmount` directly instead of recomputing a simulated fee.
- Consumed by: Task 3 (`cycle.js`'s wiring).

- [ ] **Step 1: Write the failing tests**

Add to `test/broker-live.test.js`:

```js
const { evaluateExit, closePosition } = require('../src/broker/live');

function makePosition(overrides = {}) {
  return {
    coin: 'BTC', setup: 'trend_pullback', entryTs: 1700000000, candidateId: 'c_20261121_12_BTC_trend_pullback',
    entryPrice: 60000, units: 0.1, riskAmount: 50, riskPct: 0.005, exposurePct: 0.1,
    initialStopPrice: 58200, atrAtEntry: 1200, exitType: 'trailing_stop', trailAtr: 2.5,
    entryFee: 1.5, stopOrderTxid: 'STOP-TXID-1',
    ...overrides,
  };
}

test('evaluateExit (live) returns a real exit when the stop order has filled', async () => {
  const krakenClient = {
    queryOrders: async () => ({ 'STOP-TXID-1': { status: 'closed', price: '58150.00000', fee: '0.90000' } }),
  };
  const exit = await evaluateExit(makePosition(), { candles1h: [], nowTs: 1700010000 }, krakenClient, DEFAULT_RISK_CONFIG);

  assert.deepEqual(exit, { exitTs: 1700010000, exitPrice: 58150, reason: 'stop', feeAmount: 0.9 });
});

test('evaluateExit (live) does not amend the stop when price has not moved favorably', async () => {
  let amendCalled = false;
  const krakenClient = {
    queryOrders: async () => ({ 'STOP-TXID-1': { status: 'open', descr: { price: '58200.00000' } } }),
    amendOrder: async () => { amendCalled = true; return { amend_id: 'AMD-1' }; },
  };
  const candles1h = [{ ts: 1700003600, high: 60000, low: 59800, close: 59900 }]; // high == entryPrice, no new peak
  const exit = await evaluateExit(makePosition(), { candles1h, nowTs: 1700010000 }, krakenClient, DEFAULT_RISK_CONFIG);

  assert.equal(exit, null);
  assert.equal(amendCalled, false);
});

test('evaluateExit (live) amends the stop tighter when price has moved favorably, never looser', async () => {
  let amendedParams = null;
  const krakenClient = {
    queryOrders: async () => ({ 'STOP-TXID-1': { status: 'open', descr: { price: '58200.00000' } } }),
    amendOrder: async (params) => { amendedParams = params; return { amend_id: 'AMD-2' }; },
  };
  // highestHigh=63000 -> trail level = 63000 - 2.5*1200 = 60000, which is tighter (higher) than the current 58200 trigger
  const candles1h = [{ ts: 1700003600, high: 63000, low: 62000, close: 62500 }];
  const exit = await evaluateExit(makePosition(), { candles1h, nowTs: 1700010000 }, krakenClient, DEFAULT_RISK_CONFIG);

  assert.equal(exit, null);
  assert.deepEqual(amendedParams, { txid: 'STOP-TXID-1', trigger_price: '60000' });
});

test('evaluateExit (live) closes at market when a target_or_time position hits its target', async () => {
  const position = makePosition({
    exitType: 'target_or_time', targetPrice: 61000, timeStopTs: 1700050000, trailAtr: undefined,
  });
  let cancelledTxid = null, marketOrderParams = null;
  const krakenClient = {
    queryOrders: (() => {
      let calls = 0;
      return async (txids) => {
        calls += 1;
        if (txids[0] === 'STOP-TXID-1') return { 'STOP-TXID-1': { status: 'open' } };
        return { 'MARKET-TXID-1': { status: 'closed', price: '61005.00000', fee: '1.10000' } };
      };
    })(),
    cancelOrder: async (txid) => { cancelledTxid = txid; return { count: 1 }; },
    addOrder: async (params) => { marketOrderParams = params; return { txid: ['MARKET-TXID-1'] }; },
  };
  const candles1h = [{ ts: 1700003600, high: 61200, low: 60500, close: 61100 }];
  const exit = await evaluateExit(position, { candles1h, nowTs: 1700010000, pair: 'XBTGBP' }, krakenClient, DEFAULT_RISK_CONFIG, { sleep: instantSleep, now: Date.now });

  assert.equal(cancelledTxid, 'STOP-TXID-1');
  assert.equal(marketOrderParams.ordertype, 'market');
  assert.equal(marketOrderParams.cl_ord_id, 'c_20261121_12_BTC_trend_pullback_target');
  assert.deepEqual(exit, { exitTs: 1700003600, exitPrice: 61005, reason: 'target', feeAmount: 1.1 });
});

test('closePosition (live) uses exit.feeAmount directly, not a recomputed fee', () => {
  const state = { balance: 10000, dailyPnl: 0, openPositions: [makePosition()], cooldowns: {}, closedTrades: [] };
  const position = state.openPositions[0];
  const exit = { exitTs: 1700010000, exitPrice: 58150, reason: 'stop', feeAmount: 0.9 };

  closePosition(state, position, exit, DEFAULT_RISK_CONFIG);

  // pnl = (58150 - 60000) * 0.1 - entryFee(1.5) - exit.feeAmount(0.9) = -185 - 1.5 - 0.9 = -187.4
  // If this used a recomputed/simulated fee instead of exit.feeAmount, this exact value would differ.
  assert.equal(Math.round((state.balance - 10000) * 100) / 100, -187.4);
  assert.equal(state.openPositions.length, 0);
  assert.equal(state.closedTrades[0].exitReason, 'stop');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/broker-live.test.js`
Expected: FAIL — `evaluateExit is not a function` / `closePosition is not a function`

- [ ] **Step 3: Implement**

In `src/broker/live.js`, add after `tryOpenPosition`:

```js
async function closeAtMarket(position, reason, exitTs, pair, krakenClient, config, deps) {
  await krakenClient.cancelOrder(position.stopOrderTxid);
  const placed = await krakenClient.addOrder({
    pair, type: 'sell', ordertype: 'market', volume: String(position.units),
    cl_ord_id: `${position.candidateId}_${reason}`,
  });
  const txid = placed.txid[0];
  const filled = await pollOrderStatus(krakenClient, txid, {
    timeoutMs: config.liveMarketOrderTimeoutMs, pollMs: config.liveOrderPollMs, sleep: deps.sleep, now: deps.now,
  });
  if (!filled) throw new Error(`market sell order ${txid} did not fill within ${config.liveMarketOrderTimeoutMs}ms`);
  return { exitTs, exitPrice: Number(filled.price), reason, feeAmount: Number(filled.fee) };
}

async function evaluateExit(position, context, krakenClient, config, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;

  const statusResult = await krakenClient.queryOrders([position.stopOrderTxid]);
  const order = statusResult[position.stopOrderTxid];

  if (order.status === 'closed') {
    return { exitTs: context.nowTs, exitPrice: Number(order.price), reason: 'stop', feeAmount: Number(order.fee) };
  }

  const candles1h = context.candles1h;
  if (candles1h.length === 0) return null;

  if (position.exitType === 'trailing_stop') {
    const highestHigh = candles1h.reduce((max, c) => Math.max(max, c.high), position.entryPrice);
    const trailLevel = Math.max(position.initialStopPrice, highestHigh - position.trailAtr * position.atrAtEntry);
    const currentTrigger = Number(order.descr.price);
    if (trailLevel > currentTrigger) {
      await krakenClient.amendOrder({ txid: position.stopOrderTxid, trigger_price: String(trailLevel) });
    }
    return null;
  }

  const lastCandle = candles1h[candles1h.length - 1];

  if (position.exitType === 'target_or_time') {
    if (lastCandle.high >= position.targetPrice) {
      return closeAtMarket(position, 'target', lastCandle.ts, context.pair, krakenClient, config, { sleep, now });
    }
    if (lastCandle.ts >= position.timeStopTs) {
      return closeAtMarket(position, 'time_stop', lastCandle.ts, context.pair, krakenClient, config, { sleep, now });
    }
  }

  if (position.exitType === 'ema_cross_or_time') {
    const isLastHourOfFourHourPeriod = lastCandle.ts % 14400 === 10800;
    if (isLastHourOfFourHourPeriod) {
      const fourHourTs = lastCandle.ts - 10800;
      const ema20 = context.ema20By4hTs.get(fourHourTs);
      if (ema20 !== undefined && lastCandle.close > ema20) {
        return closeAtMarket(position, 'ema_cross', lastCandle.ts, context.pair, krakenClient, config, { sleep, now });
      }
    }
    if (lastCandle.ts >= position.timeStopTs) {
      return closeAtMarket(position, 'time_stop', lastCandle.ts, context.pair, krakenClient, config, { sleep, now });
    }
  }

  return null;
}

function closePosition(state, position, exit, config) {
  const pnl = (exit.exitPrice - position.entryPrice) * position.units - position.entryFee - exit.feeAmount;
  const r = pnl / position.riskAmount;

  state.balance += pnl;
  state.dailyPnl += pnl;
  state.openPositions = state.openPositions.filter((p) => p !== position);
  state.cooldowns[position.coin] = exit.exitTs + config.cooldownHours * 3600;
  state.closedTrades.push({ ...position, exitTs: exit.exitTs, exitPrice: exit.exitPrice, pnl, r, exitReason: exit.reason });
}

module.exports = { pollOrderStatus, tryOpenPosition, evaluateExit, closePosition };
```

(This replaces the earlier `module.exports` line from Task 1 — same names plus the two new ones.)

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/broker-live.test.js`
Expected: PASS (9/9)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/broker/live.js test/broker-live.test.js
git commit -m "feat(broker): add live.js evaluateExit (stop-fill detection, tighten-only trail amend, target/time/ema-cross market-close) + closePosition using the real Kraken fee"
```

---

## Task 3: Wire `live.js` into `runCycle`

**Files:**
- Modify: `src/scheduler/cycle.js`
- Test: `test/scheduler-cycle.test.js`

**Interfaces:**
- Consumes: `tryOpenPosition`, `evaluateExit`, `closePosition` from `src/broker/live.js` (Tasks 1-2); `tryOpenPosition`, `evaluateExit`, `closePosition` from `src/broker/paper.js` (unchanged).
- Produces: `selectBroker(mode, overrides = {})` → the paper or live broker module, exported from `cycle.js` for direct testing.

- [ ] **Step 1: Write the failing test**

Add to `test/scheduler-cycle.test.js` (add `selectBroker` to the existing `require('../src/scheduler/cycle')` destructuring line):

```js
test('selectBroker returns the real live broker module for mode "live" and the real paper broker module for mode "paper"', () => {
  const liveBroker = require('../src/broker/live');
  const paperBroker = require('../src/broker/paper');
  assert.equal(selectBroker('live'), liveBroker);
  assert.equal(selectBroker('paper'), paperBroker);
});

test('selectBroker honors injected overrides, for testability', () => {
  const fakeLive = { marker: 'fake-live' };
  const fakePaper = { marker: 'fake-paper' };
  assert.equal(selectBroker('live', { liveBroker: fakeLive, paperBroker: fakePaper }), fakeLive);
  assert.equal(selectBroker('paper', { liveBroker: fakeLive, paperBroker: fakePaper }), fakePaper);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/scheduler-cycle.test.js`
Expected: FAIL — `selectBroker is not a function`

- [ ] **Step 3: Implement — add `selectBroker` and wire every call site**

In `src/scheduler/cycle.js`, change the broker import line:

```js
const { evaluateExit, tryOpenPosition, closePosition } = require('../broker/paper');
```

to:

```js
const paperBroker = require('../broker/paper');
const liveBroker = require('../broker/live');

function selectBroker(mode, { paperBroker: paperOverride, liveBroker: liveOverride } = {}) {
  return mode === 'live' ? (liveOverride || liveBroker) : (paperOverride || paperBroker);
}
```

Right after `const activeVersion = getActiveConfigVersion(db, mode);` line, add:

```js
    const broker = selectBroker(mode);
```

Change the position-management loop's exit check:

```js
      const exit = evaluateExit(position, { candles1h: candles1hSlice, ema20By4hTs: data.ema20By4hTs });
      if (exit) {
        closePosition(state, position, exit, effectiveConfig);
```

to:

```js
      const exit = await broker.evaluateExit(
        position,
        { candles1h: candles1hSlice, ema20By4hTs: data.ema20By4hTs, nowTs: nowHour, pair: COIN_ALTNAMES[position.coin] },
        krakenClient, effectiveConfig,
      );
      if (exit) {
        broker.closePosition(state, position, exit, effectiveConfig);
```

Change the `take`-decision open:

```js
            tryOpenPosition(state, adjustedCandidate, data, i, effectiveConfig);
```

to:

```js
            await broker.tryOpenPosition(state, adjustedCandidate, data, i, effectiveConfig, krakenClient);
```

Change the `claude_close` position action:

```js
            closePosition(state, position, { exitTs: nowHour, exitPrice: closingBar.close, reason: 'claude_close' }, effectiveConfig);
```

to:

```js
            broker.closePosition(state, position, { exitTs: nowHour, exitPrice: closingBar.close, reason: 'claude_close', feeAmount: 0 }, effectiveConfig);
```

(The `claude_close` path already short-circuits past either broker's fee logic in `paper.js` — its `closePosition` recomputes fees via `fillExit` regardless of what's on `exit`. Live's `closePosition` reads `exit.feeAmount` directly, so this exit object must carry one; `feeAmount: 0` here is intentionally wrong for live's real fee accounting on a Claude-initiated close, which this plan does not resolve — see Task 3's Ruling note below.)

Finally, change `module.exports`:

```js
module.exports = { isFourHourBoundary, utcDayKey, freshState, persistCycleResults, runCycle, selectBroker };
```

**Ruling (ledger this during execution, don't silently fix):** the `claude_close` path (Claude's `position_actions` with `action: 'close'`) closes at the current 4h candle's close price with no real Kraken order at all in either broker — `paper.js` always simulates this fill, and this plan's live wiring doesn't give it a real market-order path (unlike the target/time/ema-cross closes in Task 2, which do place a real order). For live mode, a `claude_close` action needs the same cancel-stop-then-market-sell treatment Task 2 built into `evaluateExit`'s `closeAtMarket`, but that live action is still gated by `isFourHourBoundary(nowHour)` and the top-level `shouldEvaluateCandidates` check, not by `evaluateExit`'s per-cycle polling — it's a structurally different call site. Implementing it properly means exporting `closeAtMarket` from `live.js` and calling it from this `cycle.js` site when `mode === 'live'`, which is a real gap this plan's Task 3 brief does not originally cover. Decide this when you reach the step: the smallest correct fix is to export `closeAtMarket` from `live.js` (add it to Task 2's `module.exports`) and, in this `cycle.js` site, branch — `mode === 'live'` calls `await liveBroker.closeAtMarket(position, 'claude_close', nowHour, COIN_ALTNAMES[position.coin], krakenClient, effectiveConfig, {})` to get a real `exit` object before calling `broker.closePosition`, while `mode === 'paper'` keeps the existing synthetic `exit` object. Ledger whichever you pick as `Task 3: Ruling: ...`.

- [ ] **Step 4: Run to verify the new tests pass**

Run: `node --test test/scheduler-cycle.test.js`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 6: Real-run regression check — paper mode behavior is unchanged**

```bash
node -e "
const { openDb } = require('./src/data/db');
const { createRestClient } = require('./src/kraken/rest');
const { runCycle } = require('./src/scheduler/cycle');
(async () => {
  const db = openDb();
  const client = createRestClient({});
  const result = await runCycle(db, client, 'paper');
  console.log(JSON.stringify(result, null, 2));
})();
"
```
Expected: identical shape/values to every prior real run this session (`regimeLabel: 'risk_off'`, `candidatesCount: 0`, `openedCount: 0`, `closedCount: 0`, `appliedConfig: {riskLevel:'normal', disabledSetups:[]}`) — confirming the broker-selection refactor changed nothing about paper-mode production behavior.

- [ ] **Step 7: Dormancy check — nothing calls runCycle with mode='live' (documented manual check, not a unit test — this is an absence-of-callers property)**

```bash
grep -rn "runCycle(" scheduler.js dashboard.js src/ --include="*.js" | grep -v "src/scheduler/cycle.js" | grep -v "test/"
```
Expected: the only match is `scheduler.js`'s existing `await runCycle(db, krakenClient, MODE)` where `MODE` is the hardcoded module-level constant `'paper'` (unchanged by this plan). No other caller exists anywhere in the codebase.

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/cycle.js test/scheduler-cycle.test.js
git commit -m "feat(scheduler): wire live.js into runCycle via selectBroker(mode) — dormant, nothing calls runCycle with mode='live' yet"
```

---

## Task 4: `reconcile.js`

**Files:**
- Create: `src/broker/reconcile.js`
- Modify: `src/engine/config.js`
- Test: `test/broker-reconcile.test.js`

**Interfaces:**
- Consumes: `loadSchedulerState` from `src/data/db.js` (unchanged).
- Produces: `reconcile(db, mode, krakenClient)` → `Promise<{ ok: true } | { ok: false, mismatches: [{ type, detail }, ...] }>`. No consumers yet within this plan — exported, fully tested, uncalled (see spec's Non-goals: no live scheduler entry point exists to call it from).

- [ ] **Step 1: Add the balance asset code mapping**

In `src/engine/config.js`, add after `COINS`:

```js
// Kraken's Balance endpoint keys by asset code, not the trading-pair altnames in COIN_ALTNAMES.
// Unverified against the real account (it holds no funds) — confirm once funded, same caveat
// as the rest of src/broker/live.js (see docs/superpowers/specs/2026-11-21-live-broker-reconcile-design.md).
const BALANCE_ASSET_CODES = { BTC: 'XXBT', ETH: 'XETH', SOL: 'SOL', XRP: 'XXRP', ADA: 'ADA', LINK: 'LINK' };
```

Add `BALANCE_ASSET_CODES` to `module.exports`.

- [ ] **Step 2: Write the failing tests**

Create `test/broker-reconcile.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../src/broker/reconcile');
const { openDb, saveSchedulerState } = require('../src/data/db');

function makeLivePosition(overrides = {}) {
  return { coin: 'BTC', candidateId: 'c_1', units: 0.1, stopOrderTxid: 'STOP-TXID-1', ...overrides };
}

test('reconcile returns ok:true immediately for paper mode, without calling the Kraken client', async () => {
  const db = openDb(':memory:');
  let called = false;
  const krakenClient = {
    getOpenOrders: async () => { called = true; return { open: {} }; },
    getBalance: async () => { called = true; return {}; },
  };

  const result = await reconcile(db, 'paper', krakenClient);

  assert.deepEqual(result, { ok: true });
  assert.equal(called, false);
});

test('reconcile returns ok:true when every live position matches Kraken', async () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'live', { openPositions: [makeLivePosition()] });
  const krakenClient = {
    getOpenOrders: async () => ({ open: { 'STOP-TXID-1': { status: 'open' } } }),
    getBalance: async () => ({ XXBT: '0.1000000000' }),
  };

  const result = await reconcile(db, 'live', krakenClient);

  assert.deepEqual(result, { ok: true });
});

test('reconcile flags a position whose stop order is missing from Kraken', async () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'live', { openPositions: [makeLivePosition()] });
  const krakenClient = {
    getOpenOrders: async () => ({ open: {} }), // stop order gone
    getBalance: async () => ({ XXBT: '0.1000000000' }),
  };

  const result = await reconcile(db, 'live', krakenClient);

  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].type, 'missing_stop_order');
});

test('reconcile flags a Kraken order the DB does not recognize', async () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'live', { openPositions: [makeLivePosition()] });
  const krakenClient = {
    getOpenOrders: async () => ({ open: { 'STOP-TXID-1': { status: 'open' }, 'MYSTERY-TXID': { status: 'open' } } }),
    getBalance: async () => ({ XXBT: '0.1000000000' }),
  };

  const result = await reconcile(db, 'live', krakenClient);

  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].type, 'unexpected_order');
});

test('reconcile flags a position whose coin balance on Kraken is short', async () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'live', { openPositions: [makeLivePosition({ units: 0.5 })] });
  const krakenClient = {
    getOpenOrders: async () => ({ open: { 'STOP-TXID-1': { status: 'open' } } }),
    getBalance: async () => ({ XXBT: '0.1000000000' }), // DB expects 0.5
  };

  const result = await reconcile(db, 'live', krakenClient);

  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].type, 'insufficient_balance');
});

test('reconcile reports multiple simultaneous mismatches, not just the first', async () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'live', { openPositions: [makeLivePosition({ units: 0.5 })] });
  const krakenClient = {
    getOpenOrders: async () => ({ open: { 'MYSTERY-TXID': { status: 'open' } } }), // stop missing AND an unexpected order
    getBalance: async () => ({ XXBT: '0.1000000000' }), // AND insufficient balance
  };

  const result = await reconcile(db, 'live', krakenClient);

  assert.equal(result.ok, false);
  const types = result.mismatches.map((m) => m.type).sort();
  assert.deepEqual(types, ['insufficient_balance', 'missing_stop_order', 'unexpected_order']);
});

test('reconcile tolerates a tiny balance shortfall from fee rounding', async () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'live', { openPositions: [makeLivePosition({ units: 0.1 })] });
  const krakenClient = {
    getOpenOrders: async () => ({ open: { 'STOP-TXID-1': { status: 'open' } } }),
    getBalance: async () => ({ XXBT: '0.0999500000' }), // 0.05% short, under the 0.1% tolerance
  };

  const result = await reconcile(db, 'live', krakenClient);

  assert.deepEqual(result, { ok: true });
});

test('reconcile treats a never-saved scheduler state as zero open positions, not a crash', async () => {
  const db = openDb(':memory:');
  const krakenClient = {
    getOpenOrders: async () => ({ open: {} }),
    getBalance: async () => ({}),
  };

  const result = await reconcile(db, 'live', krakenClient);

  assert.deepEqual(result, { ok: true });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/broker-reconcile.test.js`
Expected: FAIL — `Cannot find module '../src/broker/reconcile'`

- [ ] **Step 4: Implement**

Create `src/broker/reconcile.js`:

```js
'use strict';
const { loadSchedulerState } = require('../data/db');
const { BALANCE_ASSET_CODES } = require('../engine/config');

const BALANCE_TOLERANCE_PCT = 0.001;

async function reconcile(db, mode, krakenClient) {
  if (mode !== 'live') return { ok: true };

  const state = loadSchedulerState(db, mode) || { openPositions: [] };
  const openOrdersResult = await krakenClient.getOpenOrders();
  const balanceResult = await krakenClient.getBalance();

  const openTxids = new Set(Object.keys(openOrdersResult.open || {}));
  const trackedTxids = new Set(state.openPositions.map((p) => p.stopOrderTxid));

  const mismatches = [];

  for (const position of state.openPositions) {
    if (!openTxids.has(position.stopOrderTxid)) {
      mismatches.push({
        type: 'missing_stop_order',
        detail: `position ${position.candidateId} (${position.coin}) expects open stop order ${position.stopOrderTxid}, not found on Kraken`,
      });
    }
  }

  for (const txid of openTxids) {
    if (!trackedTxids.has(txid)) {
      mismatches.push({ type: 'unexpected_order', detail: `Kraken order ${txid} is open but not tracked by any DB position` });
    }
  }

  for (const position of state.openPositions) {
    const assetCode = BALANCE_ASSET_CODES[position.coin];
    const balance = Number(balanceResult[assetCode] ?? 0);
    if (balance < position.units * (1 - BALANCE_TOLERANCE_PCT)) {
      mismatches.push({
        type: 'insufficient_balance',
        detail: `position ${position.candidateId} expects ${position.units} ${position.coin}, Kraken balance is ${balance}`,
      });
    }
  }

  return mismatches.length > 0 ? { ok: false, mismatches } : { ok: true };
}

module.exports = { reconcile, BALANCE_TOLERANCE_PCT };
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/broker-reconcile.test.js`
Expected: PASS (8/8)

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/broker/reconcile.js src/engine/config.js test/broker-reconcile.test.js
git commit -m "feat(broker): add reconcile (DB vs Kraken open orders/balance, 3 mismatch types), uncalled until a live scheduler entry point exists"
```

## Exit check

- [ ] `node --test test/` passes (4 new `tryOpenPosition` tests + 5 new `evaluateExit`/`closePosition` tests in `test/broker-live.test.js`, 2 new `selectBroker` tests in `test/scheduler-cycle.test.js`, 8 new tests in `test/broker-reconcile.test.js`, plus every prior test unchanged).
- [ ] A real run against the real Pi database confirms paper-mode behavior is byte-for-byte unchanged (Task 3 Step 6).
- [ ] A grep-based check confirms no caller anywhere in the codebase constructs `runCycle` with `mode === 'live'` (Task 3 Step 7) — live stays dormant by construction.
- [ ] **Known limitation carried forward:** none of this code has been proven against the real Kraken API — the account holds zero funds. Milestone 10 proper must re-verify with `scripts/verify-kraken-orders.js`-style checks once funded, per `docs/v2-design.md` §6.
- [ ] **Reconcile is built but uncalled.** No live scheduler entry point or systemd service exists yet for it to run from at startup — that wiring is deferred to milestone 10 proper, per the spec's Non-goals.
- [ ] No dashboard UI (go-live checklist panel) in this plan — deferred, per the spec's Non-goals.
