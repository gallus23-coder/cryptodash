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

  return app;
}

module.exports = { createApp };
