'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDecisionResponse } = require('../src/engine/decide');

function sampleCandidates() {
  return [{
    id: 'c_20261118_10_SOL_trend_pullback', coin: 'SOL', setup: 'trend_pullback',
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    ranges: { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [1.5, 4.0] },
  }];
}

test('a well-formed response with in-range values passes through unchanged', () => {
  const raw = JSON.stringify({
    decisions: [{ candidateId: 'c_20261118_10_SOL_trend_pullback', action: 'take', size: 0.5, stopAtr: 2.0, trailAtr: 2.5, reason: 'r', plainReason: 'p' }],
    positionActions: [], setupToggles: [], marketNote: 'note', plainNote: { mood: 'ok', bullets: [], botAction: 'x' },
  });
  const result = parseDecisionResponse(raw, { candidates: sampleCandidates(), openPositions: [], setupNames: ['trend_pullback'] });
  assert.equal(result.fallback, false);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].size, 0.5);
  assert.equal(result.decisions[0].stopAtr, 2.0);
});

test('an out-of-range stopAtr is clamped into range, not rejected', () => {
  const raw = JSON.stringify({
    decisions: [{ candidateId: 'c_20261118_10_SOL_trend_pullback', action: 'take', size: 0.5, stopAtr: 10.0, trailAtr: 2.5, reason: 'r', plainReason: 'p' }],
    positionActions: [], setupToggles: [], marketNote: '', plainNote: null,
  });
  const result = parseDecisionResponse(raw, { candidates: sampleCandidates(), openPositions: [], setupNames: ['trend_pullback'] });
  assert.equal(result.fallback, false);
  assert.equal(result.decisions[0].stopAtr, 3.0); // clamped to the range's max, not dropped
});

test('a decision referencing an unknown candidateId is dropped, the rest of the response still processed', () => {
  const raw = JSON.stringify({
    decisions: [
      { candidateId: 'c_does_not_exist', action: 'take', size: 1.0, stopAtr: 2.0, trailAtr: 2.5, reason: 'r', plainReason: 'p' },
      { candidateId: 'c_20261118_10_SOL_trend_pullback', action: 'skip', reason: 'r', plainReason: 'p' },
    ],
    positionActions: [], setupToggles: [], marketNote: '', plainNote: null,
  });
  const result = parseDecisionResponse(raw, { candidates: sampleCandidates(), openPositions: [], setupNames: ['trend_pullback'] });
  assert.equal(result.fallback, false);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].candidateId, 'c_20261118_10_SOL_trend_pullback');
});

test('a positionAction proposing a looser stop than the position currently has is dropped', () => {
  const raw = JSON.stringify({
    decisions: [], setupToggles: [], marketNote: '', plainNote: null,
    positionActions: [{ coin: 'BTC', setup: 'trend_breakout', action: 'tighten_stop', newStopPrice: 55000 }],
  });
  const result = parseDecisionResponse(raw, {
    candidates: [], openPositions: [{ coin: 'BTC', setup: 'trend_breakout', currentStopPrice: 58000 }], setupNames: [],
  });
  assert.equal(result.positionActions.length, 0); // 55000 < 58000 is looser (for a long), dropped
});

test('a positionAction proposing a tighter stop is kept', () => {
  const raw = JSON.stringify({
    decisions: [], setupToggles: [], marketNote: '', plainNote: null,
    positionActions: [{ coin: 'BTC', setup: 'trend_breakout', action: 'tighten_stop', newStopPrice: 59000 }],
  });
  const result = parseDecisionResponse(raw, {
    candidates: [], openPositions: [{ coin: 'BTC', setup: 'trend_breakout', currentStopPrice: 58000 }], setupNames: [],
  });
  assert.equal(result.positionActions.length, 1);
  assert.equal(result.positionActions[0].newStopPrice, 59000);
});

test('a positionAction with action "close" is always kept regardless of stop comparison', () => {
  const raw = JSON.stringify({
    decisions: [], setupToggles: [], marketNote: '', plainNote: null,
    positionActions: [{ coin: 'BTC', setup: 'trend_breakout', action: 'close' }],
  });
  const result = parseDecisionResponse(raw, {
    candidates: [], openPositions: [{ coin: 'BTC', setup: 'trend_breakout', currentStopPrice: 58000 }], setupNames: [],
  });
  assert.equal(result.positionActions.length, 1);
  assert.equal(result.positionActions[0].action, 'close');
});

test('a setupToggles entry naming an unknown setup is dropped', () => {
  const raw = JSON.stringify({
    decisions: [], positionActions: [], marketNote: '', plainNote: null,
    setupToggles: [{ setup: 'not_a_real_setup', action: 'disable_setup' }],
  });
  const result = parseDecisionResponse(raw, { candidates: [], openPositions: [], setupNames: ['trend_pullback'] });
  assert.equal(result.setupToggles.length, 0);
});

test('invalid JSON falls back to skip-all for the whole cycle', () => {
  const result = parseDecisionResponse('not json at all', { candidates: sampleCandidates(), openPositions: [], setupNames: [] });
  assert.equal(result.fallback, true);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.positionActions, []);
});

test('valid JSON but wrong top-level shape (decisions not an array) falls back to skip-all', () => {
  const raw = JSON.stringify({ decisions: 'take everything', positionActions: [], setupToggles: [] });
  const result = parseDecisionResponse(raw, { candidates: sampleCandidates(), openPositions: [], setupNames: [] });
  assert.equal(result.fallback, true);
  assert.deepEqual(result.decisions, []);
});
