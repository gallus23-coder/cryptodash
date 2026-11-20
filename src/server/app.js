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
    res.json({
      trades: getTradesByCoin(db, mode, req.params.coin, fromTs, toTs),
      candidates: getCandidatesByCoin(db, mode, req.params.coin, fromTs, toTs),
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
    res.json(latest ? { label: latest.label, ts: latest.ts } : { label: null, ts: null });
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

  return app;
}

module.exports = { createApp };
