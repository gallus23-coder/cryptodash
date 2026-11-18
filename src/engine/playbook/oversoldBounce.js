'use strict';

const THREE_DAY_BARS = 18; // 3 days of 4h bars

function evaluate(coin, candles4h, indicators, i, regimeLabel) {
  if (regimeLabel !== 'downtrend') return null;
  if (i < THREE_DAY_BARS) return null;

  const rsi = indicators.rsi2[i];
  if (rsi === null) return null;

  const bar = candles4h[i];
  const threeDayFall = bar.close < candles4h[i - THREE_DAY_BARS].close;
  const rsiOversold = rsi < 5;
  if (!threeDayFall || !rsiOversold) return null;

  return {
    coin,
    setup: 'oversold_bounce',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 0.5, stopAtr: 1.0 },
    exitType: 'ema_cross_or_time',
    emaPeriod: 20,
    timeStopHours: 12,
  };
}

module.exports = { evaluate };
