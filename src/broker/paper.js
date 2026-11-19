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

module.exports = { fillEntry, fillExit, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT };
