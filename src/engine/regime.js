'use strict';

function labelRegime(metrics) {
  const { btcAboveEma200, ema200SlopeFalling, adx, breadthPct, volatilityRankPct, btc24hChangePct } = metrics;

  let label;
  if (volatilityRankPct > 90 || btc24hChangePct <= -6) {
    label = 'risk_off';
  } else if (btcAboveEma200 && adx > 22 && breadthPct >= 60) {
    label = 'trend_up';
  } else if (!btcAboveEma200 && ema200SlopeFalling) {
    label = 'downtrend';
  } else {
    label = 'range';
  }

  return { label, metrics };
}

module.exports = { labelRegime };
