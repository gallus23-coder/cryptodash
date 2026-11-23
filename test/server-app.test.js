'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, insertCandidate, insertDecision, insertCycleLog, insertTrade, updateCandidateShadow: updateCandidateShadowForTest, upsertCandles, saveSchedulerState, loadSchedulerState } = require('../src/data/db');
const { createApp } = require('../src/server/app');

function seedCandidate(db, overrides = {}) {
  insertCandidate(db, {
    id: 'c_20261118_10_SOL_trend_pullback', ts: 1700000000, mode: 'paper', coin: 'SOL', setup: 'trend_pullback', regime: 'trend_up',
    entry: 98.40, atr: 3.10,
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
    context: { rsi14: 47.2, adx4h: 26.1 },
    ...overrides,
  });
}

function seedDecision(db, overrides = {}) {
  insertDecision(db, {
    candidateId: 'c_20261118_10_SOL_trend_pullback', ts: 1700000000, mode: 'paper', action: 'take',
    size: 1.0, stopAtr: 1.5, trailAtr: 2.5, reason: 'r', plainReason: 'p',
    defaultAction: 'take', diverged: false, model: 'claude-sonnet-5', latencyMs: 1200, rawResponse: '{}',
    ...overrides,
  });
}

function startTestServer(password) {
  const db = openDb(':memory:');
  const app = createApp(db, { password });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port, db }));
  });
}

test('a request with the correct password header succeeds', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('a request with no password header is rejected with 401', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('a request with the wrong password header is rejected with 401, same as no header', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Dashboard-Password': 'wrong' } });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('with no password configured, every request is allowed through', async () => {
  const { server, port } = await startTestServer(undefined);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('GET /api/decisions returns decisions for the default mode (paper), joined with coin/setup/regime', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db);
    seedDecision(db);
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].coin, 'SOL');
    assert.equal(body[0].setup, 'trend_pullback');
    assert.equal(body[0].regime, 'trend_up');
    assert.equal(body[0].action, 'take');
  } finally {
    server.close();
  }
});

test('GET /api/decisions does not mix modes when mode is unspecified (defaults to paper)', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { id: 'c_live_1' });
    seedDecision(db, { candidateId: 'c_live_1', mode: 'live' });
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.length, 0); // the 'live' decision must not appear under the implicit paper default
  } finally {
    server.close();
  }
});

test('GET /api/decisions?diverged=true filters to the stored diverged column', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { id: 'c_a' });
    seedCandidate(db, { id: 'c_b' });
    seedDecision(db, { candidateId: 'c_a', diverged: false });
    seedDecision(db, { candidateId: 'c_b', diverged: true });
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions?diverged=true`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].candidateId, 'c_b');
  } finally {
    server.close();
  }
});

test('GET /api/decisions?coin=&setup= filters correctly', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { id: 'c_sol', coin: 'SOL' });
    seedCandidate(db, { id: 'c_btc', coin: 'BTC' });
    seedDecision(db, { candidateId: 'c_sol' });
    seedDecision(db, { candidateId: 'c_btc' });
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions?coin=BTC`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].coin, 'BTC');
  } finally {
    server.close();
  }
});

test('GET /api/decisions/:cycleId returns the cycle_log row plus its candidates, decisions, and linked trades', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1700000000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 500 });
    seedCandidate(db);
    seedDecision(db);
    insertTrade(db, {
      mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: 1700000000, exitTs: 1700050000,
      entryPrice: 98.40, exitPrice: 102.0, units: 1, riskAmount: 5, pnl: 3.6, r: 0.72, exitReason: 'target',
      candidateId: 'c_20261118_10_SOL_trend_pullback',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/decisions/1700000000`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cycle.regimeLabel, 'trend_up');
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].decision.action, 'take');
    assert.equal(body.candidates[0].trade.r, 0.72);
  } finally {
    server.close();
  }
});

test('GET /api/decisions/:cycleId for a cycle with zero candidates returns an empty array, not an error', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1700003600, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 200 });
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions/1700003600`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cycle.regimeLabel, 'risk_off');
    assert.deepEqual(body.candidates, []);
  } finally {
    server.close();
  }
});

