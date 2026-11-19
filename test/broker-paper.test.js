'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fillEntry, fillExit, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT } = require('../src/broker/paper');

test('fillEntry slips the price up (worse for a buyer) and charges the maker fee', () => {
  const result = fillEntry({
    candidate: { entry: 100 },
    sizing: { stakeValue: 1000 },
  });

  assert.equal(result.fillPrice, 100 * (1 + DEFAULT_SLIPPAGE_PCT));
  assert.equal(result.feeAmount, 1000 * DEFAULT_FEES.makerPct);
});

test('fillExit slips the price down (worse for a seller) and charges the taker fee', () => {
  const result = fillExit({
    exitPrice: 100,
    stakeValue: 1000,
  });

  assert.equal(result.fillPrice, 100 * (1 - DEFAULT_SLIPPAGE_PCT));
  assert.equal(result.feeAmount, 1000 * DEFAULT_FEES.takerPct);
});

test('fillEntry/fillExit accept overrides for fees and slippage', () => {
  const entry = fillEntry({
    candidate: { entry: 100 }, sizing: { stakeValue: 1000 },
    fees: { makerPct: 0.001, takerPct: 0.002 }, slippagePct: 0.01,
  });
  assert.equal(entry.fillPrice, 101);
  assert.equal(entry.feeAmount, 1);
});

const { evaluateExit } = require('../src/broker/paper');

function trailingPosition(overrides = {}) {
  return {
    exitType: 'trailing_stop', entryPrice: 100, initialStopPrice: 90,
    trailAtr: 3, atrAtEntry: 5, // trail distance = 15
    ...overrides,
  };
}

test('trailing_stop ratchets the stop up as price makes new highs, never loosens', () => {
  const position = trailingPosition();
  const candles1h = [
    { ts: 3600, high: 110, low: 108, close: 109 },  // highestHigh=110, trail=95, stop=max(90,95)=95
    { ts: 7200, high: 130, low: 125, close: 128 },  // highestHigh=130, trail=115, stop=max(90,115)=115
    { ts: 10800, high: 131, low: 114, close: 116 }, // highestHigh=131, trail=116, stop=116 -> low 114 <= 116, exit
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 10800, exitPrice: 116, reason: 'stop' });
});

test('trailing_stop exits at the fixed initial stop if price never rallies', () => {
  const position = trailingPosition();
  const candles1h = [
    { ts: 3600, high: 101, low: 99, close: 100 },  // no new high worth trailing from
    { ts: 7200, high: 100, low: 89, close: 90 },   // low 89 <= initial stop 90
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 7200, exitPrice: 90, reason: 'stop' });
});

test('trailing_stop returns null (stays open) if neither the trail nor the initial stop is touched', () => {
  const position = trailingPosition();
  const candles1h = [
    { ts: 3600, high: 105, low: 100, close: 103 },
    { ts: 7200, high: 106, low: 101, close: 104 },
  ];

  assert.equal(evaluateExit(position, { candles1h, ema20By4hTs: new Map() }), null);
});
