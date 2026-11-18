'use strict';

function sizePosition({ balance, riskPct, entryPrice, stopPrice }) {
  const riskAmount = balance * riskPct;
  const stopDistancePerUnit = Math.abs(entryPrice - stopPrice);
  const units = riskAmount / stopDistancePerUnit;
  const stakeValue = units * entryPrice;
  return { units, stakeValue, riskAmount };
}

function checkFeeViability({ atrPct, roundTripFeePct, minMultiple = 4 }) {
  return atrPct >= minMultiple * roundTripFeePct;
}

module.exports = { sizePosition, checkFeeViability };
