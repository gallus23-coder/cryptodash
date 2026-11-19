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

  return app;
}

module.exports = { createApp };