test('GET /api/decisions/:cycleId for a ts with no cycle_log row at all returns 404', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/decisions/9999999999`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /api/scorecard reports notEnoughData when fewer than 100 diverged decisions exist', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const recentTs = Math.floor(Date.now() / 1000) - 3600; // must fall within the scorecard's real days=30 window
    seedCandidate(db, { ts: recentTs });
    seedDecision(db, { diverged: true, ts: recentTs });
    updateCandidateShadowForTest(db, 'c_20261118_10_SOL_trend_pullback', { status: 'resolved', exitTs: recentTs + 50000, pnl: 5, r: 1.0, exitReason: 'target' });

    const res = await fetch(`http://127.0.0.1:${port}/api/scorecard?days=30`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.notEnoughData, true);
    assert.equal(body.divergedCount, 1);
  } finally {
    server.close();
  }
});

test('GET /api/scorecard does not double-count a candidate whose candidate_id has both a paper and a live decision', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const recentTs = Math.floor(Date.now() / 1000) - 3600;
    seedCandidate(db, { ts: recentTs }); // mode: paper
    // Both diverged:true — if the join isn't mode-scoped, this single candidate's shadow_r joins
    // against BOTH decision rows, producing divergedCount=2 for what is really one paper decision.
    seedDecision(db, { diverged: true, action: 'take', ts: recentTs });
    seedDecision(db, { diverged: true, action: 'take', ts: recentTs, mode: 'live' });
    updateCandidateShadowForTest(db, 'c_20261118_10_SOL_trend_pullback', { status: 'resolved', exitTs: recentTs + 50000, pnl: 5, r: 1.0, exitReason: 'target' });

    const res = await fetch(`http://127.0.0.1:${port}/api/scorecard?days=30&mode=paper`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.divergedCount, 1); // only the paper decision counts, not both
  } finally {
    server.close();
  }
});

test('GET /api/decisions/:cycleId with mode=paper does not return a live decision for the same candidate_id', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1700000000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 500 });
    seedCandidate(db);
    // Insert the LIVE decision FIRST: an unfiltered `.get()` with no ORDER BY returns rows in
    // insertion (rowid) order by default in SQLite, so this ordering is what makes an unfixed
    // (mode-unaware) query return the live row — asserting on row order alone would be fragile,
    // but combined with a mode filter this is deterministic either way.
    seedDecision(db, { action: 'take', mode: 'live' });
    seedDecision(db, { action: 'skip' }); // the real paper decision, inserted second

    const res = await fetch(`http://127.0.0.1:${port}/api/decisions/1700000000?mode=paper`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.candidates[0].decision.mode, 'paper');
    assert.equal(body.candidates[0].decision.action, 'skip'); // must not pick up the live "take"
  } finally {
    server.close();
  }
});

test('GET /api/scorecard compares real R (for a taken, diverged decision) against the shadow R', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const recentTs = Math.floor(Date.now() / 1000) - 3600; // must fall within the scorecard's real days=30 window
    seedCandidate(db, { ts: recentTs });
    seedDecision(db, { diverged: true, action: 'take', ts: recentTs });
    updateCandidateShadowForTest(db, 'c_20261118_10_SOL_trend_pullback', { status: 'resolved', exitTs: recentTs + 50000, pnl: 5, r: 1.0, exitReason: 'target' });
    insertTrade(db, {
      mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: recentTs, exitTs: recentTs + 50000,
      entryPrice: 98.40, exitPrice: 102.0, units: 0.5, riskAmount: 2.5, pnl: 1.8, r: 0.72, exitReason: 'target',
      candidateId: 'c_20261118_10_SOL_trend_pullback',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/scorecard?days=30`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.claudeMeanR, 0.72); // the real trade's R (Claude resized to 0.5x, taken)
    assert.equal(body.defaultMeanR, 1.0); // the shadow's R (what the untouched default would have made)
  } finally {
    server.close();
  }
});

test('GET /api/cycles returns cycle_log rows with a plain-English one-liner', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1700000000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });
    const res = await fetch(`http://127.0.0.1:${port}/api/cycles`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.ok(body[0].oneLiner);
  } finally {
    server.close();
  }
});

