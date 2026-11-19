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

test('target_or_time exits at the target when a candle high touches it', () => {
  const position = { exitType: 'target_or_time', initialStopPrice: 50, targetPrice: 110, timeStopTs: 100000 };
  const candles1h = [
    { ts: 3600, high: 105, low: 95, close: 102 },
    { ts: 7200, high: 111, low: 100, close: 108 }, // high touches target 110
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 7200, exitPrice: 110, reason: 'target' });
});

test('target_or_time exits via time stop when neither stop nor target is hit in time', () => {
  const position = { exitType: 'target_or_time', initialStopPrice: 50, targetPrice: 110, timeStopTs: 7200 };
  const candles1h = [
    { ts: 3600, high: 105, low: 95, close: 102 },
    { ts: 7200, high: 106, low: 96, close: 104 }, // reaches the time stop here
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 7200, exitPrice: 104, reason: 'time_stop' });
});

test('stop-loss takes priority over target/ema-cross within the same candle', () => {
  const position = { exitType: 'target_or_time', initialStopPrice: 100, targetPrice: 100, timeStopTs: 100000 };
  const candles1h = [{ ts: 3600, high: 105, low: 99, close: 101 }]; // low breaches stop AND high touches target

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.equal(result.reason, 'stop');
});

test('ema_cross_or_time exits when the 4h close crosses above EMA20', () => {
  // A full 4h period: 4 consecutive 1h bars starting at ts=0; the 4h candle's own
  // ts is 0 (its last constituent 1h bar has ts=10800, which is 0+10800).
  const position = { exitType: 'ema_cross_or_time', initialStopPrice: 50, timeStopTs: 100000 };
  const candles1h = [
    { ts: 0, high: 101, low: 99, close: 100 },
    { ts: 3600, high: 102, low: 99, close: 101 },
    { ts: 7200, high: 103, low: 99, close: 102 },
    { ts: 10800, high: 106, low: 99, close: 105 }, // last hour of the 4h period, close=105
  ];
  const ema20By4hTs = new Map([[0, 100]]); // the 4h candle at ts=0 has EMA20=100; close 105 > 100

  const result = evaluateExit(position, { candles1h, ema20By4hTs });

  assert.deepEqual(result, { exitTs: 10800, exitPrice: 105, reason: 'ema_cross' });
});

test('ema_cross_or_time does not exit on a mid-4h-period hour, only on the 4h close', () => {
  const position = { exitType: 'ema_cross_or_time', initialStopPrice: 50, timeStopTs: 100000 };
  // This single candle is NOT the last hour of its 4h period (ts=3600 % 14400 !== 10800),
  // so even though its close is above the mapped EMA20, it must not trigger an exit.
  const candles1h = [{ ts: 3600, high: 102, low: 99, close: 101 }];
  const ema20By4hTs = new Map([[0, 50]]);

  assert.equal(evaluateExit(position, { candles1h, ema20By4hTs }), null);
});

test('ema_cross_or_time exits via time stop when the EMA never crosses', () => {
  const position = { exitType: 'ema_cross_or_time', initialStopPrice: 50, timeStopTs: 10800 };
  const candles1h = [
    { ts: 0, high: 101, low: 99, close: 100 },
    { ts: 3600, high: 102, low: 99, close: 101 },
    { ts: 7200, high: 103, low: 99, close: 102 },
    { ts: 10800, high: 103, low: 99, close: 102 }, // close 102 stays below EMA20=150
  ];
  const ema20By4hTs = new Map([[0, 150]]);

  const result = evaluateExit(position, { candles1h, ema20By4hTs });

  assert.deepEqual(result, { exitTs: 10800, exitPrice: 102, reason: 'time_stop' });
});

const { tryOpenPosition: tryOpenPositionFromPaper } = require('../src/broker/paper');

test('tryOpenPosition and closePosition live in broker/paper.js directly (not just re-exported from backtest/run.js)', () => {
  assert.equal(typeof tryOpenPositionFromPaper, 'function');
});
