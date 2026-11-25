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
    { ts: 3600, high: 110, low: 108, close: 109 },  // stop checked at entry's highestHigh=100 (85,floor 90); low 108 holds; highestHigh -> 110
    { ts: 7200, high: 130, low: 125, close: 128 },  // stop checked at highestHigh=110 (95); low 125 holds; highestHigh -> 130
    { ts: 10800, high: 131, low: 114, close: 116 }, // stop checked at highestHigh=130 (trail=115) -> low 114 <= 115, exit at 115
                                                     // (this candle's own high of 131 is never used — it would only raise the stop for a LATER candle)
  ];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.deepEqual(result, { exitTs: 10800, exitPrice: 115, reason: 'stop' });
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

test('trailing_stop does not use a candle\'s OWN high to raise the stop level checked against that SAME candle\'s low (no same-bar look-ahead)', () => {
  const position = trailingPosition(); // entryPrice=100, initialStopPrice=90, trail distance=15
  // Using this candle's own high (130) to raise the stop to 130-15=115 would make low=95 breach
  // it — but that higher stop level was only reachable within this bar if the high happened
  // before the low, which can't be assumed from an hourly candle's OHLC alone. The stop in
  // effect ENTERING this candle is still based on the prior highestHigh (entryPrice=100, so
  // trail=85, floor=90) — low=95 is above that, so this must stay open.
  const candles1h = [{ ts: 3600, high: 130, low: 95, close: 120 }];

  const result = evaluateExit(position, { candles1h, ema20By4hTs: new Map() });

  assert.equal(result, null, "must not exit using a stop level only reachable via this same candle's own high");
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

const { candlesSinceEntry } = require('../src/broker/paper');
const FOUR_H = 4 * 3600;

test('candlesSinceEntry excludes every hourly candle inside the entry bar itself — the position did not exist until that bar closed', () => {
  // Candles are keyed by bucket START (src/data/candles.js convention). A position entered
  // using entryTs=0's CLOSE (which happens at ts=FOUR_H, not at ts=0) must never see the
  // hourly candles at ts=0, 3600, 7200, 10800 — those are the entry bar's own hours, all of
  // which occurred strictly before the fill.
  const entryTs = 0;
  const candles1h = [
    { ts: 0, high: 200, low: 50, close: 100 },     // entry bar, hour 0 — must be excluded
    { ts: 3600, high: 200, low: 50, close: 105 },  // entry bar, hour 1 — must be excluded
    { ts: 7200, high: 200, low: 50, close: 110 },  // entry bar, hour 2 — must be excluded
    { ts: 10800, high: 200, low: 50, close: 115 }, // entry bar, hour 3 (closes the bar) — must be excluded
    { ts: 14400, high: 120, low: 110, close: 118 }, // first hour of the NEXT bar — first eligible candle
  ];

  const result = candlesSinceEntry(candles1h, entryTs, 100000);

  assert.deepEqual(result.map((c) => c.ts), [14400]);
});

test('candlesSinceEntry respects the upper bound (uptoTs)', () => {
  const entryTs = 0;
  const candles1h = [
    { ts: 14400, high: 120, low: 110, close: 118 },
    { ts: 18000, high: 125, low: 115, close: 120 },
  ];

  const result = candlesSinceEntry(candles1h, entryTs, 14400);

  assert.deepEqual(result.map((c) => c.ts), [14400]);
});

const { tryOpenPosition: tryOpenPositionForFees, closePosition: closePositionForFees } = require('../src/broker/paper');

function baseState() { return { balance: 1000, dailyPnl: 0, openPositions: [], cooldowns: {}, closedTrades: [] }; }
function baseConfig() {
  return { baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015, maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6, roundTripFeePct: 0.01 };
}
function baseCandidate() {
  return { coin: 'BTC', setup: 'trend_breakout', entry: 100, atr: 10, default: { action: 'take', size: 1, stopAtr: 1 }, exitType: 'trailing_stop' };
}
const minimalData = { candles4h: [{ ts: 0, close: 100 }], indicators: { bollinger20: { middle: [null] } } };

test('tryOpenPosition/closePosition use the existing DEFAULT_FEES/DEFAULT_SLIPPAGE_PCT when config has no fee override — unchanged from before', () => {
  const state = baseState();
  tryOpenPositionForFees(state, baseCandidate(), minimalData, 0, baseConfig());
  const position = state.openPositions[0];

  assert.equal(position.entryPrice, 100 * (1 + DEFAULT_SLIPPAGE_PCT));
  assert.equal(position.entryFee, (position.units * 100) * DEFAULT_FEES.makerPct);
});

test('tryOpenPosition/closePosition honor a custom fees/slippagePct on config, for simulating a different fee tier', () => {
  const state = baseState();
  const config = { ...baseConfig(), fees: { makerPct: 0.004, takerPct: 0.008 }, slippagePct: 0.001 };
  tryOpenPositionForFees(state, baseCandidate(), minimalData, 0, config);
  const position = state.openPositions[0];

  assert.equal(position.entryPrice, 100 * 1.001);
  assert.equal(position.entryFee, (position.units * 100) * 0.004);

  closePositionForFees(state, position, { exitTs: 3600, exitPrice: 100, reason: 'stop' }, config);
  const trade = state.closedTrades[0];
  assert.equal(trade.exitPrice, 100 * (1 - 0.001));
});