test('GET /api/cycles?coin=X only returns cycles with a candidate for that coin', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    seedCandidate(db, { id: 'c_sol', ts: 1000, coin: 'SOL' });
    seedCandidate(db, { id: 'c_eth', ts: 2000, coin: 'ETH' });

    const res = await fetch(`http://127.0.0.1:${port}/api/cycles?coin=SOL`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.deepEqual(body.map((r) => r.ts), [1000]);
  } finally {
    server.close();
  }
});

test('GET /api/cycles?setup=X only returns cycles with a candidate for that setup', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    seedCandidate(db, { id: 'c1', ts: 1000, setup: 'trend_pullback' });
    seedCandidate(db, { id: 'c2', ts: 2000, setup: 'range_reversion' });

    const res = await fetch(`http://127.0.0.1:${port}/api/cycles?setup=range_reversion`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.deepEqual(body.map((r) => r.ts), [2000]);
  } finally {
    server.close();
  }
});

test('GET /api/cycles?action=X only returns cycles with a decision of that action', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    seedCandidate(db, { id: 'c1', ts: 1000 });
    seedCandidate(db, { id: 'c2', ts: 2000 });
    seedDecision(db, { candidateId: 'c1', ts: 1000, action: 'take' });
    seedDecision(db, { candidateId: 'c2', ts: 2000, action: 'skip' });

    const res = await fetch(`http://127.0.0.1:${port}/api/cycles?action=skip`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.deepEqual(body.map((r) => r.ts), [2000]);
  } finally {
    server.close();
  }
});

test('GET /api/cycles?diverged=true only returns cycles with an overridden decision', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    seedCandidate(db, { id: 'c1', ts: 1000 });
    seedCandidate(db, { id: 'c2', ts: 2000 });
    seedDecision(db, { candidateId: 'c1', ts: 1000, diverged: true });
    seedDecision(db, { candidateId: 'c2', ts: 2000, diverged: false });

    const res = await fetch(`http://127.0.0.1:${port}/api/cycles?diverged=true`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.deepEqual(body.map((r) => r.ts), [1000]);
  } finally {
    server.close();
  }
});

test('GET /api/cycles combines coin/setup/action filters with AND, not OR', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 0, closedCount: 0, durationMs: 10 });
    seedCandidate(db, { id: 'c1', ts: 1000, coin: 'SOL', setup: 'trend_pullback' });
    seedCandidate(db, { id: 'c2', ts: 2000, coin: 'SOL', setup: 'range_reversion' });

    const res = await fetch(`http://127.0.0.1:${port}/api/cycles?coin=SOL&setup=range_reversion`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.deepEqual(body.map((r) => r.ts), [2000]);
  } finally {
    server.close();
  }
});

test('GET /api/candles/:coin returns candles for the requested timeframe and range', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    upsertCandles(db, [
      { coin: 'BTC', timeframe: '1h', ts: 1000, open: 100, high: 101, low: 99, close: 100.5, volume: 10, trades: 5 },
      { coin: 'BTC', timeframe: '1h', ts: 2000, open: 100.5, high: 102, low: 100, close: 101, volume: 12, trades: 6 },
      { coin: 'BTC', timeframe: '4h', ts: 1000, open: 100, high: 102, low: 99, close: 101, volume: 22, trades: 11 },
    ]);
    const res = await fetch(`http://127.0.0.1:${port}/api/candles/BTC?tf=1h&from=0&to=9999`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.equal(body[0].close, 100.5);
  } finally {
    server.close();
  }
});

test('GET /api/candles/:coin rejects an unsupported timeframe with 400', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/candles/BTC?tf=5m&from=0&to=9999`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/candles/:coin defaults to from=0 and a wide "to" when not given', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    upsertCandles(db, [{ coin: 'ETH', timeframe: '1h', ts: 5000, open: 1, high: 2, low: 1, close: 1.5, volume: 1, trades: 1 }]);
    const res = await fetch(`http://127.0.0.1:${port}/api/candles/ETH?tf=1h`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
  } finally {
    server.close();
  }
});

