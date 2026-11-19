'use strict';

const HOUR = 3600, FOUR_H = 4 * HOUR, DAY = 24 * HOUR;

function isFourHourBoundary(tsSeconds) {
  return tsSeconds % FOUR_H === 0;
}

function utcDayKey(tsSeconds) {
  return Math.floor(tsSeconds / DAY);
}

function freshState(startingBalance = 1000) {
  return {
    balance: startingBalance, dailyPnl: 0, currentDay: null,
    weeklyPeakBalance: startingBalance, killSwitchActive: false,
    openPositions: [], cooldowns: {}, closedTrades: [],
  };
}

const { getCandles, loadSchedulerState, saveSchedulerState, insertTrade, insertCycleLog } = require('../data/db');
const { ingestAllCoins } = require('../data/ingest');
const { computeRegimeSeries } = require('../engine/regime');
const { isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
const { buildCoinData } = require('../backtest/run');
const { SETUPS, SETUPS_BY_REGIME } = require('../engine/playbook');
const { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS } = require('../engine/config');
const { evaluateExit, tryOpenPosition, closePosition } = require('../broker/paper');

async function runCycle(db, krakenClient, mode, config = DEFAULT_RISK_CONFIG, now = Date.now()) {
  const startedAt = Date.now();
  const nowHour = Math.floor(now / 1000 / HOUR) * HOUR;
  let regimeLabel = null, candidatesCount = 0, openedCount = 0, closedCount = 0;

  try {
    await ingestAllCoins(db, krakenClient, COIN_ALTNAMES, now);

    const btcDaily = getCandles(db, 'BTC', '1d', 0, nowHour);
    const btc4h = getCandles(db, 'BTC', '4h', 0, nowHour);
    const watchlistBy4h = {};
    const coinData = {};
    for (const coin of COINS) {
      const candles4h = getCandles(db, coin, '4h', 0, nowHour);
      watchlistBy4h[coin] = candles4h.map((c) => ({ ts: c.ts, close: c.close }));
      coinData[coin] = buildCoinData({
        candles4h,
        candles1h: getCandles(db, coin, '1h', 0, nowHour + FOUR_H),
        candlesDaily: getCandles(db, coin, '1d', 0, nowHour),
      });
    }

    const regimeSeries = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
    const currentRegime = [...regimeSeries].reverse().find((r) => r.ts <= nowHour);
    regimeLabel = currentRegime ? currentRegime.label : null;

    const state = loadSchedulerState(db, mode) || freshState();
    const dayKey = utcDayKey(nowHour);
    if (state.currentDay !== dayKey) {
      state.currentDay = dayKey;
      state.dailyPnl = 0;
    }

    for (const position of [...state.openPositions]) {
      const data = coinData[position.coin];
      const candles1hSlice = data.candles1h.filter((c) => c.ts > position.entryTs && c.ts <= nowHour);
      const exit = evaluateExit(position, { candles1h: candles1hSlice, ema20By4hTs: data.ema20By4hTs });
      if (exit) {
        closePosition(state, position, exit, config);
        closedCount += 1;
      }
    }

    state.weeklyPeakBalance = Math.max(state.weeklyPeakBalance, state.balance);
    const weeklyDrawdownPct = (state.weeklyPeakBalance - state.balance) / state.weeklyPeakBalance;
    if (isKillSwitchTriggered(weeklyDrawdownPct, config)) state.killSwitchActive = true;
    const balanceAtDayStart = state.balance - state.dailyPnl;
    const dailyLossHit = isDailyLossLimitHit(state.dailyPnl / balanceAtDayStart, config);

    if (regimeLabel && isFourHourBoundary(nowHour) && !state.killSwitchActive && !dailyLossHit && regimeLabel !== 'risk_off') {
      for (const coin of COINS) {
        const data = coinData[coin];
        const i = data.candles4h.findIndex((c) => c.ts === nowHour);
        if (i === -1) continue;
        for (const setupName of SETUPS_BY_REGIME[regimeLabel] || []) {
          const candidate = SETUPS[setupName].evaluate(coin, data.candles4h, data.indicators, i, regimeLabel);
          if (!candidate) continue;
          candidatesCount += 1;
          const before = state.openPositions.length;
          tryOpenPosition(state, candidate, data, i, config);
          if (state.openPositions.length > before) openedCount += 1;
        }
      }
    }

    for (const trade of state.closedTrades) {
      insertTrade(db, {
        mode, coin: trade.coin, setup: trade.setup, entryTs: trade.entryTs, exitTs: trade.exitTs,
        entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, units: trade.units,
        riskAmount: trade.riskAmount, pnl: trade.pnl, r: trade.r, exitReason: trade.exitReason,
      });
    }
    state.closedTrades = [];

    saveSchedulerState(db, mode, state);
    insertCycleLog(db, {
      ts: nowHour, mode, regimeLabel, candidatesCount, openedCount, closedCount,
      durationMs: Date.now() - startedAt,
    });

    return { regimeLabel, candidatesCount, openedCount, closedCount };
  } catch (err) {
    insertCycleLog(db, {
      ts: nowHour, mode, regimeLabel, candidatesCount, openedCount, closedCount,
      durationMs: Date.now() - startedAt, error: err.message,
    });
    return { error: err.message };
  }
}

module.exports = { isFourHourBoundary, utcDayKey, freshState, runCycle };
