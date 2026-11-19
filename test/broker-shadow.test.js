'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openShadowPosition, resolveShadowPositions } = require('../src/broker/shadow');

function sampleCandidate() {
  return {
    id: 'c_20261118_10_SOL_trend_pullback', coin: 'SOL', setup: 'trend_pullback',
    entry: 100, atr: 5, exitType: 'trailing_stop',
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
  };
}

test('openShadowPosition builds a position using the default action, independent of what Claude decided', () => {
  const position = openShadowPosition(sampleCandidate());
  assert.equal(position.candidateId, 'c_20261118_10_SOL_trend_pullback');
  assert.equal(position.coin, 'SOL');
  assert.equal(position.exitType, 'trailing_stop');
  assert.equal(position.initialStopPrice, 100 - 1.5 * 5); // entry - stopAtr*atr, same formula tryOpenPosition uses
  assert.ok(position.units > 0);
  assert.ok(position.riskAmount > 0);
});

test('resolveShadowPositions closes a shadow position that hits its stop, using evaluateExit', () => {
  const position = openShadowPosition(sampleCandidate());
  const coinData = {
    SOL: {
      candles1h: [{ ts: 3600, high: 95, low: 90, close: 92 }], // breaches initialStopPrice of 92.5
      ema20By4hTs: new Map(),
    },
  };
  const { stillOpen, resolved } = resolveShadowPositions([{ ...position, entryTs: 0 }], coinData);
  assert.equal(stillOpen.length, 0);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].candidateId, 'c_20261118_10_SOL_trend_pullback');
  assert.equal(resolved[0].exitReason, 'stop');
  assert.ok(resolved[0].r < 0); // a stop-out is a losing trade
});

test('resolveShadowPositions keeps a position open if no 1h candle has arrived to check yet', () => {
  const position = openShadowPosition(sampleCandidate());
  const coinData = { SOL: { candles1h: [], ema20By4hTs: new Map() } };
  const { stillOpen, resolved } = resolveShadowPositions([{ ...position, entryTs: 0 }], coinData);
  assert.equal(stillOpen.length, 1);
  assert.equal(resolved.length, 0);
});
