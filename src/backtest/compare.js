'use strict';
const { runBacktest } = require('./run');
const { computeExpectancy, computeBenchmarkComparison } = require('./stats');
const { getCandles } = require('../data/db');

function splitTradesByWindow(trades, boundaryTs) {
  return {
    earlier: trades.filter((t) => t.entryTs < boundaryTs),
    later: trades.filter((t) => t.entryTs >= boundaryTs),
  };
}

function summarizeWindow(trades, btcCloses) {
  const { count, winRate, expectancy } = computeExpectancy(trades);

  const sortedByExit = [...trades].sort((a, b) => (a.exitTs ?? 0) - (b.exitTs ?? 0));
  const botSeries = [0];
  let running = 0;
  for (const t of sortedByExit) {
    running += t.pnl ?? t.r;
    botSeries.push(running);
  }
  const comparison = computeBenchmarkComparison({ botSeries, btcSeries: btcCloses });

  return {
    trades: count, winRate, expectancy,
    worstDrawdownPct: comparison.bot.worstDrawdownPct,
    tooFewToJudge: count < 30,
    vsBtc: comparison.btc,
  };
}

function buildWalkForwardReport(db, opts) {
  const {
    activeConfig, activeSetupsByRegime, activeSetupParams,
    draftConfig, draftSetupsByRegime, draftSetupParams,
    fromTs, boundaryTs, toTs,
  } = opts;

  const activeResult = runBacktest(db, activeConfig, fromTs, activeSetupsByRegime, activeSetupParams);
  const draftResult = runBacktest(db, draftConfig, fromTs, draftSetupsByRegime, draftSetupParams);

  const earlierBtcCloses = getCandles(db, 'BTC', '1d', fromTs, boundaryTs).map((c) => c.close);
  const laterBtcCloses = getCandles(db, 'BTC', '1d', boundaryTs, toTs).map((c) => c.close);

  const activeSplit = splitTradesByWindow(activeResult.state.closedTrades, boundaryTs);
  const draftSplit = splitTradesByWindow(draftResult.state.closedTrades, boundaryTs);

  return {
    active: {
      earlier: summarizeWindow(activeSplit.earlier, earlierBtcCloses),
      later: summarizeWindow(activeSplit.later, laterBtcCloses),
    },
    draft: {
      earlier: summarizeWindow(draftSplit.earlier, earlierBtcCloses),
      later: summarizeWindow(draftSplit.later, laterBtcCloses),
    },
  };
}

module.exports = { splitTradesByWindow, summarizeWindow, buildWalkForwardReport };
