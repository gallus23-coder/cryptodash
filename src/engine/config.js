'use strict';

const DEFAULT_RISK_CONFIG = {
  baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
  maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6,
  dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08,
  roundTripFeePct: 0.65, // percent, matches checkFeeViability's expected units
  claudeModel: 'claude-sonnet-5', claudeEffort: 'low', claudeTimeoutMs: 30000,
  liveOrderPollMs: 10000, liveOrderTimeoutMs: 15 * 60 * 1000, liveMarketOrderTimeoutMs: 60000,
};

const COIN_ALTNAMES = { BTC: 'XBTGBP', ETH: 'ETHGBP', SOL: 'SOLGBP', XRP: 'XRPGBP', ADA: 'ADAGBP', LINK: 'LINKGBP' };
const COINS = Object.keys(COIN_ALTNAMES);

function applyRiskLevel(baseConfig, riskLevel) {
  if (!['cautious', 'normal', 'bold'].includes(riskLevel)) {
    throw new Error(`unrecognized risk level: ${riskLevel}`);
  }
  if (riskLevel === 'cautious') {
    return {
      ...baseConfig,
      baseRiskPct: baseConfig.baseRiskPct * 0.5,
      maxOpenPositions: Math.max(1, baseConfig.maxOpenPositions - 1),
    };
  }
  // 'normal' and 'bold' are currently identical — see the config-versioning plan's Interpretation
  // decisions for why 'bold' doesn't yet scale up: DEFAULT_RISK_CONFIG's values are the enforced
  // guardrail ceiling in this codebase, not a baseline sitting below a separate, larger cap —
  // scaling past them means picking new risk numbers nobody has validated, a decision for a human.
  return { ...baseConfig };
}

function resolveEffectiveConfig(baseConfig, activeVersionConfig, baseSetupsByRegime) {
  const config = applyRiskLevel(baseConfig, activeVersionConfig.riskLevel);
  const setupsByRegime = Object.fromEntries(
    Object.entries(baseSetupsByRegime).map(([regime, names]) => [
      regime, names.filter((n) => !activeVersionConfig.disabledSetups.includes(n)),
    ])
  );
  return { config, setupsByRegime };
}

module.exports = { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS, applyRiskLevel, resolveEffectiveConfig };