test('GET /api/markers/:coin returns trades and candidates for that coin, scoped to mode', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { coin: 'SOL', ts: 1700000000 });
    insertTrade(db, {
      mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: 1700000000, exitTs: 1700050000,
      entryPrice: 98.40, exitPrice: 102.0, units: 1, riskAmount: 5, pnl: 3.6, r: 0.72, exitReason: 'target',
      candidateId: 'c_20261118_10_SOL_trend_pullback',
    });
    insertTrade(db, {
      mode: 'live', coin: 'SOL', setup: 'trend_pullback', entryTs: 1700000000, exitTs: 1700050000,
      entryPrice: 98.40, exitPrice: 95.0, units: 1, riskAmount: 5, pnl: -3.4, r: -0.68, exitReason: 'stop',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/markers/SOL`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trades.length, 1);
    assert.equal(body.trades[0].r, 0.72);
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].coin, 'SOL');
  } finally {
    server.close();
  }
});

test('GET /api/markers/:coin attaches each candidate\'s decision, so the UI can distinguish take/skip/fallback', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    seedCandidate(db, { coin: 'SOL', ts: 1700000000 });
    seedDecision(db, { action: 'take', model: 'claude-sonnet-5' });

    const res = await fetch(`http://127.0.0.1:${port}/api/markers/SOL`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.candidates.length, 1);
    assert.ok(body.candidates[0].decision, 'candidate is missing its decision field');
    assert.equal(body.candidates[0].decision.action, 'take');
    assert.equal(body.candidates[0].decision.model, 'claude-sonnet-5');
  } finally {
    server.close();
  }
});

test('GET /api/markers/:coin for a coin with no activity returns empty arrays, not an error', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/markers/ADA`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { trades: [], candidates: [] });
  } finally {
    server.close();
  }
});

test('GET /api/regime/history returns one row per cycle_log entry, including risk_off', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'risk_off', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 100 });
    insertCycleLog(db, { ts: 2000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 100 });

    const res = await fetch(`http://127.0.0.1:${port}/api/regime/history`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.equal(body[0].label, 'risk_off');
    assert.equal(body[1].label, 'trend_up');
  } finally {
    server.close();
  }
});

test('GET /api/regime/current returns null label when there is not enough candle history yet', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/regime/current`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.label, null);
  } finally {
    server.close();
  }
});

test('GET /api/indicators/:coin returns EMA/Bollinger/RSI/ADX aligned to the candle timestamps', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const rows = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push({ coin: 'BTC', timeframe: '4h', ts: i * 14400, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1, trades: 1 });
    }
    upsertCandles(db, rows);

    const res = await fetch(`http://127.0.0.1:${port}/api/indicators/BTC?tf=4h&from=0&to=999999`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ts.length, 30);
    assert.equal(body.ema20.length, 30);
    assert.equal(body.ema20[0], null); // warmup
    assert.ok(body.ema20[29] !== null); // enough bars by the end
    assert.equal(body.rsi14.length, 30);
    assert.equal(body.adx14.length, 30);
    assert.equal(body.bollingerUpper.length, 30);
  } finally {
    server.close();
  }
});

test('GET /api/indicators/:coin rejects an unsupported timeframe with 400', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/indicators/BTC?tf=5m`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/positions returns the openPositions array from scheduler_state for the given mode', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    saveSchedulerState(db, 'paper', {
      balance: 1000, dailyPnl: 0, currentDay: null, weeklyPeakBalance: 1000, killSwitchActive: false,
      openPositions: [{ coin: 'BTC', setup: 'trend_pullback', entryPrice: 61000, initialStopPrice: 59000, atrAtEntry: 800, trailAtr: 2.5, exitType: 'trailing_stop', entryTs: 1700000000 }],
      cooldowns: {}, closedTrades: [], shadowPositions: [], disabledSetups: {}, lastRegimeLabel: 'trend_up',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/positions`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].coin, 'BTC');
    assert.equal(body[0].initialStopPrice, 59000);
  } finally {
    server.close();
  }
});

