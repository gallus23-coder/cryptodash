'use strict';
const { runBacktest } = require('./run');
const { computeExpectancy, computeBenchmarkComparison } = require('./stats');
const { getCandles, getActiveConfigVersion, getMostRecentSupersededConfigVersion, getTrades } = require('../data/db');
const { resolveEffectiveConfig, DEFAULT_RISK_CONFIG } = require('../engine/config');
const { resolveSetupParams } = require('../engine/setupParams');
const { SETUPS_BY_REGIME } = require('../engine/playbook');

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

function buildShadowComparison(db, mode) {
  const active = getActiveConfigVersion(db, mode);
  if (active.decidedTs === null) return { tooSoon: true };
  const sinceTs = Math.floor(active.decidedTs / 1000);
  const ageSeconds = Math.floor(Date.now() / 1000) - sinceTs;
  if (ageSeconds < 14 * 86400) return { tooSoon: true };
  const superseded = getMostRecentSupersededConfigVersion(db, mode);
  if (!superseded) return { tooSoon: true };

  const { config: oldConfig, setupsByRegime: oldSetupsByRegime } = resolveEffectiveConfig(DEFAULT_RISK_CONFIG, superseded.config, SETUPS_BY_REGIME);
  const oldSetupParams = resolveSetupParams(superseded.config.setupParams);
  const oldResult = runBacktest(db, oldConfig, sinceTs, oldSetupsByRegime, oldSetupParams);
  const btcCloses = getCandles(db, 'BTC', '1d', sinceTs, Math.floor(Date.now() / 1000)).map((c) => c.close);
  const oldConfigSimulated = summarizeWindow(oldResult.state.closedTrades, btcCloses);

  const newTrades = getTrades(db, mode).filter((t) => t.entryTs >= sinceTs);
  const newConfigActual = summarizeWindow(newTrades, btcCloses);

  return { tooSoon: false, sinceTs, oldConfigSimulated, newConfigActual };
}

module.exports = { splitTradesByWindow, summarizeWindow, buildWalkForwardReport, buildShadowComparison };
