// binance.js
'use strict';

const BASE = 'https://api.binance.com';

// Hardcoded map for known coins. Covers all coins in the default watchlist.
// New coins not in this map fall back to cgSymbol + 'USDT' from CoinGecko metadata.
const SYMBOL_MAP = {
  bitcoin:       'BTCUSDT',
  ethereum:      'ETHUSDT',
  binancecoin:   'BNBUSDT',
  ripple:        'XRPUSDT',
  cardano:       'ADAUSDT',
  solana:        'SOLUSDT',
  'avalanche-2': 'AVAXUSDT',
  chainlink:     'LINKUSDT',
};

// Fetch 24h ticker for one Binance symbol.
// Relevant fields: lastPrice (string), priceChangePercent (string), quoteVolume (string, USDT).
async function fetchTicker(symbol) {
  const res = await fetch(`${BASE}/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status} for ${symbol}`);
  return res.json();
}

// Fetch up to `limit` 1h candles starting from `startTime` (unix ms).
async function _fetchKlines(symbol, startTime, limit = 1000) {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=1h` +
    `&startTime=${startTime}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status} for ${symbol}`);
  return res.json();
}

// Convert a Binance kline array to a candles-table row.
// k[0]=openTime k[1]=open k[2]=high k[3]=low k[4]=close k[7]=quoteAssetVolume(USDT)
function _klineToRow(symbol, k) {
  return {
    symbol,
    open_time: k[0],
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[7]),
  };
}

// Backfill 90 days of 1h candles. 3 requests per coin (2160 candles / 1000 per page).
// db is the db.js module exports object.
async function backfillCandles(symbol, db) {
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  let startTime = Date.now() - NINETY_DAYS_MS;
  let total = 0;
  while (true) {
    const klines = await _fetchKlines(symbol, startTime);
    if (!klines.length) break;
    db.insertCandles(klines.map(k => _klineToRow(symbol, k)));
    total += klines.length;
    if (klines.length < 1000) break;
    startTime = klines[klines.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 200)); // be polite to Binance
  }
  console.log(`[binance] backfilled ${total} candles for ${symbol}`);
}

// Fetch candles since the last stored open_time. Falls back to backfillCandles if no history.
// db is the db.js module exports object.
async function fetchNewCandles(symbol, db) {
  const lastTime = db.getLastCandleTime(symbol);
  if (!lastTime) return backfillCandles(symbol, db);
  const klines = await _fetchKlines(symbol, lastTime + 1);
  if (!klines.length) return;
  db.insertCandles(klines.map(k => _klineToRow(symbol, k)));
  console.log(`[binance] fetched ${klines.length} new candles for ${symbol}`);
}

module.exports = { SYMBOL_MAP, fetchTicker, backfillCandles, fetchNewCandles };
