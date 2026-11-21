'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tryOpenPosition, evaluateExit, closePosition } = require('../src/broker/live');
const { DEFAULT_RISK_CONFIG } = require('../src/engine/config');

function makeCandidate(overrides = {}) {
  return {
    id: 'c_20261121_12_BTC_trend_pullback', coin: 'BTC', setup: 'trend_pullback',
    entry: 60000, atr: 1560, exitType: 'trailing_stop',
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
