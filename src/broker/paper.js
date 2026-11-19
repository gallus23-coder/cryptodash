'use strict';

const DEFAULT_FEES = { makerPct: 0.0025, takerPct: 0.0040 };
const DEFAULT_SLIPPAGE_PCT = 0.0005;

function fillEntry({ candidate, sizing, fees = DEFAULT_FEES, slippagePct = DEFAULT_SLIPPAGE_PCT }) {
  const fillPrice = candidate.entry * (1 + slippagePct);
  const feeAmount = sizing.stakeValue * fees.makerPct;
  return { fillPrice, feeAmount };
}

function fillExit({ exitPrice, stakeValue, fees = DEFAULT_FEES, slippagePct = DEFAULT_SLIPPAGE_PCT }) {
  const fillPrice = exitPrice * (1 - slippagePct);
  const feeAmount = stakeValue * fees.takerPct;
  return { fillPrice, feeAmount };
}

function evaluateExit(position, { candles1h, ema20By4hTs }) {
  let highestHigh = position.entryPrice;

  for (const candle of candles1h) {
    if (position.exitType === 'trailing_stop') {
      highestHigh = Math.max(highestHigh, candle.high);
    }
    const currentStopPrice = position.exitType === 'trailing_stop'
      ? Math.max(position.initialStopPrice, highestHigh - position.trailAtr * position.atrAtEntry)
      : position.initialStopPrice;

    if (candle.low <= currentStopPrice) {
      return { exitTs: candle.ts, exitPrice: currentStopPrice, reason: 'stop' };
    }
  }

  return null;
}

module.exports = { fillEntry, fillExit, evaluateExit, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT };
