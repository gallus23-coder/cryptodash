'use strict';

function evaluate(coin, candles4h, indicators, i, regimeLabel) {
  if (regimeLabel !== 'trend_up') return null;

  const ema20 = indicators.ema20[i];
  const ema50 = indicators.ema50[i];
  const rsi = indicators.rsi14[i];
  if (ema20 === null || ema50 === null || rsi === null) return null;

  const bar = candles4h[i];
  const touchedEma = bar.low <= ema20 || bar.low <= ema50;
  const heldAboveLower = bar.close > Math.min(ema20, ema50);
  const rsiInBand = rsi >= 40 && rsi <= 55;
  if (!touchedEma || !heldAboveLower || !rsiInBand) return null;

  return {
    coin,
    setup: 'trend_pullback',
    regime: regimeLabel,
    entry: bar.close,
    atr: indicators.atr14[i],
    default: { action: 'take', size: 1.0, stopAtr: 1.5, trailAtr: 2.5 },
    exitType: 'trailing_stop',
  };
}

module.exports = { evaluate };
