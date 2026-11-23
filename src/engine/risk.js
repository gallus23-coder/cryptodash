'use strict';

function sizePosition({ balance, riskPct, entryPrice, stopPrice }) {
  const riskAmount = balance * riskPct;
  const stopDistancePerUnit = Math.abs(entryPrice - stopPrice);
  const units = riskAmount / stopDistancePerUnit;
  const stakeValue = units * entryPrice;
  return { units, stakeValue, riskAmount };
}

function checkFeeViability({ atrPct, roundTripFeePct, minMultiple = 4 }) {
  return atrPct >= minMultiple * roundTripFeePct;
}

function checkGuardrails(state, candidate, config) {
  if (state.openPositions.length >= config.maxOpenPositions) {
    return { allowed: false, reason: 'max_open_positions' };
  }

  const totalRisk = state.openPositions.reduce((sum, p) => sum + p.riskPct, 0) + candidate.riskPct;
  if (totalRisk > config.maxTotalRiskPct) {
    return { allowed: false, reason: 'total_open_risk' };
  }

  const coinExposure = state.openPositions
    .filter((p) => p.coin === candidate.coin)
    .reduce((sum, p) => sum + p.exposurePct, 0) + candidate.exposurePct;
  if (coinExposure > config.maxCoinExposurePct) {
    return { allowed: false, reason: 'coin_exposure' };
  }

  const totalExposure = state.openPositions.reduce((sum, p) => sum + p.exposurePct, 0) + candidate.exposurePct;
  if (totalExposure > config.maxTotalExposurePct) {
    return { allowed: false, reason: 'total_exposure' };
  }

  const cooldownUntil = state.cooldowns[candidate.coin];
  if (cooldownUntil !== undefined && candidate.ts < cooldownUntil) {
    return { allowed: false, reason: 'cooldown' };
  }

  return { allowed: true, reason: null };
}

function isDailyLossLimitHit(dailyPnlPct, config) {
  return dailyPnlPct <= -config.dailyLossLimitPct;
}

function isKillSwitchTriggered(weeklyDrawdownPct, config) {
  return weeklyDrawdownPct >= config.weeklyKillSwitchPct;
}

function shouldEvaluateCandidates(regimeLabel, isBoundary, state, dailyLossHit) {
  return Boolean(regimeLabel) && isBoundary && !state.killSwitchActive && !state.pausedByOperator
    && !dailyLossHit && regimeLabel !== 'risk_off';
}

function rollDailyPnl(state, dayKey) {
  if (state.currentDay !== dayKey) {
    return { currentDay: dayKey, dailyPnl: 0 };
  }
  return { currentDay: state.currentDay, dailyPnl: state.dailyPnl };
}

module.exports = {
  sizePosition, checkFeeViability, checkGuardrails,
  isDailyLossLimitHit, isKillSwitchTriggered, shouldEvaluateCandidates, rollDailyPnl,
};
