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
