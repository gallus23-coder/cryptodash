'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDecisionPrompt } = require('../src/engine/decide');

function sampleInput() {
  return {
    regime: 'trend_up',
    regimeMetrics: { adx4h: 26.1, btcAbove200d: true },
    candidates: [{
      id: 'c_20261118_10_SOL_trend_pullback', coin: 'SOL', setup: 'trend_pullback', regime: 'trend_up',
      entry: 98.40, atr: 3.10, default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
      ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] }, context: { rsi14: 47.2, adx4h: 26.1 },
    }],
    openPositions: [{ coin: 'BTC', setup: 'trend_breakout', entryPrice: 61000, unrealizedPnlPct: 2.1 }],
    recentTrades: [{ coin: 'ETH', setup: 'range_reversion', r: 0.8, exitReason: 'target' }],
    setupConfig: { trend_breakout: 'active', trend_pullback: 'active', range_reversion: 'active', oversold_bounce: 'active' },
    guardrailHeadroom: { openPositionsRemaining: 2, totalRiskPctRemaining: 0.01 },
  };
}

test('buildDecisionPrompt returns a system string and a JSON-stringified user payload', () => {
  const { system, user } = buildDecisionPrompt(sampleInput());
  assert.equal(typeof system, 'string');
  assert.ok(system.length > 0);
  const parsed = JSON.parse(user); // must be valid JSON
  assert.equal(parsed.regime, 'trend_up');
});

test('the user payload includes every candidate id and its ranges, so Claude knows what it may propose', () => {
  const { user } = buildDecisionPrompt(sampleInput());
  const parsed = JSON.parse(user);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].id, 'c_20261118_10_SOL_trend_pullback');
  assert.deepEqual(parsed.candidates[0].ranges, { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] });
});

test('the user payload includes open positions and recent trades for context', () => {
  const { user } = buildDecisionPrompt(sampleInput());
  const parsed = JSON.parse(user);
  assert.equal(parsed.openPositions.length, 1);
  assert.equal(parsed.recentTrades.length, 1);
});

test('an empty candidates list still produces a valid prompt (position-management-only cycle)', () => {
  const input = { ...sampleInput(), candidates: [] };
  const { user } = buildDecisionPrompt(input);
  assert.deepEqual(JSON.parse(user).candidates, []);
});
