'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sizePosition, checkFeeViability } = require('../src/engine/risk');

test('sizePosition risks exactly riskPct of balance, sized by stop distance', () => {
  // balance=10000, risk 0.5% = 50. entry=100, stop=98 (2% stop distance = 2 per unit).
  // units = riskAmount / stopDistancePerUnit = 50 / 2 = 25. stakeValue = 25*100 = 2500.
  const result = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 98 });

  assert.equal(result.riskAmount, 50);
  assert.equal(result.units, 25);
  assert.equal(result.stakeValue, 2500);
});

test('sizePosition scales down for a wider stop (more distance, fewer units for the same risk)', () => {
  const tight = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 98 });
  const wide = sizePosition({ balance: 10000, riskPct: 0.005, entryPrice: 100, stopPrice: 90 });

  assert.ok(wide.units < tight.units, `expected a wider stop to produce fewer units: ${wide.units} vs ${tight.units}`);
  assert.equal(wide.riskAmount, tight.riskAmount); // same £ risked either way
});

test('checkFeeViability passes when ATR% is at least 4x the round-trip fee', () => {
  assert.equal(checkFeeViability({ atrPct: 2.6, roundTripFeePct: 0.65 }), true); // 2.6 = 4*0.65 exactly
  assert.equal(checkFeeViability({ atrPct: 3, roundTripFeePct: 0.65 }), true);
});

test('checkFeeViability fails when ATR% is below 4x the round-trip fee', () => {
  assert.equal(checkFeeViability({ atrPct: 2, roundTripFeePct: 0.65 }), false);
});

const { checkGuardrails } = require('../src/engine/risk');

const CONFIG = {
  maxOpenPositions: 3, maxTotalRiskPct: 0.015, maxCoinExposurePct: 0.20,
  maxTotalExposurePct: 0.60, cooldownHours: 6,
};

function emptyState() {
  return { openPositions: [], cooldowns: {} };
}

test('allows a candidate when every guardrail has headroom', () => {
  const result = checkGuardrails(emptyState(), { coin: 'BTC', riskPct: 0.005, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.deepEqual(result, { allowed: true, reason: null });
});

test('blocks when max open positions is already reached', () => {
  const state = { openPositions: [
    { coin: 'BTC', riskPct: 0.005, exposurePct: 0.1 },
    { coin: 'ETH', riskPct: 0.005, exposurePct: 0.1 },
    { coin: 'SOL', riskPct: 0.005, exposurePct: 0.1 },
  ], cooldowns: {} };
  const result = checkGuardrails(state, { coin: 'XRP', riskPct: 0.005, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'max_open_positions');
});

test('blocks when adding the candidate would exceed total open risk', () => {
  const state = { openPositions: [{ coin: 'BTC', riskPct: 0.012, exposurePct: 0.1 }], cooldowns: {} };
  const result = checkGuardrails(state, { coin: 'ETH', riskPct: 0.005, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'total_open_risk');
});

test('blocks when adding the candidate would exceed per-coin exposure', () => {
  const state = { openPositions: [{ coin: 'BTC', riskPct: 0.002, exposurePct: 0.15 }], cooldowns: {} };
  const result = checkGuardrails(state, { coin: 'BTC', riskPct: 0.002, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'coin_exposure');
});

test('blocks when adding the candidate would exceed total exposure', () => {
  const state = { openPositions: [
    { coin: 'BTC', riskPct: 0.002, exposurePct: 0.3 },
    { coin: 'ETH', riskPct: 0.002, exposurePct: 0.25 },
  ], cooldowns: {} };
  const result = checkGuardrails(state, { coin: 'SOL', riskPct: 0.002, exposurePct: 0.1, ts: 1000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'total_exposure');
});

test('blocks a coin still inside its post-stop cooldown window', () => {
  const state = { openPositions: [], cooldowns: { BTC: 5000 } };
  const result = checkGuardrails(state, { coin: 'BTC', riskPct: 0.005, exposurePct: 0.1, ts: 4000 }, CONFIG);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'cooldown');
});

test('allows the same coin again once its cooldown has elapsed', () => {
  const state = { openPositions: [], cooldowns: { BTC: 5000 } };
  const result = checkGuardrails(state, { coin: 'BTC', riskPct: 0.005, exposurePct: 0.1, ts: 5001 }, CONFIG);
  assert.equal(result.allowed, true);
});

const { isDailyLossLimitHit, isKillSwitchTriggered, shouldEvaluateCandidates, rollDailyPnl } = require('../src/engine/risk');

const LOSS_CONFIG = { dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08 };

test('isDailyLossLimitHit is false while losses are under the limit', () => {
  assert.equal(isDailyLossLimitHit(-0.02, LOSS_CONFIG), false);
});

test('isDailyLossLimitHit is true once losses reach or exceed the limit', () => {
  assert.equal(isDailyLossLimitHit(-0.03, LOSS_CONFIG), true);
  assert.equal(isDailyLossLimitHit(-0.05, LOSS_CONFIG), true);
});

test('isDailyLossLimitHit is false on a profitable day', () => {
  assert.equal(isDailyLossLimitHit(0.02, LOSS_CONFIG), false);
});

test('isKillSwitchTriggered is false while weekly drawdown is under 8%', () => {
  assert.equal(isKillSwitchTriggered(0.05, LOSS_CONFIG), false);
});

test('isKillSwitchTriggered is true once weekly drawdown reaches or exceeds 8%', () => {
  assert.equal(isKillSwitchTriggered(0.08, LOSS_CONFIG), true);
  assert.equal(isKillSwitchTriggered(0.12, LOSS_CONFIG), true);
});

function makeGateState(overrides = {}) {
  return { killSwitchActive: false, pausedByOperator: false, ...overrides };
}

test('shouldEvaluateCandidates is true when every gate is clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', true, makeGateState(), false), true);
});

test('shouldEvaluateCandidates is false when the kill switch is active, even with everything else clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', true, makeGateState({ killSwitchActive: true }), false), false);
});

