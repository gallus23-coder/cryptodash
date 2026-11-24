'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFourHourBoundary, utcDayKey, freshState, persistCycleResults, selectBroker, runCycle } = require('../src/scheduler/cycle');
const { openDb, upsertCandles, getCandidatesByTs, loadSchedulerState, getTrades } = require('../src/data/db');
const { DEFAULT_RISK_CONFIG, COINS } = require('../src/engine/config');

test('isFourHourBoundary is true exactly at 00/04/08/12/16/20 UTC', () => {
  const HOUR = 3600;
  assert.equal(isFourHourBoundary(0), true);
  assert.equal(isFourHourBoundary(4 * HOUR), true);
  assert.equal(isFourHourBoundary(20 * HOUR), true);
  assert.equal(isFourHourBoundary(24 * HOUR), true); // next day's 00:00
});

test('isFourHourBoundary is false at any other hour', () => {
  const HOUR = 3600;
  assert.equal(isFourHourBoundary(1 * HOUR), false);
  assert.equal(isFourHourBoundary(14 * HOUR), false);
});

test('utcDayKey groups all timestamps within the same UTC day', () => {
  const DAY = 86400;
  assert.equal(utcDayKey(0), 0);
  assert.equal(utcDayKey(DAY - 1), 0);
  assert.equal(utcDayKey(DAY), 1);
});

test('freshState defaults to a £1000 starting balance with no open positions', () => {
  const state = freshState();
  assert.equal(state.balance, 1000);
  assert.equal(state.weeklyPeakBalance, 1000);
  assert.deepEqual(state.openPositions, []);
  assert.deepEqual(state.cooldowns, {});
  assert.equal(state.killSwitchActive, false);
  assert.equal(state.pausedByOperator, false);
});

test('freshState accepts a custom starting balance', () => {
  assert.equal(freshState(500).balance, 500);
});

test('persistCycleResults rolls back all trade inserts if a later one fails, so trades and scheduler_state stay consistent', () => {
  const db = openDb(':memory:');
  const state = freshState();
  state.closedTrades = [
    { coin: 'BTC', setup: 'trend_pullback', entryTs: 0, exitTs: 3600, entryPrice: 100, exitPrice: 110, units: 1, riskAmount: 5, pnl: 10, r: 2, exitReason: 'target' },
    { setup: 'trend_pullback', entryTs: 3600, exitTs: 7200, entryPrice: 100, exitPrice: 90, units: 1, riskAmount: 5, pnl: -10, r: -2, exitReason: 'stop' }, // missing `coin` — throws on insert
  ];

  assert.throws(() => persistCycleResults(db, 'paper', state));

  assert.equal(getTrades(db, 'paper').length, 0); // first trade's insert must not survive the second's failure
  assert.equal(loadSchedulerState(db, 'paper'), null); // state must never be saved if the drain didn't fully commit
});

test('selectBroker returns the real live broker module for mode "live" and the real paper broker module for mode "paper"', () => {
  const liveBroker = require('../src/broker/live');
  const paperBroker = require('../src/broker/paper');
  assert.equal(selectBroker('live'), liveBroker);
  assert.equal(selectBroker('paper'), paperBroker);
});

test('selectBroker honors injected overrides, for testability', () => {
  const fakeLive = { marker: 'fake-live' };
  const fakePaper = { marker: 'fake-paper' };
  assert.equal(selectBroker('live', { liveBroker: fakeLive, paperBroker: fakePaper }), fakeLive);
  assert.equal(selectBroker('paper', { liveBroker: fakeLive, paperBroker: fakePaper }), fakePaper);
});

