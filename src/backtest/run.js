'use strict';
const { ema, rsi, atr, adx, donchian, bollinger } = require('../engine/indicators');
const { alignDailyIndices } = require('../engine/regime');

function buildCoinData({ candles4h, candles1h, candlesDaily }) {
  const closes4h = candles4h.map((c) => c.close);
  const dailyCloses = candlesDaily.map((c) => c.close);
  const dailyEma200 = ema(dailyCloses, 200);
  const dailyIdx = alignDailyIndices(candlesDaily, candles4h);
  const dailyEma200Aligned = dailyIdx.map((idx) => (idx === null ? null : dailyEma200[idx]));

  const indicators = {
    ema20: ema(closes4h, 20),
    ema50: ema(closes4h, 50),
    rsi14: rsi(closes4h, 14),
    rsi2: rsi(closes4h, 2),
    atr14: atr(candles4h, 14),
    donchian20: donchian(candles4h, 20),
    bollinger20: bollinger(closes4h, 20, 2),
    adx14: adx(candles4h, 14),
    dailyEma200Aligned,
  };

  const ema20By4hTs = new Map();
  candles4h.forEach((c, i) => {
    if (indicators.ema20[i] !== null) ema20By4hTs.set(c.ts, indicators.ema20[i]);
  });

  return { candles4h, candles1h, indicators, ema20By4hTs };
}

const { openDb, getCandles } = require('../data/db');
const { computeRegimeSeries } = require('../engine/regime');
const { sizePosition, checkFeeViability, checkGuardrails, isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
const trendBreakout = require('../engine/playbook/trendBreakout');
const trendPullback = require('../engine/playbook/trendPullback');
const rangeReversion = require('../engine/playbook/rangeReversion');
const oversoldBounce = require('../engine/playbook/oversoldBounce');
const { fillEntry, fillExit, evaluateExit } = require('../broker/paper');
const { computeTradeR, computeExpectancy, computeDrawdown } = require('./stats');

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'LINK'];
const HOUR = 3600, FOUR_H = 4 * 3600, DAY = 24 * 3600;
const SIX_MONTHS_SECONDS = 186 * DAY;

const CONFIG = {
  baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
  maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6,
  dailyLossLimitPct: 0.03, weeklyKillSwitchPct: 0.08,
  roundTripFeePct: 0.65, // percent, matches checkFeeViability's expected units
};

const SETUPS = {
  trend_breakout: trendBreakout, trend_pullback: trendPullback,
  range_reversion: rangeReversion, oversold_bounce: oversoldBounce,
};
const SETUPS_BY_REGIME = {
  trend_up: ['trend_breakout', 'trend_pullback'],
  range: ['range_reversion'],
  downtrend: ['oversold_bounce'],
  risk_off: [],
};

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
  state.balance -= fill.feeAmount;
  state.openPositions.push(position);
}

function closePosition(state, position, exit, config) {
  const stakeValue = position.units * position.entryPrice;
  const fill = fillExit({ exitPrice: exit.exitPrice, stakeValue });
  const pnl = (fill.fillPrice - position.entryPrice) * position.units - position.entryFee - fill.feeAmount;
  const r = computeTradeR(pnl, position.riskAmount);

  state.balance += pnl;
  state.dailyPnl += pnl;
  state.openPositions = state.openPositions.filter((p) => p !== position);
  state.cooldowns[position.coin] = exit.exitTs + config.cooldownHours * 3600;
  state.closedTrades.push({ ...position, exitTs: exit.exitTs, exitPrice: fill.fillPrice, pnl, r, exitReason: exit.reason });
}