test('GET /api/positions returns an empty array when no scheduler_state has been saved yet', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/positions`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    server.close();
  }
});

test('POST /api/guardrails/reset-kill-switch clears an active kill switch', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    saveSchedulerState(db, 'paper', {
      balance: 920, dailyPnl: 0, currentDay: 10, weeklyPeakBalance: 1000, killSwitchActive: true,
      openPositions: [], cooldowns: {}, closedTrades: [], shadowPositions: [], disabledSetups: {}, lastRegimeLabel: 'trend_up',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/guardrails/reset-kill-switch?mode=paper`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(loadSchedulerState(db, 'paper').killSwitchActive, false);
  } finally {
    server.close();
  }
});

test('POST /api/guardrails/reset-kill-switch returns 404 when the mode has no scheduler state', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/guardrails/reset-kill-switch?mode=paper`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' },
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /api/go-live-checklist reports trades60 as not passing with zero trades', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/go-live-checklist`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trades60.count, 0);
    assert.equal(body.trades60.pass, false);
    assert.equal(body.scorecard.pass, null); // not enough data yet
    assert.equal(body.reconcileTested.pass, null);
    assert.equal(body.killSwitchTested.pass, true);
    assert.equal(body.dailyLossLimitTested.pass, true);
    assert.equal(body.krakenKeyNoWithdraw.pass, null);
  } finally {
    server.close();
  }
});

test('GET /api/go-live-checklist reports trades60 passing once 60+ trades exist with positive expectancy', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    for (let i = 0; i < 60; i += 1) {
      insertTrade(db, {
        mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: i, exitTs: i + 100,
        entryPrice: 100, exitPrice: 101, units: 1, riskAmount: 1, pnl: 1, r: 0.5, exitReason: 'target',
        candidateId: `c_test_${i}`,
      });
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/go-live-checklist`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.trades60.count, 60);
    assert.equal(body.trades60.expectancy, 0.5);
    assert.equal(body.trades60.pass, true);
  } finally {
    server.close();
  }
});

test('GET /api/benchmarks returns null stats when the mode has no cycle_log history yet', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/benchmarks`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.startTs, null);
    assert.equal(body.bot, null);
  } finally {
    server.close();
  }
});

test('GET /api/benchmarks returns the bot vs BTC vs cash comparison once there is history', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    insertCycleLog(db, { ts: 1000, mode: 'paper', regimeLabel: 'range', candidatesCount: 0, openedCount: 0, closedCount: 0, durationMs: 10 });
    saveSchedulerState(db, 'paper', { balance: 1010 });
    insertTrade(db, {
      mode: 'paper', coin: 'BTC', setup: 'trend_pullback', entryTs: 1000, exitTs: 2000,
      entryPrice: 100, exitPrice: 105, units: 1, riskAmount: 10, pnl: 10, r: 1, exitReason: 'target', candidateId: 'c1',
    });
    upsertCandles(db, [
      { coin: 'BTC', timeframe: '1d', ts: 1000, open: 60000, high: 61000, low: 59000, close: 60000, volume: 1, trades: null },
      { coin: 'BTC', timeframe: '1d', ts: 1000 + 86400, open: 60000, high: 63000, low: 59500, close: 66000, volume: 1, trades: null },
    ]);

    const res = await fetch(`http://127.0.0.1:${port}/api/benchmarks`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.startTs, 1000);
    assert.equal(body.bot.returnPct, 0.01); // (1010-1000)/1000
    assert.equal(body.btc.returnPct, 0.1); // (66000-60000)/60000
    assert.deepEqual(body.cash, { returnPct: 0, worstDrawdownPct: 0, ratio: null });
  } finally {
    server.close();
  }
});

test('GET /api/status reports claudeCallsToday and pausedByOperator (false, no state saved yet)', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pausedByOperator, false);
    assert.equal(body.claudeCallsToday, 0);
  } finally {
    server.close();
  }
});

test('GET /api/status reports pausedByOperator true once paused', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    saveSchedulerState(db, 'paper', { balance: 1000, pausedByOperator: true });
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.pausedByOperator, true);
  } finally {
    server.close();
  }
});

