'use strict';
const { upsertCandles, getCandles } = require('./db');
const { filterOutlierCandles, aggregateCandles } = require('./candles');

const HOUR = 3600, FOUR_H = 4 * HOUR, DAY = 24 * HOUR;
const REBUILD_WINDOW_SECONDS = 14 * DAY;

async function ingestCoin(db, krakenClient, coin, altname, now = Date.now()) {
  const { candles } = await krakenClient.getOhlc(altname, { interval: 60 });
  const closedRows = candles.filter((c) => c.closed).map((c) => ({
    ts: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, trades: c.count,
  }));
  const { candles: clean, dropped } = filterOutlierCandles(closedRows);
  const inserted = upsertCandles(db, clean.map((c) => ({ coin, timeframe: '1h', ...c })));

  const nowHour = Math.floor(now / 1000 / HOUR) * HOUR;
  const rebuildFrom = nowHour - REBUILD_WINDOW_SECONDS;
  const hourly = getCandles(db, coin, '1h', rebuildFrom, nowHour);

  const fourHourRows = aggregateCandles(hourly, FOUR_H, { nowTs: nowHour }).filter((c) => c.closed);
  const built4h = upsertCandles(db, fourHourRows.map((c) => ({ coin, timeframe: '4h', ...c })));
  const dailyRows = aggregateCandles(hourly, DAY, { nowTs: nowHour }).filter((c) => c.closed);
  const built1d = upsertCandles(db, dailyRows.map((c) => ({ coin, timeframe: '1d', ...c })));

  return { coin, inserted, dropped, built4h, built1d };
}

async function ingestAllCoins(db, krakenClient, coinMap, now = Date.now()) {
  const results = [];
  for (const [coin, altname] of Object.entries(coinMap)) {
    results.push(await ingestCoin(db, krakenClient, coin, altname, now));
  }
  return results;
}

module.exports = { ingestCoin, ingestAllCoins };
