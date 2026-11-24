'use strict';

const { DEFAULT_SETUP_PARAMS } = require('../setupParams');

const RANGES = { size: [0, 0.5], stopAtr: [0.5, 2.0] };

function evaluate(coin, candles4h, indicators, i, regimeLabel, params = DEFAULT_SETUP_PARAMS.oversold_bounce) {
  if (regimeLabel !== 'downtrend') return null;
  if (i < params.lookbackBars) return null;

  const rsi = indicators.rsi2[i];
  if (rsi === null) return null;

  const bar = candles4h[i];
  const threeDayFall = bar.close < candles4h[i - params.lookbackBars].close;
  const rsiOversold = rsi < params.rsi2Max;
  if (!threeDayFall || !rsiOversold) return null;

  return {
    coin,
    setup: 'oversold_bounce',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 0.5, stopAtr: params.defaultStopAtr },
    ranges: RANGES,
    exitType: 'ema_cross_or_time',
    emaPeriod: 20,
    timeStopHours: params.timeStopHours,
  };
}

module.exports = { evaluate, RANGES };
