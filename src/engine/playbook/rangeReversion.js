'use strict';

function evaluate(coin, candles4h, indicators, i, regimeLabel) {
  if (regimeLabel !== 'range') return null;

  const lowerBand = indicators.bollinger20.lower[i];
  const rsi = indicators.rsi2[i];
  const dailyEma200 = indicators.dailyEma200Aligned[i];
  if (lowerBand === null || rsi === null || dailyEma200 === null) return null;

  const bar = candles4h[i];
  const belowLowerBand = bar.close < lowerBand;
  const rsiOversold = rsi < 10;
  const aboveDailyTrend = bar.close > dailyEma200;
  if (!belowLowerBand || !rsiOversold || !aboveDailyTrend) return null;

  return {
    coin,
    setup: 'range_reversion',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 1.0, stopAtr: 1.5 },
    exitType: 'target_or_time',
    targetType: 'bollinger_middle',
    timeStopHours: 24,
  };
}

module.exports = { evaluate };
