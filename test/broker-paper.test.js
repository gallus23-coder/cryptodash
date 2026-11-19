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
