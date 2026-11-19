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

module.exports = { isFourHourBoundary, utcDayKey, freshState };
