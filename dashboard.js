'use strict';
const { openDb } = require('./src/data/db');
const { getDashboardPassword } = require('./src/config/env');
const { createApp } = require('./src/server/app');

const db = openDb();
const password = getDashboardPassword();
if (!password) {
  console.warn('WARNING: no DASHBOARD_PASSWORD configured — the API is unauthenticated. Set it in ~/.config/cryptodash/env before exposing this beyond localhost.');
}

const app = createApp(db, { password });
app.listen(3000, '127.0.0.1', () => {
  console.log('Dashboard API listening on http://127.0.0.1:3000 (decisions endpoints only — Charts/Strategy tabs are later milestone-7 parts)');
});
