'use strict';
const { ema, rsi, atr, adx, donchian, bollinger } = require('../engine/indicators');
const { filterOutlierCandles } = require('../data/candles');
const { alignDailyIndices } = require('../engine/regime');

function buildCoinData({ candles4h, candles1h, candlesDaily, breakoutLookback = 20 }) {
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
    donchianBreakout: donchian(candles4h, breakoutLookback),
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
const { isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
const { SETUPS, SETUPS_BY_REGIME } = require('../engine/playbook');
const { DEFAULT_RISK_CONFIG, COINS } = require('../engine/config');
const { evaluateExit, tryOpenPosition, closePosition } = require('../broker/paper');
const { computeExpectancy, computeDrawdown } = require('./stats');
const { resolveSetupParams } = require('../engine/setupParams');

const HOUR = 3600, FOUR_H = 4 * 3600, DAY = 24 * 3600;

// fromTs=0 runs over every coin's full available history. Each coin's data naturally
// starts whenever its own earliest candle appears — the walk-forward loop below already
// skips a coin at any ts it has no candle for (findIndex returns -1), so coins with
// shorter histories (e.g. SOL from 2021) just sit out earlier bars without special-casing.
// Kraken's historical export has occasional bad ticks (e.g. a real one seen in this
// data: BTC/GBP 2018-01-09 02:00 printed high=13000, low=close=4.1 in one hour) that
// corrupt ATR/volatility and benchmark figures if left in. Every candle array this
// backtest touches goes through the same filter before use.
function loadFilteredCandles(db, coin, timeframe, fromTs, toTs) {
  const raw = getCandles(db, coin, timeframe, fromTs, toTs);
  const { candles, dropped } = filterOutlierCandles(raw);
  if (dropped > 0) {
    console.log(`  (dropped ${dropped} outlier ${timeframe} candle(s) for ${coin})`);
  }
  return candles;
}

function runBacktest(db, config = DEFAULT_RISK_CONFIG, fromTs = 0, setupsByRegime = SETUPS_BY_REGIME, setupParamsOverride = {}) {
  const setupParams = resolveSetupParams(setupParamsOverride);
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;

  const btcDaily = loadFilteredCandles(db, 'BTC', '1d', 0, nowHour);
  const btc4h = loadFilteredCandles(db, 'BTC', '4h', fromTs, nowHour);
  const watchlistBy4h = {};
  const coinCandles4h = {};
  for (const coin of COINS) {
    coinCandles4h[coin] = coin === 'BTC' ? btc4h : loadFilteredCandles(db, coin, '4h', fromTs, nowHour);
    watchlistBy4h[coin] = coinCandles4h[coin].map((c) => ({ ts: c.ts, close: c.close }));
  }
  const regimeByTs = new Map(computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h }).map((r) => [r.ts, r.label]));

  const coinData = {};
  for (const coin of COINS) {
    coinData[coin] = buildCoinData({
      candles4h: coinCandles4h[coin],
      candles1h: loadFilteredCandles(db, coin, '1h', fromTs, nowHour + FOUR_H),
      candlesDaily: coin === 'BTC' ? btcDaily : loadFilteredCandles(db, coin, '1d', 0, nowHour),
      breakoutLookback: setupParams.trend_breakout.lookback,
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
        for (const setupName of setupsByRegime[regimeLabel] || []) {
          const candidate = SETUPS[setupName].evaluate(coin, data.candles4h, data.indicators, i, regimeLabel, setupParams[setupName]);
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

module.exports = { buildCoinData, runBacktest, printReport, tryOpenPosition, closePosition };