// --- runCycle at a real 4h boundary -----------------------------------------------------
//
// Regression for a bug where candles4h.findIndex((c) => c.ts === nowHour) always returned -1:
// candles are keyed by bucket START and only stored once closed, so the bar that just closed
// at a 4h boundary lives at ts === nowHour - FOUR_H, never ts === nowHour. No setup was ever
// evaluated live/paper. These helpers build a long, continuous BTC-style uptrend (needed for
// computeRegimeSeries to emit 'trend_up' at all — it needs ~220 days of daily history for
// EMA200 + slope) that pulls back into trendPullback's trigger zone on the final 4h bar.
const HOUR = 3600, FOUR_H = 4 * HOUR, DAY = 24 * HOUR;
const DAYS = 230; // 200 for daily EMA200 + 20 for its slope + margin, same convention as engine-regime.test.js
const BAR_COUNT = DAYS * 6; // total 4h bars across the whole fixture
const REBUILD_DAYS = 14; // matches ingestCoin's REBUILD_WINDOW_SECONDS
const OLD_DAYS = DAYS - REBUILD_DAYS;
const BASE_RANGE = 5.2; // generous enough that the pullback's ATR clears checkFeeViability's threshold
const PULLBACK_WICK = 3.12;
const PULLBACK_LEN = 8, PULLBACK_AMP = 3, PULLBACK_BOUNCE = 2;

// A gentle, steady uptrend that dips for the last PULLBACK_LEN bars and bounces on the very
// last one — real EMA20/EMA50/RSI(14), run over these closes, land the final bar inside
// trendPullback's trigger zone (touches EMA, closes back above it, RSI in 40-55).
function closeAtBar(i) {
  const base = 100 + i * 0.04;
  if (i >= BAR_COUNT - PULLBACK_LEN && i < BAR_COUNT - 1) {
    const k = i - (BAR_COUNT - PULLBACK_LEN) + 1;
    return base - PULLBACK_AMP * (k / PULLBACK_LEN);
  }
  if (i === BAR_COUNT - 1) return base - PULLBACK_AMP + PULLBACK_BOUNCE;
  return base;
}

function bucketOhlcAtBar(i) {
  const close = closeAtBar(i);
  const high = close + BASE_RANGE / 2;
  // Only the final (closing) bar wicks deep enough to touch EMA20/50 — a real pullback touch,
  // not just a generically wide bar throughout the whole series.
  const low = i === BAR_COUNT - 1 ? close - PULLBACK_WICK : close - BASE_RANGE / 2;
  return { open: close, high, low, close };
}

// Builds a scheduler-cycle.test.js-local fixture: 4h/1d candles pre-seeded directly for the
// "already accumulated" history outside ingestCoin's 14-day rebuild window (regime computation
// needs ~220 days of it, but a single cycle's ingest never rebuilds that far back), plus the
// raw hourly OHLC a fake Kraken client hands to ingestAllCoins for the rebuild window — which is
// where this bug lived, so that part goes through the real ingestion/aggregation pipeline.
function seedTrendUpWithPullback(db) {
  for (const coin of COINS) {
    const rows4h = [];
    for (let i = 0; i < OLD_DAYS * 6; i += 1) {
      const { open, high, low, close } = bucketOhlcAtBar(i);
      rows4h.push({ coin, timeframe: '4h', ts: i * FOUR_H, open, high, low, close, volume: 1, trades: 1 });
    }
    upsertCandles(db, rows4h);

    const rows1d = [];
    for (let d = 0; d < OLD_DAYS; d += 1) {
      const close = closeAtBar(d * 6 + 5);
      rows1d.push({ coin, timeframe: '1d', ts: d * DAY, open: close, high: close, low: close, close, volume: 1, trades: 1 });
    }
    upsertCandles(db, rows1d);
  }

  // One hour per 4h bucket carries the bucket's real open/high/low/close; the other three sit
  // flat at the bucket's close — aggregateCandles (src/data/candles.js) reproduces the bucket
  // exactly: open = first child's open, close = last child's close, high/low = min/max.
  const hourlyCandles = [];
  for (let i = OLD_DAYS * 6; i < BAR_COUNT; i += 1) {
    const { open, high, low, close } = bucketOhlcAtBar(i);
    const bucketStart = i * FOUR_H;
    hourlyCandles.push({ time: bucketStart, open, high, low, close, volume: 1, count: 1, closed: true });
    for (let h = 1; h < 4; h += 1) {
      hourlyCandles.push({ time: bucketStart + h * HOUR, open: close, high: close, low: close, close, volume: 1, count: 1, closed: true });
    }
  }

  return {
    getOhlc: async () => ({ candles: hourlyCandles, last: hourlyCandles[hourlyCandles.length - 1].time }),
  };
}

