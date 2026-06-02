// binance.js
'use strict';

const BASE_URL = 'https://api.binance.com';

// Hardcoded map for known coins. New coins fall back to cgSymbol+USDT from CoinGecko metadata.
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
// Relevant fields: lastPrice, priceChangePercent, quoteVolume (all strings, USDT).
async function fetchTicker(symbol) {
  const res = await fetch(`${BASE_URL}/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status} for ${symbol}`);
  return res.json();
}

// Fetch up to `limit` klines for symbol+interval starting at startTime (unix ms).
async function _fetchKlines(symbol, interval, startTime, limit = 1000) {
  const url = `${BASE_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}` +
    `&startTime=${startTime}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status} for ${symbol}`);
  return res.json();
}

// Convert a Binance kline array to a candles-table row.
// k[0]=openTime  k[1]=open  k[2]=high  k[3]=low  k[4]=close  k[7]=quoteAssetVolume(USDT)
function _klineToRow(coin_id, interval, k) {
  return {
    coin_id,
    interval,
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[7]),
  };
}

// Backfill candles going back lookbackMs from now.
// Typical calls:
//   backfillCandles(id, symbol, '1h', 90*24*3600*1000, db)  → ~2160 candles, 3 pages
//   backfillCandles(id, symbol, '1m',  7*24*3600*1000, db)  → ~10080 candles, 11 pages
// Caller must add inter-coin delay for 1m backfills (2s recommended).
async function backfillCandles(coin_id, symbol, interval, lookbackMs, db) {
  let startTime = Date.now() - lookbackMs;
  let total = 0;
  while (true) {
    const klines = await _fetchKlines(symbol, interval, startTime);
    if (!klines.length) break;
    db.insertCandles(klines.map(k => _klineToRow(coin_id, interval, k)));
    total += klines.length;
    if (klines.length < 1000) break;
    startTime = klines[klines.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 200)); // be polite to Binance
  }
  console.log(`[binance] backfilled ${total} ${interval} candles for ${symbol}`);
}

// Fetch candles since the last stored time. Falls back to full backfill if no history.
async function fetchNewCandles(coin_id, symbol, interval, db) {
  const lastTime = db.getLastCandleTime(coin_id, interval);
  if (!lastTime) {
    const lookback = interval === '1h' ? 90 * 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
    return backfillCandles(coin_id, symbol, interval, lookback, db);
  }
  const klines = await _fetchKlines(symbol, interval, lastTime + 1);
  if (!klines.length) return;
  db.insertCandles(klines.map(k => _klineToRow(coin_id, interval, k)));
  console.log(`[binance] fetched ${klines.length} new ${interval} candles for ${symbol}`);
}

module.exports = { SYMBOL_MAP, fetchTicker, backfillCandles, fetchNewCandles };
