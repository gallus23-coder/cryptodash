'use strict';
const cron = require('node-cron');
const { openDb } = require('./src/data/db');
const { createRestClient } = require('./src/kraken/rest');
const { runCycle } = require('./src/scheduler/cycle');

const MODE = 'paper';

const db = openDb();
const krakenClient = createRestClient({});

cron.schedule('30 0 * * * *', async () => {
  const result = await runCycle(db, krakenClient, MODE);
  console.log(`[${new Date().toISOString()}] cycle result:`, JSON.stringify(result));
});

console.log(`Scheduler started (mode=${MODE}). Waiting for the next hourly cycle (xx:00:30 UTC)...`);
