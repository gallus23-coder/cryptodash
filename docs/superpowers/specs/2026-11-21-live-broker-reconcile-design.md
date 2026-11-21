# Live broker + reconcile-on-startup — design spec

**Status:** Approved (brainstorming session, 2026-11-21)
**Parent spec:** `docs/v2-design.md` §3 (architecture), §6 (execution), §7 (database), §11 (go-live criteria), §13 Stage A ("Client order IDs + reconcile on startup").

## Purpose

Close the last untestable item in the go-live checklist (§11: "Reconcile, kill switch and daily loss limit all tested deliberately") by building the real Kraken order-placement broker and the startup reconciliation check that `CLAUDE.md` and the design doc require but which have never existed in code. This is milestone 10 **preparation**: the code is built, tested, and wired into `runCycle`'s `mode === 'live'` path, but nothing in the real system currently invokes that path — `scheduler.js` hardcodes `MODE = 'paper'`, and no live scheduler entry point or systemd service exists. Live stays dormant by construction, not by a disabled flag.

**Known, unavoidable limitation:** the Kraken account configured for this project currently holds zero funds. No real order can be placed or filled, so none of this code can be proven against the real API the way every prior `cycle.js` change this session was (a real run against the live Pi database). The only proof available is unit tests against a mocked Kraken client. This is flagged explicitly rather than skipped or faked — milestone 10 proper must re-verify this code for real, exactly as `docs/v2-design.md` §6 already calls out ("Live order placement and the reservation check are still unverified against the real account... re-run `scripts/verify-kraken-orders.js`-style checks once it's funded").

## Non-goals

- Switching live mode on. No UI mode-switcher, no `LIVE` typed-confirmation flow (design doc §8.4), no live systemd service. Those are milestone 10 proper, gated on the go-live criteria this plan doesn't touch (trade count, scorecard, Kraken key permission check).
- Kraken's native `trailing-stop` order type. Its spot trigger-offset semantics are unverified and the account can't be funded to test them; see "Stop and exit management" below for the chosen alternative.
- A live scheduler entry point or systemd unit for `reconcile.js`'s caller. `reconcile.js` is built and fully tested as a standalone, exported function; wiring it into an actual live-mode startup sequence happens when milestone 10 proper creates that sequence.
- Dashboard UI (go-live checklist panel, "Run test" buttons). That was discussed as a possible slice of this work but is deferred to a follow-up plan once this backend exists for it to call.

## Architecture

```
src/broker/
  paper.js      (unchanged)
  live.js        NEW — real Kraken order placement, same call shape as paper.js
  reconcile.js   NEW — startup check: DB open positions vs Kraken open orders/balances
src/scheduler/
  cycle.js       MODIFIED — branches broker calls on mode
```

### `live.js` interface

Matches `paper.js`'s actual exported shape (not the design doc's higher-level `placeEntry`/`placeStop`/`amendStop`/`close`/`getPositions` sketch — that sketch predates the real `paper.js` implementation, which already settled on `tryOpenPosition`/`evaluateExit`/`closePosition`):

```js
async function tryOpenPosition(state, candidate, data, i, config, krakenClient)
async function evaluateExit(position, context, krakenClient)   // context arg kept for call-site symmetry with paper.js, unused by live
async function closePosition(state, position, exit, config)
```

All three are `async`; `paper.js`'s are not, but `await` on a synchronous return value resolves immediately, so `cycle.js` can `await` uniformly regardless of which broker module is selected.

### Entry lifecycle (poll within the same cycle)

