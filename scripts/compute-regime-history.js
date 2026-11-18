'use strict';
const { openDb, getCandles } = require('../src/data/db');
const { computeRegimeSeries } = require('../src/engine/regime');

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'LINK'];
const HOUR = 3600;
const SIX_MONTHS_SECONDS = 186 * 24 * HOUR;

function main() {
  const db = openDb();
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const fromTs = nowHour - SIX_MONTHS_SECONDS;

  // BTC's daily EMA200 needs well over 200 days of history behind the window start,
  // and our real DB has BTC history back to 2014, so pull everything available.
  const btcDaily = getCandles(db, 'BTC', '1d', 0, nowHour);
  const btc4h = getCandles(db, 'BTC', '4h', 0, nowHour);
  const watchlistBy4h = {};
  for (const coin of COINS) {
    watchlistBy4h[coin] = getCandles(db, coin, '4h', 0, nowHour).map((c) => ({ ts: c.ts, close: c.close }));
  }

  const series = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
  const windowed = series.filter((p) => p.ts >= fromTs);

  console.log(`Regime history: ${windowed.length} 4h points from ${new Date(fromTs * 1000).toISOString()} to ${new Date(nowHour * 1000).toISOString()}\n`);

  // Collapse consecutive same-label runs into readable ranges.
  let runStart = null, runLabel = null, runCount = 0;
  const flush = (endTs) => {
    if (runLabel === null) return;
    const days = ((endTs - runStart) / (24 * HOUR)).toFixed(1);
    console.log(`  ${new Date(runStart * 1000).toISOString().slice(0, 10)} -> ${new Date(endTs * 1000).toISOString().slice(0, 10)} (${days}d, ${runCount} bars): ${runLabel}`);
  };
  for (const point of windowed) {
    if (point.label !== runLabel) {
      flush(point.ts);
      runStart = point.ts; runLabel = point.label; runCount = 0;
    }
    runCount += 1;
  }
  if (windowed.length > 0) flush(windowed[windowed.length - 1].ts + 4 * HOUR);

  const distribution = {};
  for (const point of windowed) distribution[point.label] = (distribution[point.label] || 0) + 1;
  console.log('\nTime spent per regime:');
  for (const [label, count] of Object.entries(distribution)) {
    console.log(`  ${label}: ${((count / windowed.length) * 100).toFixed(1)}% (${count} bars)`);
  }

  const latest = windowed[windowed.length - 1];
  if (latest) {
    console.log(`\nCurrent regime: ${latest.label}`);
    console.log(`  metrics: ${JSON.stringify(latest.metrics, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))}`);
  }
}

main();
