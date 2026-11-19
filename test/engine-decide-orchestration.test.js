'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/engine/decide');

function sampleInput() {
  return {
    regime: 'trend_up', regimeMetrics: {}, openPositions: [], recentTrades: [], setupConfig: {}, guardrailHeadroom: {},
    candidates: [{
      id: 'c_20261118_10_SOL_trend_pullback', coin: 'SOL', setup: 'trend_pullback',
      default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
      ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
    }],
    setupNames: ['trend_pullback'],
  };
}

test('decide() returns a valid decision set when the CLI call succeeds with well-formed JSON', async () => {
  const fakeDeps = { callClaudeCli: async () => JSON.stringify({
    decisions: [{ candidateId: 'c_20261118_10_SOL_trend_pullback', action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5, reason: 'r', plainReason: 'p' }],
    positionActions: [], setupToggles: [], marketNote: 'note', plainNote: null,
  }) };

  const result = await decide(sampleInput(), {}, fakeDeps);
  assert.equal(result.fallback, false);
  assert.equal(result.decisions.length, 1);
});

test('decide() falls back to skip-all when the CLI call rejects (timeout, auth failure, etc)', async () => {
  const fakeDeps = { callClaudeCli: async () => { throw new Error('claude cli failed: timeout'); } };

  const result = await decide(sampleInput(), {}, fakeDeps);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.decisions, []);
  assert.match(result.error, /timeout/);
});

test('decide() falls back to skip-all when the CLI returns unparseable text', async () => {
  const fakeDeps = { callClaudeCli: async () => 'not json' };

  const result = await decide(sampleInput(), {}, fakeDeps);
  assert.equal(result.fallback, true);
});