function runBacktest(db, config = CONFIG) {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const fromTs = nowHour - SIX_MONTHS_SECONDS;

  const btcDaily = getCandles(db, 'BTC', '1d', 0, nowHour);
  const btc4h = getCandles(db, 'BTC', '4h', fromTs, nowHour);
  const watchlistBy4h = {};
  for (const coin of COINS) {
    watchlistBy4h[coin] = getCandles(db, coin, '4h', fromTs, nowHour).map((c) => ({ ts: c.ts, close: c.close }));
  }
  const regimeByTs = new Map(computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h }).map((r) => [r.ts, r.label]));

  const coinData = {};
  for (const coin of COINS) {
    coinData[coin] = buildCoinData({
      candles4h: getCandles(db, coin, '4h', fromTs, nowHour),
      candles1h: getCandles(db, coin, '1h', fromTs, nowHour + FOUR_H),
      candlesDaily: getCandles(db, coin, '1d', 0, nowHour),
    });
  }

  const startingBalance = 1000;
  const state = {
    balance: startingBalance, dailyPnl: 0, currentDay: null,
    weeklyPeakBalance: startingBalance, killSwitchActive: false,
    openPositions: [], cooldowns: {}, closedTrades: [], equityCurve: [],
  };

  for (const bar of btc4h) {
    const ts = bar.ts;
    const regimeLabel = regimeByTs.get(ts);
    if (regimeLabel === undefined) continue;

    const dayKey = Math.floor(ts / DAY);
    if (state.currentDay !== dayKey) {
      state.currentDay = dayKey;
      state.dailyPnl = 0;
    }

    for (const position of [...state.openPositions]) {
      const data = coinData[position.coin];
      const candles1hSlice = data.candles1h.filter((c) => c.ts > position.entryTs && c.ts <= ts + FOUR_H - HOUR);
      const exit = evaluateExit(position, { candles1h: candles1hSlice, ema20By4hTs: data.ema20By4hTs });
      if (exit) closePosition(state, position, exit, config);
    }

    state.weeklyPeakBalance = Math.max(state.weeklyPeakBalance, state.balance);
    const weeklyDrawdownPct = (state.weeklyPeakBalance - state.balance) / state.weeklyPeakBalance;
    if (isKillSwitchTriggered(weeklyDrawdownPct, config)) state.killSwitchActive = true;
    const dailyLossHit = isDailyLossLimitHit(state.dailyPnl / startingBalance, config);

    if (!state.killSwitchActive && !dailyLossHit && regimeLabel !== 'risk_off') {
      for (const coin of COINS) {
        const data = coinData[coin];
        const i = data.candles4h.findIndex((c) => c.ts === ts);
        if (i === -1) continue;
        for (const setupName of SETUPS_BY_REGIME[regimeLabel] || []) {
          const candidate = SETUPS[setupName].evaluate(coin, data.candles4h, data.indicators, i, regimeLabel);
          if (candidate) tryOpenPosition(state, candidate, data, i, config);
        }
      }
    }

    state.equityCurve.push(state.balance);
  }

  return { state, btc4h, startingBalance };
}

function printReport({ state, btc4h, startingBalance }) {
  const bySetup = {};
  for (const trade of state.closedTrades) {
    (bySetup[trade.setup] = bySetup[trade.setup] || []).push(trade);
  }

  console.log(`\nBacktest: ${state.closedTrades.length} closed trades, final balance £${state.balance.toFixed(2)} (started £${startingBalance})`);
  console.log('\nPer-setup results (milestone 4 gate: positive expectancy AND 30+ trades):');
  for (const [setup, trades] of Object.entries(bySetup)) {
    const { count, winRate, expectancy, pass } = computeExpectancy(trades);
    console.log(`  ${setup}: ${count} trades, win rate ${(winRate * 100).toFixed(1)}%, expectancy ${expectancy.toFixed(2)}R -> ${pass ? 'PASS' : 'FAIL'}`);
  }

  const botReturnPct = ((state.balance - startingBalance) / startingBalance) * 100;
  const botDD = computeDrawdown([startingBalance, ...state.equityCurve]);

  const btcCloses = btc4h.map((c) => c.close);
  const btcReturnPct = ((btcCloses[btcCloses.length - 1] - btcCloses[0]) / btcCloses[0]) * 100;
  const btcDD = computeDrawdown(btcCloses);

  console.log('\nBenchmark (vs buy-and-hold BTC, vs cash):');
  console.log(`  Bot:  return ${botReturnPct.toFixed(1)}%, worst drawdown ${(botDD.maxDrawdownPct * 100).toFixed(1)}%`);
  console.log(`  BTC:  return ${btcReturnPct.toFixed(1)}%, worst drawdown ${(btcDD.maxDrawdownPct * 100).toFixed(1)}%`);
  console.log('  Cash: return 0.0%, worst drawdown 0.0%');
}

function main() {
  const db = openDb();
  const result = runBacktest(db);
  printReport(result);
}

if (require.main === module) main();

module.exports = { buildCoinData, runBacktest, printReport };
