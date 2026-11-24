'use strict';
const { computeExpectancy } = require('../backtest/stats');

function canActivate(trades) {
  return computeExpectancy(trades).pass;
}

function isFailingAutoOffThreshold(trades) {
  const last30 = trades.slice(-30);
  if (last30.length < 30) return false;
  return computeExpectancy(last30).expectancy < -0.2;
}

function applyLifecycleFilter(setupsByRegime, lifecycleStatuses) {
  return Object.fromEntries(
    Object.entries(setupsByRegime).map(([regime, names]) => [regime, names.filter((n) => lifecycleStatuses[n] !== 'auto_off')])
  );
}

module.exports = { canActivate, isFailingAutoOffThreshold, applyLifecycleFilter };
