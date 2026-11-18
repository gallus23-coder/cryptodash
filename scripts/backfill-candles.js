'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDb, upsertCandles, getLastCandleTime, getExistingTimes, getCandles } = require('../src/data/db');
const { parseOhlcvtCsv, aggregateCandles, findGapHours, buildCandlesFromTrades } = require('../src/data/candles');
const { extractSpecificFiles, findCsvFile } = require('../src/data/ohlcvtImport');
const { createRestClient } = require('../src/kraken/rest');

const COINS = {
  BTC: 'XBTGBP', ETH: 'ETHGBP', SOL: 'SOLGBP',
  XRP: 'XRPGBP', ADA: 'ADAGBP', LINK: 'LINKGBP',
};
const HOUR = 3600;
const SIX_MONTHS_SECONDS = 186 * 24 * HOUR;

async function importCsvZips(db, zipPaths) {
  for (const zipPath of zipPaths) {
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-'));
    const wantedFiles = Object.values(COINS).map((altname) => `${altname}_60.csv`);
    console.log(`Extracting ${wantedFiles.length} files from ${zipPath} -> ${destDir}`);
    extractSpecificFiles(zipPath, wantedFiles, destDir);
    for (const [coin, altname] of Object.entries(COINS)) {
      const csvPath = findCsvFile(destDir, altname, 60);
      const csvText = fs.readFileSync(csvPath, 'utf8');
      const { rows, skipped } = parseOhlcvtCsv(csvText);
      const dbRows = rows.map((r) => ({ coin, timeframe: '1h', ...r }));
      const count = upsertCandles(db, dbRows);
      console.log(`  ${coin}: imported ${count} rows from ${path.basename(csvPath)} (${skipped} skipped)`);
    }
  }
}

async function pullRecentFromRest(db, client) {
  for (const [coin, altname] of Object.entries(COINS)) {
    const { candles } = await client.getOhlc(altname, { interval: 60 });
    const closedRows = candles.filter((c) => c.closed).map((c) => ({
      coin, timeframe: '1h', ts: c.time,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, trades: c.count,
    }));
    const count = upsertCandles(db, closedRows);
    console.log(`${coin}: imported ${count} closed candles from REST OHLC`);
  }
}

async function bridgeGaps(db, client, csvEndByCoin) {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  for (const [coin, altname] of Object.entries(COINS)) {
    const csvEnd = csvEndByCoin[coin]; // last ts from the CSV import, captured before the REST pull ran
    const restStart = getFirstRestTs(db, coin, nowHour);
    if (csvEnd === null || restStart === null || csvEnd + HOUR >= restStart) continue; // no gap to bridge

    console.log(`${coin}: bridging gap ${new Date(csvEnd * 1000).toISOString()} -> ${new Date(restStart * 1000).toISOString()}`);
    let since = String(csvEnd * 1_000_000_000); // Kraken 'since' is nanoseconds
    let lastSince = null;
    const rangeEnd = restStart;
    while (since !== lastSince) {
      const { trades, last } = await client.getTrades(altname, { since });
      if (trades.length === 0) break;
      const candles = buildCandlesFromTrades(trades, rangeEnd);
      if (candles.length > 0) {
        upsertCandles(db, candles.map((c) => ({ coin, timeframe: '1h', ...c })));
      }
      lastSince = since;
      since = last;
      if (trades[trades.length - 1].time >= rangeEnd) break;
    }
  }
}

function getFirstRestTs(db, coin, nowHour) {
  const existing = getExistingTimes(db, coin, '1h', nowHour - 720 * HOUR, nowHour);
  return existing.length > 0 ? existing[0] : null;
}

function reportGaps(db) {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const lastClosedHour = nowHour - HOUR; // nowHour itself is still forming — it can never have a row yet
  const fromTs = lastClosedHour - SIX_MONTHS_SECONDS;
  console.log(`\nGap report for the last 6 months (${new Date(fromTs * 1000).toISOString()} -> ${new Date(lastClosedHour * 1000).toISOString()}):`);
  for (const coin of Object.keys(COINS)) {
    const existing = getExistingTimes(db, coin, '1h', fromTs, lastClosedHour);
    const gaps = findGapHours(existing, fromTs, lastClosedHour, HOUR);
    const expected = Math.floor((lastClosedHour - fromTs) / HOUR) + 1;
    console.log(`  ${coin}: ${existing.length}/${expected} hours present, ${gaps.length} missing`);
    if (gaps.length > 0 && gaps.length <= 20) {
      console.log(`    missing: ${gaps.map((ts) => new Date(ts * 1000).toISOString()).join(', ')}`);
    } else if (gaps.length > 20) {
      console.log(`    missing (first 10): ${gaps.slice(0, 10).map((ts) => new Date(ts * 1000).toISOString()).join(', ')} ...`);
    }
  }
}

function buildHigherTimeframes(db) {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const fromTs = nowHour - SIX_MONTHS_SECONDS;
  for (const coin of Object.keys(COINS)) {
    const hourly = getCandles(db, coin, '1h', fromTs, nowHour);
    for (const [timeframe, seconds] of [['4h', 4 * HOUR], ['1d', 24 * HOUR]]) {
      const built = aggregateCandles(hourly, seconds).filter((c) => c.closed);
      upsertCandles(db, built.map((c) => ({ coin, timeframe, ...c })));
      console.log(`${coin}: built ${built.length} ${timeframe} candles`);
    }
  }
}

async function main() {
  const zipPaths = process.argv.slice(2);
  if (zipPaths.length === 0) {
    console.error('Usage: node scripts/backfill-candles.js <zip1> [<zip2> ...]');
    process.exit(1);
  }
  const db = openDb();
  const client = createRestClient({});

  await importCsvZips(db, zipPaths);
  // Capture each coin's last CSV-era ts *before* the REST pull extends the DB's
  // max ts for that coin — bridgeGaps needs the CSV boundary, not the post-pull one.
  const csvEndByCoin = {};
  for (const coin of Object.keys(COINS)) csvEndByCoin[coin] = getLastCandleTime(db, coin, '1h');

  await pullRecentFromRest(db, client);
  await bridgeGaps(db, client, csvEndByCoin);
  buildHigherTimeframes(db);
  reportGaps(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
