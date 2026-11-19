'use strict';
const { sizePosition, checkFeeViability, checkGuardrails } = require('../engine/risk');

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

    if (position.exitType === 'target_or_time') {
      if (candle.high >= position.targetPrice) {
        return { exitTs: candle.ts, exitPrice: position.targetPrice, reason: 'target' };
      }
      if (candle.ts >= position.timeStopTs) {
        return { exitTs: candle.ts, exitPrice: candle.close, reason: 'time_stop' };
      }
    }

    if (position.exitType === 'ema_cross_or_time') {
      const isLastHourOfFourHourPeriod = candle.ts % 14400 === 10800;
      if (isLastHourOfFourHourPeriod) {
        const fourHourTs = candle.ts - 10800;
        const ema20 = ema20By4hTs.get(fourHourTs);
        if (ema20 !== undefined && candle.close > ema20) {
          return { exitTs: candle.ts, exitPrice: candle.close, reason: 'ema_cross' };
        }
      }
      if (candle.ts >= position.timeStopTs) {
        return { exitTs: candle.ts, exitPrice: candle.close, reason: 'time_stop' };
      }
    }
  }

  return null;
}

function tryOpenPosition(state, candidate, data, i, config) {
  const atrPct = (candidate.atr / candidate.entry) * 100;
  if (!checkFeeViability({ atrPct, roundTripFeePct: config.roundTripFeePct })) return;

  const stopPrice = candidate.entry - candidate.default.stopAtr * candidate.atr;
  const riskPct = config.baseRiskPct * candidate.default.size;
  const sizing = sizePosition({ balance: state.balance, riskPct, entryPrice: candidate.entry, stopPrice });
  const exposurePct = sizing.stakeValue / state.balance;
  const barTs = data.candles4h[i].ts;

  const gate = checkGuardrails(
    {
      openPositions: state.openPositions.map((p) => ({ coin: p.coin, riskPct: p.riskPct, exposurePct: p.exposurePct })),
      cooldowns: state.cooldowns,
    },
    { coin: candidate.coin, riskPct, exposurePct, ts: barTs },
    config,
  );
  if (!gate.allowed) return;

  const fill = fillEntry({ candidate, sizing });
  const position = {
    coin: candidate.coin, setup: candidate.setup, entryTs: barTs,
    entryPrice: fill.fillPrice, units: sizing.units, riskAmount: sizing.riskAmount,
    riskPct, exposurePct, initialStopPrice: stopPrice, atrAtEntry: candidate.atr,
    exitType: candidate.exitType, trailAtr: candidate.default.trailAtr,
    targetPrice: candidate.exitType === 'target_or_time' ? data.indicators.bollinger20.middle[i] : undefined,
    timeStopTs: candidate.timeStopHours !== undefined ? barTs + candidate.timeStopHours * 3600 : undefined,
    entryFee: fill.feeAmount,
  };
  // Don't deduct the entry fee from balance here — closePosition's pnl already
  // subtracts position.entryFee once when the trade realizes. Deducting it here
  // too double-counted it.
  state.openPositions.push(position);
}

function closePosition(state, position, exit, config) {
  const stakeValue = position.units * position.entryPrice;
  const fill = fillExit({ exitPrice: exit.exitPrice, stakeValue });
  const pnl = (fill.fillPrice - position.entryPrice) * position.units - position.entryFee - fill.feeAmount;
  const r = pnl / position.riskAmount;

  state.balance += pnl;
  state.dailyPnl += pnl;
  state.openPositions = state.openPositions.filter((p) => p !== position);
  state.cooldowns[position.coin] = exit.exitTs + config.cooldownHours * 3600;
  state.closedTrades.push({ ...position, exitTs: exit.exitTs, exitPrice: fill.fillPrice, pnl, r, exitReason: exit.reason });
}

module.exports = { fillEntry, fillExit, evaluateExit, tryOpenPosition, closePosition, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT };
