'use strict';

const DEFAULT_RISK_CONFIG = {
  baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
  maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6,
  dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08,
  roundTripFeePct: 0.65, // percent, matches checkFeeViability's expected units
  claudeModel: 'claude-sonnet-5', claudeEffort: 'low', claudeTimeoutMs: 30000,
};

const COIN_ALTNAMES = { BTC: 'XBTGBP', ETH: 'ETHGBP', SOL: 'SOLGBP', XRP: 'XRPGBP', ADA: 'ADAGBP', LINK: 'LINKGBP' };
const COINS = Object.keys(COIN_ALTNAMES);

module.exports = { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS };
