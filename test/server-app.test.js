'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, insertCandidate, insertDecision, insertCycleLog, insertTrade, updateCandidateShadow: updateCandidateShadowForTest, upsertCandles } = require('../src/data/db');
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