test('POST /api/control/pause sets pausedByOperator to true', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    saveSchedulerState(db, 'paper', { balance: 1000, pausedByOperator: false });
    const res = await fetch(`http://127.0.0.1:${port}/api/control/pause?mode=paper`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    assert.equal(loadSchedulerState(db, 'paper').pausedByOperator, true);
  } finally {
    server.close();
  }
});

test('POST /api/control/resume sets pausedByOperator back to false', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    saveSchedulerState(db, 'paper', { balance: 1000, pausedByOperator: true });
    const res = await fetch(`http://127.0.0.1:${port}/api/control/resume?mode=paper`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    assert.equal(loadSchedulerState(db, 'paper').pausedByOperator, false);
  } finally {
    server.close();
  }
});

test('POST /api/control/pause returns 404 when the mode has no scheduler state', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/control/pause?mode=paper`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /api/claude-usage reports today, this month, and fallbacks', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const nowTs = Math.floor(Date.now() / 1000);
    insertDecision(db, { candidateId: 'c_1', ts: nowTs, mode: 'paper', action: 'take', size: 1, stopAtr: 1.5, trailAtr: 2.5, reason: 'r', plainReason: 'p', defaultAction: 'take', diverged: false, model: 'claude-sonnet-5', latencyMs: 100, rawResponse: '{}' });
    insertDecision(db, { candidateId: 'c_2', ts: nowTs, mode: 'paper', action: 'skip', size: null, stopAtr: null, trailAtr: null, reason: 'r', plainReason: 'p', defaultAction: 'take', diverged: false, model: 'fallback', latencyMs: 0, rawResponse: '{}' });

    const res = await fetch(`http://127.0.0.1:${port}/api/claude-usage`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'claude-cli (Pro plan)');
    assert.equal(body.cyclesToday, 24);
    assert.equal(body.callsToday, 1);
    assert.equal(body.callsThisMonth, 1);
    assert.equal(body.fallbacksThisMonth, 1);
  } finally {
    server.close();
  }
});

test('GET /api/regime/current includes the metrics behind the label, not just the label', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const rows = [];
    for (let i = 0; i < 250; i += 1) {
      rows.push({ coin: 'BTC', timeframe: '1d', ts: i * 86400, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1, trades: 1 });
      rows.push({ coin: 'BTC', timeframe: '4h', ts: i * 86400, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1, trades: 1 });
    }
    upsertCandles(db, rows);

    const res = await fetch(`http://127.0.0.1:${port}/api/regime/current`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    if (body.label !== null) {
      assert.ok(body.metrics, 'expected a metrics object once a label is computed');
      assert.ok(typeof body.metrics === 'object');
    }
  } finally {
    server.close();
  }
});

test('GET /api/strategy returns per-setup stats, computed with computeExpectancy, zeroed for a setup with no trades', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.setups.length, 4); // the four real setups
    const pullback = body.setups.find((s) => s.name === 'trend_pullback');
    assert.ok(pullback.ranges); // ranges came from the real playbook module
    assert.equal(pullback.stats30d.count, 0);
    assert.equal(pullback.stats30d.expectancy, 0);
  } finally {
    server.close();
  }
});

test('GET /api/strategy reports real win rate/expectancy for a setup with real trades', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const recentTs = Math.floor(Date.now() / 1000) - 3600;
    insertTrade(db, {
      mode: 'paper', coin: 'SOL', setup: 'trend_pullback', entryTs: recentTs, exitTs: recentTs + 100,
      entryPrice: 100, exitPrice: 110, units: 1, riskAmount: 5, pnl: 5, r: 1.0, exitReason: 'target',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    const pullback = body.setups.find((s) => s.name === 'trend_pullback');
    assert.equal(pullback.stats30d.count, 1);
    assert.equal(pullback.stats30d.winRate, 1);
  } finally {
    server.close();
  }
});