`tryOpenPosition`:
1. Guardrail checks — reuses `checkGuardrails`/`sizePosition`/`checkFeeViability` from `engine/risk.js` unchanged (pure, no Kraken-specific logic).
2. Places a post-only limit entry via `krakenClient.addOrder` with `userref`/client-order-id built from `candidate.id` (same `buildCandidateId` already used everywhere else — a restart can't double-send because the same candidate always produces the same ID).
3. Polls `krakenClient.queryOrders([txid])` every `config.liveOrderPollMs` (new config field, default `10000`) until the order's status is `closed` (filled) or `config.liveOrderTimeoutMs` (new config field, default `15 * 60 * 1000`) has elapsed since the order was placed.
4. **Timeout:** `cancelOrder(txid)`, return `null` (no position opened) — `cycle.js`'s existing candidate/shadow-tracking flow already handles a candidate that didn't open a position; this plan adds no new "missed" bookkeeping beyond what already exists for a `take` decision that fails `checkGuardrails`.
5. **Filled:** immediately place the single exit order — a plain `stop-loss` order at `candidate.entry - candidate.default.stopAtr * candidate.atr` (same stop-price formula `paper.js` already uses), client-order-id again built from the candidate ID. Push the position onto `state.openPositions` with the same shape `paper.js` uses, plus `stopOrderTxid`.

A cycle in live mode can now take up to ~15 minutes per entry attempt instead of seconds. This only affects the `mode === 'live'` path; `scheduler.js`'s real paper cron job is unaffected.

### Stop and exit management (every cycle, for every open live position)

Every cycle, for each open live position, before deciding whether to evaluate new candidates:

1. `krakenClient.queryOrders([position.stopOrderTxid])`.
2. **Order closed (filled):** position exited. Build an `exit` object `{exitTs, exitPrice, reason: 'stop', feeAmount}` from the real order's fill price and fee (Kraken returns both in `QueryOrders`), then call `closePosition(state, position, exit, config)` — which uses `exit.feeAmount` directly instead of `paper.js`'s simulated `fillExit` fee model, since the real fee is already known exactly.
3. **Order still open:** recompute the trail level using the *exact same formula* `paper.js`'s `evaluateExit` already uses — `highestHigh` since entry (seeded at `entryPrice`, matching the fix from milestone 7 Part D), floored at `initialStopPrice`, fed with real 1h candles already ingested this cycle (not simulated ones). If the recomputed level is strictly tighter than the order's current `trigger_price`, `amendOrder` it (tighten-only — matches `CLAUDE.md`'s "stops only tighten" rule, and reuses the one Kraken order-mutation behavior milestone 1 already confirmed works: `AmendOrder` preserves order ID and queue position).
4. For `target_or_time`/`ema_cross_or_time` exit types specifically: additionally check the current price (from the same freshly-ingested candle) against `targetPrice` / the EMA20-cross condition / `timeStopTs`, using the exact same conditions `paper.js`'s `evaluateExit` already encodes. If hit, `cancelOrder` the stop order, place a market sell to close, and treat that fill the same way as step 2.

This deliberately avoids ever placing a Kraken native `trailing-stop` order. Every live position has exactly one order on Kraken at any time — a `stop-loss` order, sometimes amended, never duplicated — matching "one exit order per position" and the milestone-1-confirmed fact that Kraken itself rejects a second sell order on the same holding.

### `reconcile.js`

```js
async function reconcile(db, mode, krakenClient)
// -> { ok: true } | { ok: false, mismatches: [{ type, detail }, ...] }
```

For `mode !== 'live'`: returns `{ ok: true }` immediately, no network call — paper positions have no real Kraken orders to reconcile against.

For `mode === 'live'`:
1. Load `state.openPositions` from `scheduler_state` via the existing `loadSchedulerState(db, mode)`.
2. Fetch `krakenClient.getOpenOrders()` and `krakenClient.getBalance()`.
3. **Mismatch type `missing_stop_order`:** a DB position's `stopOrderTxid` doesn't appear in Kraken's open orders (it filled or was cancelled while the process was down).
4. **Mismatch type `unexpected_order`:** a Kraken open order's client-order-id doesn't correspond to any DB position's `stopOrderTxid` (something placed an order the DB doesn't know about).
5. **Mismatch type `insufficient_balance`:** a coin with an open DB position has a Kraken balance below the DB's recorded `units`, allowing a `BALANCE_TOLERANCE_PCT` (new constant, `0.001` = 0.1%) tolerance for fee rounding — i.e. a mismatch is `krakenBalance < units * (1 - BALANCE_TOLERANCE_PCT)`.

Any mismatch → `{ ok: false, mismatches }`. This function does not itself pause anything or send an alert — it reports; the caller (a future live scheduler's startup sequence, built in milestone 10 proper once it exists) is responsible for refusing to start the scheduler and alerting when `ok` is `false`. That caller doesn't exist yet (no live scheduler entry point exists), so this plan builds `reconcile` as a fully tested, exported, but currently uncalled function — the same "correct but dormant" shape as `live.js`'s wiring into `cycle.js`.

### Wiring into `cycle.js`

```js
const paperBroker = require('../broker/paper');
const liveBroker = require('../broker/live');
// ...
const broker = mode === 'live' ? liveBroker : paperBroker;
```

Every existing call site that currently calls `tryOpenPosition(...)`, `evaluateExit(...)`, `closePosition(...)` directly is changed to `broker.tryOpenPosition(...)` / `await broker.evaluateExit(...)` / `broker.closePosition(...)` (all three `await`ed uniformly), with one additional trailing `krakenClient` argument added to the `tryOpenPosition`/`evaluateExit` call sites. `paper.js` needs **zero source changes** — JavaScript silently ignores extra call arguments, and `await` on a plain return value resolves immediately.

`krakenClient` is already a parameter `runCycle` receives (`runCycle(db, krakenClient, mode, config, now)`), so no new parameter threading is needed.

## Data model

No new tables. `scheduler_state`'s position objects gain one field for live positions: `stopOrderTxid` (string, Kraken transaction ID). Paper positions never have this field; nothing reads it unless `mode === 'live'`.

## Error handling

- `addOrder` failing (rejected by Kraken, network error): `tryOpenPosition` returns `null`, same as a guardrail block — no position opened, no retry (an `AddOrder` that times out mid-request may have already placed the order; retrying blindly risks a double position, which is why `src/kraken/rest.js`'s `addOrder` already sets `retry: false` — this plan relies on that existing behavior, doesn't change it).
- `queryOrders`/`amendOrder`/`cancelOrder` failing mid-cycle: the error propagates up through `runCycle`'s existing top-level `try`/`catch`, which already logs it to `cycle_log` with `error: err.message` and returns `{ error: err.message }` — no new error handling needed, the existing scaffolding already covers a broker call throwing.
- `reconcile` itself never throws for a mismatch — mismatches are data in the return value, not exceptions. It only throws if the Kraken calls themselves fail (network/auth), which the (not-yet-built) caller must handle the same way any other startup failure would be handled.

## Testing strategy

**Every test in this plan uses a mocked `krakenClient`** — a plain object with `node:test` mock functions (`addOrder`, `queryOrders`, `cancelOrder`, `amendOrder`, `getOpenOrders`, `getBalance`) returning canned, Kraken-response-shaped data. This is the explicit, documented deviation from this session's "prove heavy orchestration via a real run" convention, for the reason stated in Purpose: there is no funded account to run against.

Required coverage (each becomes a task-level test in the implementation plan):
- Entry fills within the poll window → position opens with the real fill price.
- Entry never fills within 15 minutes → order cancelled, no position opened.
- Open position's stop order still open, price hasn't moved → no amend call made (don't amend when nothing changed).
- Open position's stop order still open, price has moved favorably → `amendOrder` called with the tighter `trigger_price`, never looser.
- Open position's stop order has closed (filled) → position closes using the real fill price/fee from the order, not a simulated one.
- `target_or_time`/`ema_cross_or_time` position whose target/EMA-cross/time-stop condition is met → stop order cancelled, market sell placed, position closes.
- `reconcile` with everything matching → `{ ok: true }`, zero mismatches.
- `reconcile` with a DB position whose stop order is missing from Kraken → `missing_stop_order` mismatch.
- `reconcile` with a Kraken order the DB doesn't recognize → `unexpected_order` mismatch.
- `reconcile` with a DB position whose coin balance on Kraken is short → `insufficient_balance` mismatch.
- `reconcile` for `mode !== 'live'` → `{ ok: true }` immediately, confirmed the mock client's methods were never called.
- `cycle.js`'s broker-selection: a `runCycle` call with `mode === 'live'` exercises `live.js`'s functions (via the mock), and `mode === 'paper'` continues to exercise `paper.js` exactly as before (a regression test against the full existing paper-mode test suite, not a new test).

## Review Focus (carried into the implementation plan)

- A live entry that times out must not leave an orphaned limit order on Kraken — the cancel must actually be called before returning, and a test must assert the mock's `cancelOrder` was called with the right `txid`.
- `amendOrder` must never be called with a *looser* trigger price than the order currently has — a test must cover a price move that's unfavorable (stop should stay put, not loosen).
- `reconcile`'s three mismatch types must be independently triggerable and independently detectable in the same call (a test with two simultaneous mismatches must report both, not just the first).
- Live mode must stay provably dormant: a test (or a clear code-reading check written up in the plan) must confirm nothing in the current `scheduler.js`/`dashboard.js` ever constructs a `runCycle` call with `mode === 'live'`.
- `closePosition`'s use of `exit.feeAmount` (live, real) vs `paper.js`'s simulated fee must not silently diverge in a way that makes live P&L look wrong by using the wrong fee model for the wrong mode — a test must confirm live's `closePosition` uses the fee carried on `exit`, not a recomputed one.
