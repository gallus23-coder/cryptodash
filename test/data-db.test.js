'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, upsertCandles, getCandles, getLastCandleTime, getExistingTimes } = require('../src/data/db');

function freshDb() {
  return openDb(':memory:');
}

test('getLastCandleTime returns null when no candles exist', () => {
  const db = freshDb();
  assert.equal(getLastCandleTime(db, 'BTC', '1h'), null);
});

test('upsertCandles inserts rows and getCandles reads them back in order', () => {
  const db = freshDb();
  const rows = [
    { coin: 'BTC', timeframe: '1h', ts: 2000, open: 2, high: 3, low: 1, close: 2.5, volume: 10, trades: 5 },
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 8, trades: 3 },
  ];

  const count = upsertCandles(db, rows);

  assert.equal(count, 2);
  const result = getCandles(db, 'BTC', '1h', 0, 3000);
  assert.deepEqual(result.map((r) => r.ts), [1000, 2000]);
  assert.equal(result[0].close, 1.5);
  assert.equal(getLastCandleTime(db, 'BTC', '1h'), 2000);
});

test('upsertCandles is idempotent: re-inserting the same ts updates instead of duplicating', () => {
  const db = freshDb();
  upsertCandles(db, [{ coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 8, trades: 3 }]);
  upsertCandles(db, [{ coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 2.5, low: 0.5, close: 1.9, volume: 9, trades: 4 }]);

  const result = getCandles(db, 'BTC', '1h', 0, 3000);

  assert.equal(result.length, 1);
  assert.equal(result[0].close, 1.9);
  assert.equal(result[0].volume, 9);
});

test('candles are isolated per coin and per timeframe', () => {
  const db = freshDb();
  upsertCandles(db, [
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: 1 },
    { coin: 'ETH', timeframe: '1h', ts: 1000, open: 2, high: 2, low: 2, close: 2, volume: 2, trades: 2 },
    { coin: 'BTC', timeframe: '4h', ts: 1000, open: 3, high: 3, low: 3, close: 3, volume: 3, trades: 3 },
  ]);

  assert.equal(getCandles(db, 'BTC', '1h', 0, 3000).length, 1);
  assert.equal(getCandles(db, 'BTC', '1h', 0, 3000)[0].close, 1);
  assert.equal(getCandles(db, 'ETH', '1h', 0, 3000)[0].close, 2);
  assert.equal(getCandles(db, 'BTC', '4h', 0, 3000)[0].close, 3);
});

test('getExistingTimes returns just the ts column in range, ascending', () => {
  const db = freshDb();
  upsertCandles(db, [
    { coin: 'BTC', timeframe: '1h', ts: 3000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
    { coin: 'BTC', timeframe: '1h', ts: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
    { coin: 'BTC', timeframe: '1h', ts: 5000, open: 1, high: 1, low: 1, close: 1, volume: 1, trades: null },
  ]);

  assert.deepEqual(getExistingTimes(db, 'BTC', '1h', 0, 4000), [1000, 3000]);
});

const { insertTrade, getTrades, saveSchedulerState, loadSchedulerState, insertCycleLog, getCycleLog, resetKillSwitch } = require('../src/data/db');

test('insertTrade/getTrades round-trips a closed trade, filtered by mode', () => {
  const db = openDb(':memory:');
  insertTrade(db, {
    mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 1000, exitTs: 2000,
    entryPrice: 100, exitPrice: 105, units: 1, riskAmount: 10, pnl: 5, r: 0.5, exitReason: 'stop',
  });
  insertTrade(db, {
    mode: 'live', coin: 'ETH', setup: 'range_reversion', entryTs: 1500, exitTs: 2500,
    entryPrice: 50, exitPrice: 48, units: 2, riskAmount: 8, pnl: -4, r: -0.5, exitReason: 'target',
  });

  const paperTrades = getTrades(db, 'paper');

  assert.equal(paperTrades.length, 1);
  assert.equal(paperTrades[0].coin, 'BTC');
  assert.equal(paperTrades[0].r, 0.5);
});

test('getTrades orders by exitTs ascending', () => {
  const db = openDb(':memory:');
  insertTrade(db, { mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 1, exitTs: 300, entryPrice: 1, exitPrice: 1, units: 1, riskAmount: 1, pnl: 0, r: 0, exitReason: 'stop' });
  insertTrade(db, { mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 1, exitTs: 100, entryPrice: 1, exitPrice: 1, units: 1, riskAmount: 1, pnl: 0, r: 0, exitReason: 'stop' });

  assert.deepEqual(getTrades(db, 'paper').map((t) => t.exitTs), [100, 300]);
});

test('saveSchedulerState/loadSchedulerState round-trips the full state shape, per mode', () => {
  const db = openDb(':memory:');
  const state = {
    balance: 987.65, dailyPnl: -12.3, currentDay: 20261, weeklyPeakBalance: 1000,
    killSwitchActive: false, openPositions: [{ coin: 'BTC', entryPrice: 100 }], cooldowns: { ETH: 123456 },
  };

  saveSchedulerState(db, 'paper', state);

  assert.deepEqual(loadSchedulerState(db, 'paper'), state);
  assert.equal(loadSchedulerState(db, 'live'), null); // different mode, never saved
});

test('saveSchedulerState overwrites the previous state for the same mode', () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'paper', { balance: 1000 });
  saveSchedulerState(db, 'paper', { balance: 950 });

  assert.deepEqual(loadSchedulerState(db, 'paper'), { balance: 950 });
});

