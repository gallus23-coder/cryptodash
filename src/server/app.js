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
    const { mode, from, to, regime, limit } = req.query;
    const rows = getCycleLogFiltered(db, {
      mode: mode || 'paper',
      from: from !== undefined ? Number(from) : undefined,
      to: to !== undefined ? Number(to) : undefined,
      regime,
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

  const { getRegimeHistory } = require('../data/db');
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
    res.json(latest ? { label: latest.label, ts: latest.ts, metrics: latest.metrics } : { label: null, ts: null, metrics: null });
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

  app.get('/api/strategy', (req, res) => {
    const mode = req.query.mode || 'paper';
    const nowTs = Math.floor(Date.now() / 1000);

    const setups = Object.entries(SETUPS).map(([name, mod]) => ({
      name, ranges: mod.RANGES,
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

  function validateDraft(body) {
    const { riskLevel, disabledSetups, rangeOverrides } = body || {};
    if (!['cautious', 'normal', 'bold'].includes(riskLevel)) return { error: `invalid riskLevel: ${riskLevel}` };
    const validSetupNames = Object.keys(SETUPS);
    for (const name of disabledSetups || []) {
      if (!validSetupNames.includes(name)) return { error: `unknown setup in disabledSetups: ${name}` };
    }
    return { draft: { riskLevel, disabledSetups: disabledSetups || [], rangeOverrides: rangeOverrides || {} } };
  }

  app.post('/api/config/draft', (req, res) => {
    const { error, draft } = validateDraft(req.body);
    if (error) return res.status(400).json({ error });
    res.json(draft);
  });

  app.post('/api/config/draft/backtest', (req, res) => {
    const { error, draft } = validateDraft(req.body);
    if (error) return res.status(400).json({ error });

    const scaledConfig = applyRiskLevel(DEFAULT_RISK_CONFIG, draft.riskLevel);
    const setupsByRegimeForDraft = Object.fromEntries(
      Object.entries(SETUPS_BY_REGIME).map(([regime, names]) => [regime, names.filter((n) => !draft.disabledSetups.includes(n))])
    );

    const nowTs = Math.floor(Date.now() / 1000);
    const result = runBacktest(db, scaledConfig, nowTs - 90 * 86400, setupsByRegimeForDraft);

    const bySetupTrades = {};
    for (const trade of result.state.closedTrades) {
      (bySetupTrades[trade.setup] = bySetupTrades[trade.setup] || []).push(trade);
    }
    const bySetup = Object.fromEntries(Object.entries(bySetupTrades).map(([name, trades]) => [name, computeExpectancy(trades)]));

    res.json({
      draft,
      backtestSummary: {
        totalTrades: result.state.closedTrades.length,
        finalBalance: result.state.balance,
        bySetup,
      },
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
