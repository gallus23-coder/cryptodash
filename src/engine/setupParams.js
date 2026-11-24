'use strict';

const DEFAULT_SETUP_PARAMS = {
  trend_pullback: { rsiMin: 40, rsiMax: 55, defaultStopAtr: 1.5, defaultTrailAtr: 2.5 },
  trend_breakout: { lookback: 20, defaultStopAtr: 2.0, defaultTrailAtr: 3.0 },
  range_reversion: { rsi2Max: 10, defaultStopAtr: 1.5, timeStopHours: 24 },
  oversold_bounce: { rsi2Max: 5, lookbackBars: 18, defaultStopAtr: 1.0, timeStopHours: 12 },
};

const SETUP_PARAM_BOUNDS = {
  trend_pullback: { rsiMin: [20, 50], rsiMax: [50, 80], defaultStopAtr: [1.0, 3.0], defaultTrailAtr: [1.5, 4.0] },
  trend_breakout: { lookback: [10, 50], defaultStopAtr: [1.0, 3.0], defaultTrailAtr: [2.0, 4.0] },
  range_reversion: { rsi2Max: [5, 20], defaultStopAtr: [1.0, 2.5], timeStopHours: [6, 48] },
  oversold_bounce: { rsi2Max: [2, 15], lookbackBars: [6, 36], defaultStopAtr: [0.5, 2.0], timeStopHours: [6, 24] },
};

function clamp(value, [min, max]) {
  return Math.min(Math.max(value, min), max);
}

function clampSetupParams(setupName, params) {
  const merged = { ...DEFAULT_SETUP_PARAMS[setupName], ...params };
  const bounds = SETUP_PARAM_BOUNDS[setupName];
  const clamped = Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [key, clamp(value, bounds[key])])
  );
  if (setupName === 'trend_pullback' && clamped.rsiMin >= clamped.rsiMax) {
    clamped.rsiMax = clamp(clamped.rsiMin + 1, bounds.rsiMax);
  }
  return clamped;
}

function resolveSetupParams(setupParamsOverride = {}) {
  return Object.fromEntries(
    Object.keys(DEFAULT_SETUP_PARAMS).map((name) => [name, clampSetupParams(name, setupParamsOverride[name] || {})])
  );
}

module.exports = { DEFAULT_SETUP_PARAMS, SETUP_PARAM_BOUNDS, clampSetupParams, resolveSetupParams };
