'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitTradesByWindow, summarizeWindow, buildWalkForwardReport } = require('../src/backtest/compare');

test('splitTradesByWindow splits by entryTs relative to the boundary, boundary itself goes to later', () => {
  const trades = [{ entryTs: 100 }, { entryTs: 200 }, { entryTs: 300 }];
  const { earlier, later } = splitTradesByWindow(trades, 200);
  assert.deepEqual(earlier.map((t) => t.entryTs), [100]);
  assert.deepEqual(later.map((t) => t.entryTs), [200, 300]);
});

test('summarizeWindow flags tooFewToJudge under 30 trades and does not treat it as a fail', () => {
  const trades = Array.from({ length: 10 }, () => ({ r: 0.5 }));
  const result = summarizeWindow(trades, [100, 101, 102]);
  assert.equal(result.tooFewToJudge, true);
  assert.equal(result.trades, 10);
  assert.ok(result.expectancy > 0); // still computed and shown, just labeled, not hidden
});

test('summarizeWindow with 30+ trades is not flagged too-few', () => {
  const trades = Array.from({ length: 30 }, () => ({ r: 0.1 }));
  const result = summarizeWindow(trades, [100, 110]);
  assert.equal(result.tooFewToJudge, false);
});

const { openDb, upsertCandles, saveSchedulerState, loadSchedulerState } = require('../src/data/db');
const { freshState } = require('../src/scheduler/cycle');
const { DEFAULT_RISK_CONFIG, COINS } = require('../src/engine/config');
const { SETUPS_BY_REGIME } = require('../src/engine/playbook');
const { resolveSetupParams } = require('../src/engine/setupParams');

test('buildWalkForwardReport returns active and draft, each split into earlier/later, over the same window, without touching the real scheduler_state row', () => {
  const db = openDb(':memory:');
  const DAY = 86400, FOUR_H = 4 * 3600;
  const DAYS = 95;
  for (const coin of COINS) {
    const rows4h = Array.from({ length: DAYS * 6 }, (_, i) => {
      const close = 100 + Math.sin(i / 10);
      return { coin, timeframe: '4h', ts: i * FOUR_H, open: close, high: close + 1, low: close - 1, close, volume: 1, trades: 1 };
    });
    upsertCandles(db, rows4h);
    const rows1d = Array.from({ length: DAYS }, (_, d) => {
      const close = 100 + Math.sin((d * 6) / 10);
      return { coin, timeframe: '1d', ts: d * DAY, open: close, high: close, low: close, close, volume: 1, trades: 1 };
    });
    upsertCandles(db, rows1d);
  }

  saveSchedulerState(db, 'paper', freshState());
  const before = loadSchedulerState(db, 'paper');

  const setupParams = resolveSetupParams();
  const report = buildWalkForwardReport(db, {
    activeConfig: DEFAULT_RISK_CONFIG, activeSetupsByRegime: SETUPS_BY_REGIME, activeSetupParams: setupParams,
    draftConfig: DEFAULT_RISK_CONFIG, draftSetupsByRegime: SETUPS_BY_REGIME, draftSetupParams: setupParams,
    fromTs: 0, boundaryTs: 60 * DAY, toTs: 90 * DAY,
  });

  assert.ok(report.active.earlier);
  assert.ok(report.active.later);
  assert.ok(report.draft.earlier);
  assert.ok(report.draft.later);
  assert.equal(typeof report.active.earlier.tooFewToJudge, 'boolean');
  assert.deepEqual(loadSchedulerState(db, 'paper'), before);
});