test('GET /api/strategy computes guardrail usage with the same formulas runCycle uses, with no state defaulting to zeroed guardrails', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.guardrails.killSwitchActive, false);
    assert.equal(body.guardrails.openPositions.used, 0);
    assert.equal(body.guardrails.openPositions.max, 3);
    assert.equal(body.guardrails.dailyLossPct.max, 0.03);
  } finally {
    server.close();
  }
});

test('GET /api/strategy includes the latest market note when one exists, null otherwise', async () => {
  const { server, port, db } = await startTestServer('sekrit');
  try {
    const noNoteRes = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal((await noNoteRes.json()).marketNote, null);

    insertCycleLog(db, {
      ts: 1700000000, mode: 'paper', regimeLabel: 'trend_up', candidatesCount: 1, openedCount: 1, closedCount: 0, durationMs: 100,
      marketNote: 'Taking the pullback.', plainNote: { mood: 'positive', bullets: [], botAction: 'x' },
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/strategy`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.marketNote.marketNote, 'Taking the pullback.');
  } finally {
    server.close();
  }
});

test('POST /api/config/draft validates and echoes back a well-formed draft', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/draft`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ riskLevel: 'cautious', disabledSetups: ['trend_breakout'], rangeOverrides: {} }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.riskLevel, 'cautious');
    assert.deepEqual(body.disabledSetups, ['trend_breakout']);
  } finally {
    server.close();
  }
});

test('POST /api/config/draft rejects an unknown setup name in disabledSetups with 400', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/draft`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ riskLevel: 'normal', disabledSetups: ['not_a_real_setup'], rangeOverrides: {} }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /api/config/draft/backtest returns a well-shaped summary even against an empty database', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/draft/backtest`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ riskLevel: 'normal', disabledSetups: ['trend_pullback'], rangeOverrides: {} }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.backtestSummary.totalTrades, 0); // no candles seeded — no history to trade on
    assert.deepEqual(body.backtestSummary.bySetup, {});
    assert.match(body.note, /range/i);
  } finally {
    server.close();
  }
});

test('POST /api/config/draft/submit creates a pending version, superseding any existing one', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const firstRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/submit`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {} }, backtestSummary: { totalTrades: 0 } }),
    });
    const firstBody = await firstRes.json();

    const secondRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/submit`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { riskLevel: 'normal', disabledSetups: ['trend_breakout'], rangeOverrides: {} }, backtestSummary: { totalTrades: 5 } }),
    });
    const secondBody = await secondRes.json();

    const pendingRes = await fetch(`http://127.0.0.1:${port}/api/config/pending`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const pendingBody = await pendingRes.json();
    assert.equal(pendingBody.pending.id, secondBody.id);
    assert.notEqual(firstBody.id, secondBody.id);
  } finally {
    server.close();
  }
});

test('GET /api/config/pending returns a synthetic default active version when nothing has ever been approved', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/pending`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await res.json();
    assert.equal(body.active.id, null);
    assert.equal(body.active.config.riskLevel, 'normal');
    assert.equal(body.pending, null);
  } finally {
    server.close();
  }
});

test('POST /api/config/:id/approve promotes a pending version to active', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const submitRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/submit`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {} }, backtestSummary: {} }),
    });
    const { id } = await submitRes.json();

    const approveRes = await fetch(`http://127.0.0.1:${port}/api/config/${id}/approve`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(approveRes.status, 200);

    const pendingRes = await fetch(`http://127.0.0.1:${port}/api/config/pending`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    const body = await pendingRes.json();
    assert.equal(body.active.id, id);
    assert.equal(body.pending, null);
  } finally {
    server.close();
  }
});

test('POST /api/config/:id/approve on an already-decided version returns 409', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const submitRes = await fetch(`http://127.0.0.1:${port}/api/config/draft/submit`, {
      method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {} }, backtestSummary: {} }),
    });
    const { id } = await submitRes.json();
    await fetch(`http://127.0.0.1:${port}/api/config/${id}/approve`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });

    const secondApprove = await fetch(`http://127.0.0.1:${port}/api/config/${id}/approve`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(secondApprove.status, 409);
  } finally {
    server.close();
  }
});

test('POST /api/config/:id/reject on a nonexistent id returns 404', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/999999/reject`, { method: 'POST', headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
