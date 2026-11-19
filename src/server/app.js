'use strict';
const express = require('express');

function createApp(db, { password } = {}) {
  const app = express();
  app.use(express.json());

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
      decision: getDecisionByCandidateId(db, candidate.id),
      trade: getTradeByCandidateId(db, candidate.id),
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

  return app;
}

module.exports = { createApp };
