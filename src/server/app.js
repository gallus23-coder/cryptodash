'use strict';
const express = require('express');
const path = require('path');

function createApp(db, { password } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public-v2')));

  app.use('/api', (req, res, next) => {
    if (!password) return next();
    const provided = req.get('X-Dashboard-Password');
    if (provided !== password) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  const { getDecisionsFiltered } = require('../data/db');

  app.get('/api/decisions', (req, res) => {
    const { mode, from, to, coin, setup, diverged } = req.query;
    const rows = getDecisionsFiltered(db, {
      mode: mode || 'paper',
      from: from !== undefined ? Number(from) : undefined,
      to: to !== undefined ? Number(to) : undefined,
      coin, setup,
      diverged: diverged !== undefined ? diverged === 'true' : undefined,
    });
    res.json(rows);
  });

  const { getCycleLogByTs, getCandidatesByTs, getTradeByCandidateId, getDecisionByCandidateId } = require('../data/db');

  app.get('/api/decisions/:cycleId', (req, res) => {
    const ts = Number(req.params.cycleId);
    const mode = req.query.mode || 'paper';
    const cycle = getCycleLogByTs(db, mode, ts);
    if (!cycle) return res.status(404).json({ error: 'no cycle at that ts' });

    const candidates = getCandidatesByTs(db, mode, ts).map((candidate) => ({
      ...candidate,
      decision: getDecisionByCandidateId(db, candidate.id, mode),
      trade: getTradeByCandidateId(db, candidate.id, mode),
    }));

    res.json({ cycle, candidates });
  });

  const { getScorecardData } = require('../data/db');

  app.get('/api/scorecard', (req, res) => {
    const days = Number(req.query.days) || 30;
    const mode = req.query.mode || 'paper';
    const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = getScorecardData(db, mode, sinceTs);

    const diverged = rows.filter((r) => r.diverged);
    const claudeRs = diverged.filter((r) => r.decisionAction === 'take' && r.tradeR !== null).map((r) => r.tradeR);
    const defaultRs = diverged.map((r) => r.shadowR).filter((r) => r !== null);

    const mean = (arr) => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length);
    const stderr = (arr) => {
      if (arr.length < 2) return 0;
      const m = mean(arr);
      const variance = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1);
      return Math.sqrt(variance / arr.length);
    };

    const claudeMeanR = mean(claudeRs);
    const se = stderr(claudeRs);

    res.json({
      days, divergedCount: diverged.length, notEnoughData: diverged.length < 100,
      claudeMeanR, defaultMeanR: mean(defaultRs),
      confidenceRange: [claudeMeanR - 1.96 * se, claudeMeanR + 1.96 * se],
    });
  });

  const { getCycleLogFiltered } = require('../data/db');

  app.get('/api/cycles', (req, res) => {
    const { mode, from, to, regime, coin, setup, action, diverged, limit } = req.query;
    const rows = getCycleLogFiltered(db, {
      mode: mode || 'paper',
      from: from !== undefined ? Number(from) : undefined,
      to: to !== undefined ? Number(to) : undefined,
      regime, coin, setup, action,
      diverged: diverged !== undefined ? diverged === 'true' : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
    res.json(rows);
  });

  const { getCandles } = require('../data/db');
  const VALID_TIMEFRAMES = ['1h', '4h', '1d'];

  app.get('/api/candles/:coin', (req, res) => {
    const { tf, from, to } = req.query;
    const timeframe = tf || '1h';
    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ error: `unsupported timeframe: ${timeframe}` });
    }
    const fromTs = from !== undefined ? Number(from) : 0;
    const toTs = to !== undefined ? Number(to) : Math.floor(Date.now() / 1000);
    res.json(getCandles(db, req.params.coin, timeframe, fromTs, toTs));
  });

  const { getTradesByCoin, getCandidatesByCoin } = require('../data/db');

  app.get('/api/markers/:coin', (req, res) => {
    const mode = req.query.mode || 'paper';
    const fromTs = req.query.from !== undefined ? Number(req.query.from) : 0;
    const toTs = req.query.to !== undefined ? Number(req.query.to) : Math.floor(Date.now() / 1000);
    const candidates = getCandidatesByCoin(db, mode, req.params.coin, fromTs, toTs).map((candidate) => ({
      ...candidate,
      decision: getDecisionByCandidateId(db, candidate.id, mode),
    }));
    res.json({
      trades: getTradesByCoin(db, mode, req.params.coin, fromTs, toTs),
      candidates,
    });
  });

  const { getRegimeHistory, getLatestRegimeLabel } = require('../data/db');
  const { computeRegimeSeries } = require('../engine/regime');
  const { COINS } = require('../engine/config');

  app.get('/api/regime/history', (req, res) => {
    const mode = req.query.mode || 'paper';
    const fromTs = req.query.from !== undefined ? Number(req.query.from) : 0;
    const toTs = req.query.to !== undefined ? Number(req.query.to) : Math.floor(Date.now() / 1000);
    res.json(getRegimeHistory(db, mode, fromTs, toTs));
  });

  app.get('/api/regime/current', (req, res) => {
    const nowTs = Math.floor(Date.now() / 1000);
    const btcDaily = getCandles(db, 'BTC', '1d', 0, nowTs);
    const btc4h = getCandles(db, 'BTC', '4h', 0, nowTs);
    const watchlistBy4h = {};
    for (const coin of COINS) {
      watchlistBy4h[coin] = getCandles(db, coin, '4h', 0, nowTs).map((c) => ({ ts: c.ts, close: c.close }));
    }
    const series = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
    const latest = series.length > 0 ? series[series.length - 1] : null;
    if (latest) {
      res.json({ label: latest.label, ts: latest.ts, metrics: latest.metrics });
      return;
    }
    const mode = req.query.mode || 'paper';
    const fallbackLabel = getLatestRegimeLabel(db, mode);
    res.json({ label: fallbackLabel, ts: null, metrics: null });
  });

  const { ema, bollinger, rsi, adx } = require('../engine/indicators');

  app.get('/api/indicators/:coin', (req, res) => {
    const { tf, from, to } = req.query;
    const timeframe = tf || '4h';
    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ error: `unsupported timeframe: ${timeframe}` });
    }
    const fromTs = from !== undefined ? Number(from) : 0;
    const toTs = to !== undefined ? Number(to) : Math.floor(Date.now() / 1000);
    const candles = getCandles(db, req.params.coin, timeframe, fromTs, toTs);
    const closes = candles.map((c) => c.close);
    const bb = bollinger(closes, 20, 2);
    const adxResult = adx(candles, 14);

    res.json({
      ts: candles.map((c) => c.ts),
      ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200),
      bollingerUpper: bb.upper, bollingerMiddle: bb.middle, bollingerLower: bb.lower,
      rsi14: rsi(closes, 14), adx14: adxResult.adx,
    });
  });

  const { loadSchedulerState, resetKillSwitch } = require('../data/db');

  app.get('/api/positions', (req, res) => {
    const mode = req.query.mode || 'paper';
    const state = loadSchedulerState(db, mode);
    res.json(state ? state.openPositions : []);
  });

  const { getSetupStats, getLatestMarketNote } = require('../data/db');
  const { SETUPS } = require('../engine/playbook');
  const { DEFAULT_RISK_CONFIG } = require('../engine/config');
  const { DEFAULT_SETUP_PARAMS, SETUP_PARAM_BOUNDS } = require('../engine/setupParams');

  app.get('/api/strategy', (req, res) => {
    const mode = req.query.mode || 'paper';
    const nowTs = Math.floor(Date.now() / 1000);

    const setups = Object.entries(SETUPS).map(([name, mod]) => ({
      name, ranges: mod.RANGES,
      params: DEFAULT_SETUP_PARAMS[name], paramBounds: SETUP_PARAM_BOUNDS[name],
      stats30d: getSetupStats(db, mode, name, nowTs - 30 * 86400),
      stats90d: getSetupStats(db, mode, name, nowTs - 90 * 86400),
    }));

    const state = loadSchedulerState(db, mode);
    const balanceAtDayStart = state ? state.balance - state.dailyPnl : 0;
    const weeklyDrawdownPct = state && state.weeklyPeakBalance > 0 ? (state.weeklyPeakBalance - state.balance) / state.weeklyPeakBalance : 0;
    const totalRiskPctUsed = state ? state.openPositions.reduce((sum, p) => sum + p.riskPct, 0) : 0;
    const totalExposurePctUsed = state ? state.openPositions.reduce((sum, p) => sum + p.exposurePct, 0) : 0;
    const dailyLossPctUsed = state && balanceAtDayStart > 0 ? -state.dailyPnl / balanceAtDayStart : 0;

    res.json({
      setups,
      marketNote: getLatestMarketNote(db, mode),
      guardrails: {
        killSwitchActive: state ? state.killSwitchActive : false,
        openPositions: { used: state ? state.openPositions.length : 0, max: DEFAULT_RISK_CONFIG.maxOpenPositions },
        totalRiskPct: { used: totalRiskPctUsed, max: DEFAULT_RISK_CONFIG.maxTotalRiskPct },
        totalExposurePct: { used: totalExposurePctUsed, max: DEFAULT_RISK_CONFIG.maxTotalExposurePct },
        dailyLossPct: { used: Math.max(0, dailyLossPctUsed), max: DEFAULT_RISK_CONFIG.dailyLossLimitPct },
        weeklyDrawdownPct: { used: weeklyDrawdownPct, max: DEFAULT_RISK_CONFIG.weeklyKillSwitchPct },
      },
      config: { activeVersion: 'default', pending: null },
    });
  });

  const { applyRiskLevel } = require('../engine/config');
  const { runBacktest } = require('../backtest/run');
  const { computeExpectancy } = require('../backtest/stats');
  const { SETUPS_BY_REGIME } = require('../engine/playbook');
  const { resolveSetupParams } = require('../engine/setupParams');

  function validateDraft(body) {
    const { riskLevel, disabledSetups, rangeOverrides, setupParams } = body || {};
    if (!['cautious', 'normal', 'bold'].includes(riskLevel)) return { error: `invalid riskLevel: ${riskLevel}` };
    const validSetupNames = Object.keys(SETUPS);
    for (const name of disabledSetups || []) {
      if (!validSetupNames.includes(name)) return { error: `unknown setup in disabledSetups: ${name}` };
    }
    return { draft: { riskLevel, disabledSetups: disabledSetups || [], rangeOverrides: rangeOverrides || {}, setupParams: resolveSetupParams(setupParams || {}) } };
  }

  app.post('/api/config/draft', (req, res) => {
    const { error, draft } = validateDraft(req.body);
    if (error) return res.status(400).json({ error });
    res.json(draft);
  });

  app.post('/api/config/draft/backtest', (req, res) => {
    const mode = req.query.mode || 'paper';
    const { error, draft } = validateDraft(req.body);
    if (error) return res.status(400).json({ error });

    const { getActiveConfigVersion } = require('../data/db');
    const { resolveEffectiveConfig } = require('../engine/config');
    const { buildWalkForwardReport } = require('../backtest/compare');

    const scaledConfig = applyRiskLevel(DEFAULT_RISK_CONFIG, draft.riskLevel);
    const setupsByRegimeForDraft = Object.fromEntries(
      Object.entries(SETUPS_BY_REGIME).map(([regime, names]) => [regime, names.filter((n) => !draft.disabledSetups.includes(n))])
    );

    const nowTs = Math.floor(Date.now() / 1000);
    const result = runBacktest(db, scaledConfig, nowTs - 90 * 86400, setupsByRegimeForDraft, draft.setupParams);

    const bySetupTrades = {};
    for (const trade of result.state.closedTrades) {
      (bySetupTrades[trade.setup] = bySetupTrades[trade.setup] || []).push(trade);
    }
    const bySetup = Object.fromEntries(Object.entries(bySetupTrades).map(([name, trades]) => [name, computeExpectancy(trades)]));

    const activeVersion = getActiveConfigVersion(db, mode);
    const { config: activeEffectiveConfig, setupsByRegime: activeSetupsByRegime } = resolveEffectiveConfig(DEFAULT_RISK_CONFIG, activeVersion.config, SETUPS_BY_REGIME);
    const activeSetupParams = resolveSetupParams(activeVersion.config.setupParams);
    const walkForward = buildWalkForwardReport(db, {
      activeConfig: activeEffectiveConfig, activeSetupsByRegime, activeSetupParams,
      draftConfig: scaledConfig, draftSetupsByRegime: setupsByRegimeForDraft, draftSetupParams: draft.setupParams,
      fromTs: nowTs - 90 * 86400, boundaryTs: nowTs - 30 * 86400, toTs: nowTs,
    });

    res.json({
      draft,
      backtestSummary: {
        totalTrades: result.state.closedTrades.length,
        finalBalance: result.state.balance,
        bySetup,
      },
      walkForward,
      note: 'rangeOverrides do not affect this backtest — the backtest is deterministic and never calls Claude, so Claude\'s adjustment ranges have nothing to act on here. Only riskLevel and disabledSetups change this result.',
    });
  });

  const {
    insertConfigVersion, getActiveConfigVersion, getPendingConfigVersion,
    approveConfigVersion, rejectConfigVersion, supersedePendingConfigVersions,
  } = require('../data/db');

  app.post('/api/config/draft/submit', (req, res) => {
    const mode = req.query.mode || 'paper';
    const { draft, backtestSummary } = req.body || {};
    if (!draft) return res.status(400).json({ error: 'missing draft' });

    supersedePendingConfigVersions(db, mode);
    const id = insertConfigVersion(db, { mode, configJson: draft, backtestJson: backtestSummary });
    res.json({ id });
  });

  app.get('/api/config/pending', (req, res) => {
    const mode = req.query.mode || 'paper';
    res.json({ active: getActiveConfigVersion(db, mode), pending: getPendingConfigVersion(db, mode) });
  });

  app.post('/api/config/:id/approve', (req, res) => {
    const mode = req.query.mode || 'paper';
    const id = Number(req.params.id);
    try {
      approveConfigVersion(db, mode, id);
      res.json({ ok: true });
    } catch (err) {
      const exists = db.prepare('SELECT 1 FROM config_versions WHERE id = ? AND mode = ?').get(id, mode);
      res.status(exists ? 409 : 404).json({ error: err.message });
    }
  });

  app.post('/api/config/:id/reject', (req, res) => {
    const mode = req.query.mode || 'paper';
    const id = Number(req.params.id);
    try {
      rejectConfigVersion(db, mode, id);
      res.json({ ok: true });
    } catch (err) {
      const exists = db.prepare('SELECT 1 FROM config_versions WHERE id = ? AND mode = ?').get(id, mode);
      res.status(exists ? 409 : 404).json({ error: err.message });
    }
  });

  const { buildGoLiveChecklist, getTrades } = require('../data/db');

  app.get('/api/go-live-checklist', (req, res) => {
    const mode = req.query.mode || 'paper';
    const { computeExpectancy } = require('../backtest/stats');

    const trades = getTrades(db, mode);
    const { count: tradeCount, expectancy } = computeExpectancy(trades);

    const sinceTs = Math.floor(Date.now() / 1000) - 30 * 86400;
    const scorecardRows = getScorecardData(db, mode, sinceTs);
    const diverged = scorecardRows.filter((r) => r.diverged);
    const claudeRs = diverged.filter((r) => r.decisionAction === 'take' && r.tradeR !== null).map((r) => r.tradeR);
    const mean = (arr) => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length);
    const scorecardNotEnoughData = diverged.length < 100;
    const scorecardClaudeMeanR = mean(claudeRs);

    res.json(buildGoLiveChecklist({ tradeCount, expectancy, scorecardNotEnoughData, scorecardClaudeMeanR }));
  });

  const { getBenchmarkInputs } = require('../data/db');

  app.get('/api/benchmarks', (req, res) => {
    const mode = req.query.mode || 'paper';
    const { computeBenchmarkComparison } = require('../backtest/stats');

    const inputs = getBenchmarkInputs(db, mode);
    if (!inputs) {
      res.json({ startTs: null, bot: null, btc: null, cash: null });
      return;
    }

    const comparison = computeBenchmarkComparison({ botSeries: inputs.botSeries, btcSeries: inputs.btcSeries });
    res.json({ startTs: inputs.startTs, ...comparison });
  });

  app.post('/api/guardrails/reset-kill-switch', (req, res) => {
    const mode = req.query.mode || 'paper';
    try {
      resetKillSwitch(db, mode);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  const { getClaudeCallsToday, pauseTrading, resumeTrading } = require('../data/db');
  const { utcDayKey } = require('../scheduler/cycle');

  app.get('/api/status', (req, res) => {
    const mode = req.query.mode || 'paper';
    const state = loadSchedulerState(db, mode);
    const nowTs = Math.floor(Date.now() / 1000);
    const dayStartTs = utcDayKey(nowTs) * 86400;
    res.json({
      pausedByOperator: state ? state.pausedByOperator : false,
      claudeCallsToday: getClaudeCallsToday(db, mode, dayStartTs, dayStartTs + 86400),
    });
  });

  app.post('/api/control/pause', (req, res) => {
    const mode = req.query.mode || 'paper';
    try {
      pauseTrading(db, mode);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post('/api/control/resume', (req, res) => {
    const mode = req.query.mode || 'paper';
    try {
      resumeTrading(db, mode);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  const { getDecisionCallCounts, getMonthStartTs } = require('../data/db');

  const { getBenchmarkInputs: getBenchmarkInputsForSettings, saveSchedulerState } = require('../data/db');
  const { freshState } = require('../scheduler/cycle');

  app.get('/api/settings/paper', (req, res) => {
    const inputs = getBenchmarkInputsForSettings(db, 'paper');
    const tradesSoFar = getTrades(db, 'paper').length;
    if (!inputs) {
      res.json({ startingBalance: null, balanceNow: null, returnPct: null, runningSinceTs: null, tradesSoFar });
      return;
    }
    const startingBalance = inputs.botSeries[0];
    const balanceNow = inputs.botSeries[inputs.botSeries.length - 1];
    res.json({
      startingBalance, balanceNow,
      returnPct: (balanceNow - startingBalance) / startingBalance,
      runningSinceTs: inputs.startTs,
      tradesSoFar,
    });
  });

  app.get('/api/settings/guardrail-caps', (req, res) => {
    res.json({
      paper: {
        baseStakePct: DEFAULT_RISK_CONFIG.baseRiskPct, maxOpenPositions: DEFAULT_RISK_CONFIG.maxOpenPositions,
        maxCoinExposurePct: DEFAULT_RISK_CONFIG.maxCoinExposurePct, maxTotalExposurePct: DEFAULT_RISK_CONFIG.maxTotalExposurePct,
        dailyLossLimitPct: DEFAULT_RISK_CONFIG.dailyLossLimitPct, weeklyKillSwitchPct: DEFAULT_RISK_CONFIG.weeklyKillSwitchPct,
      },
      // Reference values — not enforced anywhere in code, since no live scheduler exists yet.
      // Risk-based like paper (CLAUDE.md), just tighter: half of paper's baseRiskPct.
      live: {
        baseStakePct: DEFAULT_RISK_CONFIG.baseRiskPct * 0.5, maxOpenPositions: 2, maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.40,
        dailyLossLimitPct: 0.02, weeklyKillSwitchPct: 0.05,
      },
      liveNote: 'Reference values from the design doc — not yet enforced, since live mode has no scheduler yet.',
    });
  });

  app.post('/api/control/reset-account', (req, res) => {
    const mode = req.query.mode || 'paper';
    if (mode !== 'paper') {
      res.status(403).json({ error: 'reset is only allowed for paper mode' });
      return;
    }
    const startingBalance = Number(req.body.startingBalance) || 1000;
    saveSchedulerState(db, mode, freshState(startingBalance));
    res.json({ ok: true });
  });

  const { REGIME_THRESHOLDS } = require('../engine/regime');
  const { getBenchmarkInputs: getBenchmarkInputsForHowItWorks, getMostRecentSupersededConfigVersion } = require('../data/db');
  const { computeBenchmarkComparison: computeBenchmarkComparisonForHowItWorks } = require('../backtest/stats');

  app.get('/api/how-it-works', (req, res) => {
    const mode = req.query.mode || 'paper';
    const nowTs = Math.floor(Date.now() / 1000);

    const btcDaily = getCandles(db, 'BTC', '1d', 0, nowTs);
    const btc4h = getCandles(db, 'BTC', '4h', 0, nowTs);
    const watchlistBy4h = {};
    for (const coin of COINS) {
      watchlistBy4h[coin] = getCandles(db, coin, '4h', 0, nowTs).map((c) => ({ ts: c.ts, close: c.close }));
    }
    const series = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
    const current = series.length > 0 ? series[series.length - 1] : null;
    let regimeDuration = 'not yet known';
    if (current) {
      let heldSinceTs = current.ts;
      for (let i = series.length - 1; i >= 0 && series[i].label === current.label; i -= 1) heldSinceTs = series[i].ts;
      const heldHours = Math.floor((nowTs - heldSinceTs) / 3600);
      regimeDuration = `${current.label}, held for ${Math.floor(heldHours / 24)}d ${heldHours % 24}h`;
    }

    const state = loadSchedulerState(db, mode);
    const dayStartTs = utcDayKey(nowTs) * 86400;
    const claudeCallsToday = getClaudeCallsToday(db, mode, dayStartTs, dayStartTs + 86400);
    const openPositions = state ? state.openPositions : [];
    const totalRiskPctUsed = openPositions.reduce((sum, p) => sum + p.riskPct, 0);

    const pending = getPendingConfigVersion(db, mode);
    const superseded = getMostRecentSupersededConfigVersion(db, mode);
    const active = getActiveConfigVersion(db, mode);

    const benchmarkInputs = getBenchmarkInputsForHowItWorks(db, mode);
    const benchmark = benchmarkInputs
      ? computeBenchmarkComparisonForHowItWorks({ botSeries: benchmarkInputs.botSeries, btcSeries: benchmarkInputs.btcSeries })
      : null;

    const steps = [
      {
        title: 'Check the market',
        plain: 'Gets the latest finished price candle for each of the 6 coins. A half-formed candle is never used.',
        technical: 'Fetches completed 1h/4h/1d candles per watchlist coin; a coin is skipped for the hour if its data looks wrong.',
        rightNow: 'not tracked yet',
      },
      {
        title: 'Decide what kind of market it is',
        plain: 'Sorts the market into Danger, Rising, Falling, or Choppy, checked in that order.',
        technical: `Danger (risk_off): volatility rank > ${REGIME_THRESHOLDS.riskOffVolatilityRankPct}th percentile or BTC 24h change <= ${REGIME_THRESHOLDS.riskOffBtc24hChangePct}%. Rising (trend_up): BTC above daily EMA200, ADX > ${REGIME_THRESHOLDS.trendUpAdx}, breadth >= ${REGIME_THRESHOLDS.trendUpBreadthPct}%.`,
        rightNow: regimeDuration,
      },
      {
        title: 'Look for trade ideas',
        plain: 'Each market mood has its own setups. Only the ones that suit the current mood and are switched on get checked.',
        technical: `Fee check: typical 4h move must be >= ${DEFAULT_RISK_CONFIG.feeViabilityMultiple}x the round-trip fee (${DEFAULT_RISK_CONFIG.roundTripFeePct}%).`,
        rightNow: 'not tracked yet',
      },
      {
        title: 'Ask Claude',
        plain: 'Claude can take, skip, or resize a trade idea, within set limits. If it fails to answer, nothing happens that hour.',
        technical: `Model: ${DEFAULT_RISK_CONFIG.claudeModel}.`,
        rightNow: `${claudeCallsToday} calls today`,
      },
      {
        title: 'Safety checks',
        plain: 'Each trade risks a small, fixed slice of the balance, and there are hard caps on how many trades can be open at once.',
        technical: `Risk per trade ${(DEFAULT_RISK_CONFIG.baseRiskPct * 100).toFixed(1)}%, max ${DEFAULT_RISK_CONFIG.maxOpenPositions} open positions, max ${(DEFAULT_RISK_CONFIG.maxTotalRiskPct * 100).toFixed(1)}% total risk.`,
        rightNow: `${(totalRiskPctUsed * 100).toFixed(2)}% at risk across ${openPositions.length} trade${openPositions.length === 1 ? '' : 's'}`,
      },
      {
        title: 'Place the trade',
        plain: 'Paper mode uses a pretend order at the real Kraken price. Live mode places a real order.',
        technical: 'Paper: simulated fill with real fees/slippage. Live: real Kraken limit order, stop-loss placed immediately on fill.',
        rightNow: `${mode === 'paper' ? 'Paper mode' : 'Live mode'}`,
      },
      {
        title: 'Look after open trades',
        plain: 'Every trade has a safety net from the moment it opens. Trend trades let that safety net follow the price up.',
        technical: 'Trailing stop recomputed each cycle, tightened only, never loosened.',
        rightNow: `${openPositions.length} open position${openPositions.length === 1 ? '' : 's'}`,
      },
      {
        title: 'Review and suggest changes',
        plain: 'A proposed change to the strategy waits for your approval before it takes effect.',
        technical: `Active config version: ${active.id ?? 'default'}.`,
        rightNow: pending ? `1 suggestion waiting (v${pending.id})` : 'No pending proposal',
      },
      {
        title: "Check it's worth running",
        plain: 'The bot is compared against just holding Bitcoin and just holding cash.',
        technical: 'Return and worst drawdown computed from the real trade history and real BTC daily closes.',
        rightNow: benchmark
          ? `bot ${(benchmark.bot.returnPct * 100).toFixed(1)}% vs holding BTC ${(benchmark.btc.returnPct * 100).toFixed(1)}%`
          : 'not enough history yet',
      },
    ];

    res.json({
      steps,
      atAGlance: {
        mode, configVersion: active.id ?? 'default', claudeModel: DEFAULT_RISK_CONFIG.claudeModel,
        marketMood: current ? current.label : 'unknown',
      },
      optionalFeatures: [
        { name: 'Regime buffer (wait before changing mood)', status: 'Off' },
        { name: "Per-coin trend state", status: 'Off' },
        { name: 'Candidate quality score', status: 'Off' },
        { name: 'Tighten stops in risk_off', status: 'Off' },
        { name: "Stale-trade exit", status: 'Off' },
      ],
      changedInLatest: superseded ? null : 'No changes logged yet.',
      diffConfigs: superseded ? { active: active.config, previous: superseded.config } : null,
    });
  });

  app.get('/api/claude-usage', (req, res) => {
    const mode = req.query.mode || 'paper';
    const nowTs = Math.floor(Date.now() / 1000);
    const dayStartTs = utcDayKey(nowTs) * 86400;
    const monthStartTs = getMonthStartTs(nowTs);

    const today = getDecisionCallCounts(db, mode, dayStartTs, dayStartTs + 86400);
    const thisMonth = getDecisionCallCounts(db, mode, monthStartTs, nowTs + 1);

    res.json({
      provider: 'claude-cli (Pro plan)',
      cyclesToday: 24,
      callsToday: today.realCalls,
      callsThisMonth: thisMonth.realCalls,
      fallbacksThisMonth: thisMonth.fallbacks,
    });
  });

  return app;
}

module.exports = { createApp };
