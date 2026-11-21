'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tryOpenPosition } = require('../src/broker/live');
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
