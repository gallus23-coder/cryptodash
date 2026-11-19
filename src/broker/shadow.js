'use strict';
const { fillEntry, fillExit, evaluateExit } = require('./paper');

const NOMINAL_RISK_AMOUNT = 10; // arbitrary and unit-independent: R = pnl/riskAmount scales out regardless of this choice

function openShadowPosition(candidate, data, i) {
  const stopPrice = candidate.entry - candidate.default.stopAtr * candidate.atr;
  const stopDistance = candidate.entry - stopPrice;
  const units = NOMINAL_RISK_AMOUNT / stopDistance;
  const sizing = { stakeValue: units * candidate.entry, units, riskAmount: NOMINAL_RISK_AMOUNT };
  const fill = fillEntry({ candidate, sizing });
  // Mirrors tryOpenPosition (paper.js) exactly: real playbook candidates carry targetType/timeStopHours,
  // not a precomputed targetPrice/timeStopTs — those need the bollinger-middle value and the bar's ts,
  // which only the caller's `data`/`i` (same args tryOpenPosition takes) can supply.
  const barTs = data && i !== undefined ? data.candles4h[i].ts : undefined;

  return {
    candidateId: candidate.id, coin: candidate.coin, setup: candidate.setup,
    entryPrice: fill.fillPrice, units: sizing.units, riskAmount: sizing.riskAmount,
    initialStopPrice: stopPrice, atrAtEntry: candidate.atr,
    exitType: candidate.exitType, trailAtr: candidate.default.trailAtr,
    targetPrice: candidate.exitType === 'target_or_time' ? data.indicators.bollinger20.middle[i] : undefined,
    timeStopTs: candidate.timeStopHours !== undefined ? barTs + candidate.timeStopHours * 3600 : undefined,
    entryFee: fill.feeAmount,
  };
}

function resolveShadowPositions(shadowPositions, coinData) {
  const stillOpen = [];
  const resolved = [];

  for (const position of shadowPositions) {
    const data = coinData[position.coin];
    const exit = evaluateExit(position, { candles1h: data.candles1h, ema20By4hTs: data.ema20By4hTs });
    if (!exit) {
      stillOpen.push(position);
      continue;
    }
    const stakeValue = position.units * position.entryPrice;
    const fill = fillExit({ exitPrice: exit.exitPrice, stakeValue });
    const pnl = (fill.fillPrice - position.entryPrice) * position.units - position.entryFee - fill.feeAmount;
    const r = pnl / position.riskAmount;
    resolved.push({ candidateId: position.candidateId, exitTs: exit.exitTs, pnl, r, exitReason: exit.reason });
  }

  return { stillOpen, resolved };
}

module.exports = { openShadowPosition, resolveShadowPositions };
