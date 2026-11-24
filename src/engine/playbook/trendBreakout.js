'use strict';

const { DEFAULT_SETUP_PARAMS } = require('../setupParams');

const RANGES = { size: [0, 1], stopAtr: [1.0, 3.0], trailAtr: [2.0, 4.0] };

function evaluate(coin, candles4h, indicators, i, regimeLabel, params = DEFAULT_SETUP_PARAMS.trend_breakout) {
  if (regimeLabel !== 'trend_up') return null;
  if (i === 0) return null; // needs a prior bar's Donchian value

  const priorUpper = indicators.donchianBreakout.upper[i - 1];
  const adxNow = indicators.adx14.adx[i];
  const adxPrev = indicators.adx14.adx[i - 1];
  if (priorUpper === null || adxNow === null || adxPrev === null) return null;

  const bar = candles4h[i];
  const brokeOut = bar.close > priorUpper;
  const adxRising = adxNow > adxPrev;
  if (!brokeOut || !adxRising) return null;

  return {
    coin,
    setup: 'trend_breakout',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 1.0, stopAtr: params.defaultStopAtr, trailAtr: params.defaultTrailAtr },
    ranges: RANGES,
    exitType: 'trailing_stop',
  };
}

module.exports = { evaluate, RANGES };