function takeAllTrendPullbackCandidates(input) {
  return {
    decisions: input.candidates.filter((c) => c.setup === 'trend_pullback').map((c) => ({
      candidateId: c.id, action: 'take', size: c.default.size, stopAtr: c.default.stopAtr, trailAtr: c.default.trailAtr,
      reason: 'test', plainReason: 'test',
    })),
    positionActions: [], setupToggles: [], marketNote: '', plainNote: null, fallback: false,
  };
}

test('runCycle at a 4h boundary evaluates the bar that just closed, inserts a candidate, and opens a paper position', async () => {
  const db = openDb(':memory:');
  const fakeKrakenClient = seedTrendUpWithPullback(db);
  const now = BAR_COUNT * FOUR_H * 1000; // ms; lands exactly on a 4h boundary
  const nowHour = BAR_COUNT * FOUR_H;
  const closedBarTs = nowHour - FOUR_H; // the bar that just closed — the bug looked for nowHour instead

  const result = await runCycle(db, fakeKrakenClient, 'paper', DEFAULT_RISK_CONFIG, now, { decide: takeAllTrendPullbackCandidates });

  assert.equal(result.regimeLabel, 'trend_up');
  assert.ok(result.candidatesCount > 0, 'expected at least one candidate — this is exactly what the bug prevented');

  const candidates = getCandidatesByTs(db, 'paper', nowHour);
  const btcCandidate = candidates.find((c) => c.coin === 'BTC' && c.setup === 'trend_pullback');
  assert.ok(btcCandidate, 'expected a trend_pullback candidate for BTC');
  assert.equal(btcCandidate.entry, closeAtBar(BAR_COUNT - 1), "candidate's entry price must come from the bar that just closed");

  const state = loadSchedulerState(db, 'paper');
  assert.ok(state.openPositions.length > 0, 'expected a paper position to have opened — this is exactly what the bug prevented');
  const btcPosition = state.openPositions.find((p) => p.coin === 'BTC');
  assert.ok(btcPosition, 'expected the paper position to be the BTC trend_pullback candidate');
  assert.equal(btcPosition.entryTs, closedBarTs, "position's entryTs must be the bar that just closed, not nowHour");

  const btcShadow = state.shadowPositions.find((p) => p.candidateId === btcCandidate.id);
  assert.ok(btcShadow, 'expected a shadow position tracking the same candidate');
  assert.equal(btcShadow.entryPrice, btcPosition.entryPrice, "shadow position must reference the same bar's fill as the real position");
});

test('runCycle applies rangeOverrides to the candidate ranges Claude sees, for the matching setup', async () => {
  const db = openDb(':memory:');
  const fakeKrakenClient = seedTrendUpWithPullback(db);
  const now = BAR_COUNT * FOUR_H * 1000;
  const config = {
    ...DEFAULT_RISK_CONFIG,
  };
  // Insert an active config version with a rangeOverride on trend_pullback's stopAtr before the cycle runs.
  const { insertConfigVersion, approveConfigVersion } = require('../src/data/db');
  const id = insertConfigVersion(db, {
    mode: 'paper',
    configJson: { riskLevel: 'normal', disabledSetups: [], rangeOverrides: { trend_pullback: { stopAtr: [2.0, 2.0] } } },
    backtestJson: null,
  });
  approveConfigVersion(db, 'paper', id);

  let seenRanges = null;
  const captureDecide = async (input) => {
    const candidate = input.candidates.find((c) => c.setup === 'trend_pullback' && c.coin === 'BTC');
    if (candidate) seenRanges = candidate.ranges;
    return takeAllTrendPullbackCandidates(input);
  };

  await runCycle(db, fakeKrakenClient, 'paper', config, now, { decide: captureDecide });

  assert.ok(seenRanges, 'expected a trend_pullback candidate for BTC to reach decide()');
  assert.deepEqual(seenRanges.stopAtr, [2.0, 2.0]);
});