test('resetKillSwitch clears killSwitchActive and rebases weeklyPeakBalance to the current balance', () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'paper', {
    balance: 920, dailyPnl: 0, currentDay: 10, weeklyPeakBalance: 1000, killSwitchActive: true,
    openPositions: [], cooldowns: {}, closedTrades: [], shadowPositions: [], disabledSetups: {}, lastRegimeLabel: 'trend_up',
  });

  const result = resetKillSwitch(db, 'paper');

  assert.equal(result.killSwitchActive, false);
  assert.equal(result.weeklyPeakBalance, 920); // rebased to current balance, so weeklyDrawdownPct is 0 immediately — otherwise next cycle re-trips instantly
  assert.equal(loadSchedulerState(db, 'paper').killSwitchActive, false);
});

test('resetKillSwitch leaves every other state field untouched', () => {
  const db = openDb(':memory:');
  saveSchedulerState(db, 'paper', {
    balance: 920, dailyPnl: -10, currentDay: 10, weeklyPeakBalance: 1000, killSwitchActive: true,
    openPositions: [{ coin: 'BTC', entryPrice: 100 }], cooldowns: { ETH: 123 }, closedTrades: [], shadowPositions: [], disabledSetups: { trend_breakout: 'trend_up' }, lastRegimeLabel: 'trend_up',
  });

  const result = resetKillSwitch(db, 'paper');

  assert.equal(result.dailyPnl, -10);
  assert.deepEqual(result.openPositions, [{ coin: 'BTC', entryPrice: 100 }]);
  assert.deepEqual(result.cooldowns, { ETH: 123 });
  assert.deepEqual(result.disabledSetups, { trend_breakout: 'trend_up' });
  assert.equal(result.lastRegimeLabel, 'trend_up');
});

test('resetKillSwitch throws when the mode has no scheduler state yet', () => {
  const db = openDb(':memory:');
  assert.throws(() => resetKillSwitch(db, 'paper'), /no scheduler state for mode paper/);
});

test('insertCycleLog/getCycleLog round-trips and orders by ts descending', () => {
  const db = openDb(':memory:');
  insertCycleLog(db, { ts: 100, mode: 'paper', regimeLabel: 'range', candidatesCount: 2, openedCount: 1, closedCount: 0, durationMs: 50 });
  insertCycleLog(db, { ts: 200, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 0, openedCount: 0, closedCount: 1, durationMs: 40 });

  const rows = getCycleLog(db, 'paper', 10);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.ts), [200, 100]);
  assert.equal(rows[0].regime_label, 'trend_up');
  assert.equal(rows[0].error, null);
});
