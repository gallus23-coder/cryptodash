'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, insertCandidate, insertDecision, insertCycleLog, insertTrade } = require('../src/data/db');
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