test('shouldEvaluateCandidates is false when the daily loss limit is hit, even with everything else clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', true, makeGateState(), true), false);
});

test('shouldEvaluateCandidates is false during risk_off regardless of the kill switch or daily loss state', () => {
  assert.equal(shouldEvaluateCandidates('risk_off', true, makeGateState(), false), false);
  assert.equal(shouldEvaluateCandidates('risk_off', true, makeGateState({ killSwitchActive: true }), true), false);
});

test('shouldEvaluateCandidates is false when regimeLabel is not yet known (null)', () => {
  assert.equal(shouldEvaluateCandidates(null, true, makeGateState(), false), false);
});

test('shouldEvaluateCandidates is false off the 4h boundary even with every gate clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', false, makeGateState(), false), false);
});

test('shouldEvaluateCandidates is false when the operator has manually paused trading, even with everything else clear', () => {
  assert.equal(shouldEvaluateCandidates('trend_up', true, makeGateState({ pausedByOperator: true }), false), false);
});

test('rollDailyPnl resets dailyPnl to 0 and adopts the new dayKey when the day has changed', () => {
  const state = { currentDay: 5, dailyPnl: -30 };
  assert.deepEqual(rollDailyPnl(state, 6), { currentDay: 6, dailyPnl: 0 });
});

test('rollDailyPnl leaves dailyPnl and currentDay unchanged within the same day', () => {
  const state = { currentDay: 5, dailyPnl: -12 };
  assert.deepEqual(rollDailyPnl(state, 5), { currentDay: 5, dailyPnl: -12 });
});

test('rollDailyPnl genuinely clears a tripped daily loss limit at the day boundary — the design\'s "resets at midnight UTC" claim, proven against isDailyLossLimitHit', () => {
  const config = { dailyLossLimitPct: 0.03 };
  const balanceAtDayStart = 1000;
  const state = { currentDay: 5, dailyPnl: -40 }; // -4%, over the 3% limit
  assert.equal(isDailyLossLimitHit(state.dailyPnl / balanceAtDayStart, config), true);

  const rolled = rollDailyPnl(state, 6);
  assert.equal(isDailyLossLimitHit(rolled.dailyPnl / balanceAtDayStart, config), false);
});

test('rollDailyPnl never touches killSwitchActive — a day rollover must not silently clear a kill switch trip', () => {
  const state = { currentDay: 5, dailyPnl: -40, killSwitchActive: true };
  const rolled = rollDailyPnl(state, 6);
  assert.equal('killSwitchActive' in rolled, false); // caller Object.assign()s onto state, so an absent key here means killSwitchActive survives untouched
});
