'use strict';
const { sizePosition, checkFeeViability, checkGuardrails } = require('../engine/risk');

const DEFAULT_FEES = { makerPct: 0.0025, takerPct: 0.0040 };
const DEFAULT_SLIPPAGE_PCT = 0.0005;
const FOUR_H = 4 * 3600;

// Candles are keyed by bucket START (src/data/candles.js) and a candidate's entry fills at
// that bar's CLOSE — i.e. entryTs + FOUR_H, not entryTs itself. Every hourly candle inside the
// entry bar (ts in [entryTs, entryTs + FOUR_H)) happened strictly before the fill, so none of
// them can be used to evaluate an exit — using them would let a stop/target from before the
// position existed close it out.
function candlesSinceEntry(candles1h, entryTs, uptoTs) {
  return candles1h.filter((c) => c.ts >= entryTs + FOUR_H && c.ts <= uptoTs);
}

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
    // Check the stop using the trailing peak carried in from EARLIER candles only — never this
    // candle's own high. An hourly candle's OHLC doesn't say whether its high or its low came
    // first, so using this candle's high to raise the stop and then checking that same candle's
    // low against the raised level assumes a same-bar ordering that may not have happened.
    const currentStopPrice = position.exitType === 'trailing_stop'
      ? Math.max(position.initialStopPrice, highestHigh - position.trailAtr * position.atrAtEntry)
      : position.initialStopPrice;

    if (candle.low <= currentStopPrice) {
      return { exitTs: candle.ts, exitPrice: currentStopPrice, reason: 'stop' };
    }

    if (position.exitType === 'trailing_stop') {
      highestHigh = Math.max(highestHigh, candle.high);
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
  if (!checkFeeViability({ atrPct, roundTripFeePct: config.roundTripFeePct, minMultiple: config.feeViabilityMultiple })) return;

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

  const fill = fillEntry({ candidate, sizing, fees: config.fees, slippagePct: config.slippagePct });
  const position = {
    coin: candidate.coin, setup: candidate.setup, entryTs: barTs, candidateId: candidate.id,
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
  const fill = fillExit({ exitPrice: exit.exitPrice, stakeValue, fees: config.fees, slippagePct: config.slippagePct });
  const pnl = (fill.fillPrice - position.entryPrice) * position.units - position.entryFee - fill.feeAmount;
  const r = pnl / position.riskAmount;

  state.balance += pnl;
  state.dailyPnl += pnl;
  state.openPositions = state.openPositions.filter((p) => p !== position);
  state.cooldowns[position.coin] = exit.exitTs + config.cooldownHours * 3600;
  state.closedTrades.push({ ...position, exitTs: exit.exitTs, exitPrice: fill.fillPrice, pnl, r, exitReason: exit.reason });
}

module.exports = { fillEntry, fillExit, evaluateExit, tryOpenPosition, closePosition, candlesSinceEntry, DEFAULT_FEES, DEFAULT_SLIPPAGE_PCT };
