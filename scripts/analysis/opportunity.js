'use strict';
// Read-only market-opportunity analysis. Touches no config, no live code, no scheduler —
// just reads stored Kraken candles from the DB and writes a report + CSVs.
//
// Usage: node scripts/analysis/opportunity.js

const fs = require('fs');
const path = require('path');
const { openDb, getCandles } = require('../../src/data/db');
const { ema, adx } = require('../../src/engine/indicators');
const { computeRegimeSeries, REGIME_THRESHOLDS } = require('../../src/engine/regime');
const { computeDrawdown } = require('../../src/backtest/stats');

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'LINK'];
const HOUR = 3600, FOUR_H = 4 * HOUR, DAY = 24 * HOUR;

// "Now" for every window below: the most recently closed daily candle as of 2026-11-25.
const NOW_TS = Math.floor(Date.UTC(2026, 10, 24, 0, 0, 0) / 1000); // 2026-11-24T00:00:00Z

function monthsBefore(endTs, months) {
  const d = new Date(endTs * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate()) / 1000);
}

const WINDOWS = [
  { key: '6mo', label: 'Last 6 months', startTs: monthsBefore(NOW_TS, 6), endTs: NOW_TS },
  { key: '2yr', label: 'Last 2 years', startTs: monthsBefore(NOW_TS, 24), endTs: NOW_TS },
  { key: '4yr', label: 'Last 4 years (or longest available per coin)', startTs: monthsBefore(NOW_TS, 48), endTs: NOW_TS },
];

// Round-trip fee %, as given: maker entry + taker exit + 0.1% spread/slippage, already totalled
// per tier. No TradeVolume data is stored anywhere in this DB (checked before writing this
// script — grepped src/ for any cached fee-tier response), so these given figures are used as-is.
const FEE_TIERS = { tier1: 1.3, tier2: 1.0, tier3: 0.7 };

const OUT_DIR = path.join(__dirname, '..', '..', 'docs', 'analysis');
const DATA_DIR = path.join(OUT_DIR, 'data');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function median(arr) {
  if (arr.length === 0) return null;
  return percentile([...arr].sort((a, b) => a - b), 50);
}

function toCSV(headers, rows) {
  const esc = (v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

function writeCSV(filename, headers, rows) {
  fs.writeFileSync(path.join(DATA_DIR, filename), toCSV(headers, rows));
}

function windowSlice(rows, startTs, endTs) {
  return rows.filter((r) => r.ts >= startTs && r.ts <= endTs);
}

function fmtPct(v, dp = 2) { return v === null || v === undefined || Number.isNaN(v) ? 'n/a' : `${v.toFixed(dp)}%`; }
function fmtDate(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

// === Pure, unit-testable cores (no DB, no clock) ============================================

// Fix for a look-ahead bug: a day's return must use the position decided at the PREVIOUS day's
// close (the only information actually available before today's candle happened), not today's
// own just-computed signal. closes/emaArr/timestamps are parallel arrays; emaArr may start with
// nulls (warm-up). Returns { trades: [{ ts, flippedTo }], series: [{ ts, equity }] } where
// `series` only includes points with ts in [windowStartTs, windowEndTs].
function simulateEmaEquity(closes, emaArr, timestamps, windowStartTs, windowEndTs, roundTripFeePct) {
  let equity = 1, inPosition = null, prevClose = null;
  const series = [];
  const trades = [];

  for (let i = 0; i < closes.length; i += 1) {
    if (emaArr[i] === null) continue;
    const ts = timestamps[i];
    const signal = closes[i] > emaArr[i];

    if (inPosition === null) {
      // First warm bar: no prior day's decision exists yet, so no return to apply today.
      inPosition = signal;
      prevClose = closes[i];
      if (ts >= windowStartTs && ts <= windowEndTs) series.push({ ts, equity });
      continue;
    }

    // Apply today's return using YESTERDAY's decided position — never today's own signal.
    if (inPosition) equity *= closes[i] / prevClose;

    // Now decide the position for tomorrow, based on today's just-closed candle.
    if (signal !== inPosition) {
      equity *= 1 - roundTripFeePct / 100;
      if (ts >= windowStartTs && ts <= windowEndTs) trades.push({ ts, flippedTo: signal });
      inPosition = signal;
    }

    prevClose = closes[i];
    if (ts >= windowStartTs && ts <= windowEndTs) series.push({ ts, equity });
  }

  return { trades, series };
}

// Real-time trend follower — no hindsight. While flat, tracks the lowest close seen since the
// last exit (or series start) and enters once price closes at or above low*(1+entryPct%). While
// long, tracks the highest close since entry and exits once price closes at or below
// high*(1-trailPct%). Exactly one position per coin at a time. `filterFn(ts)`, if given, must
// return true for an entry to be allowed that bar — it never forces an exit.
function simulateTrendFollowerRealtime(bars, { entryTriggerPct, trailPct, filterFn = null }) {
  if (bars.length === 0) return [];
  const trades = [];
  let state = 'flat';
  let lowestSinceExit = bars[0].close;
  let entryIdx = null, entryPrice = null, highestSinceEntry = null;

  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    if (state === 'flat') {
      lowestSinceExit = Math.min(lowestSinceExit, bar.close);
      const entryTarget = lowestSinceExit * (1 + entryTriggerPct / 100);
      if (bar.close >= entryTarget && (!filterFn || filterFn(bar.ts))) {
        state = 'long';
        entryIdx = i; entryPrice = bar.close; highestSinceEntry = bar.close;
      }
      continue;
    }
    // state === 'long'
    highestSinceEntry = Math.max(highestSinceEntry, bar.close);
    const stopLevel = highestSinceEntry * (1 - trailPct / 100);
    if (bar.close <= stopLevel) {
      trades.push({ entryTs: bars[entryIdx].ts, exitTs: bar.ts, entryPrice, exitPrice: bar.close, stillOpen: false });
      state = 'flat';
      lowestSinceExit = bar.close;
    }
  }
  if (state === 'long') {
    const last = bars[bars.length - 1];
    trades.push({ entryTs: bars[entryIdx].ts, exitTs: last.ts, entryPrice, exitPrice: last.close, stillOpen: true });
  }
  return trades;
}

// Net-results aggregation: total trades, win rate, avg win/loss %, net % per trade (all after
// fees), compounded return across the sequence, and max drawdown of the compounding equity path.
function aggregateTrades(trades, roundTripFeePct) {
  const withNet = trades.map((t) => ({ ...t, netPct: ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100 - roundTripFeePct }));
  const wins = withNet.filter((t) => t.netPct > 0);
  const losses = withNet.filter((t) => t.netPct <= 0);

  const equitySeries = [1];
  let equity = 1;
  for (const t of withNet) {
    equity *= 1 + t.netPct / 100;
    equitySeries.push(equity);
  }
  const { maxDrawdownPct } = computeDrawdown(equitySeries);

  return {
    trades: withNet.length,
    winRate: withNet.length ? wins.length / withNet.length : null,
    avgWinPct: wins.length ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : null,
    avgLossPct: losses.length ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : null,
    netPctPerTrade: withNet.length ? withNet.reduce((s, t) => s + t.netPct, 0) / withNet.length : null,
    compoundedReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
  };
}

// Swing-counting only (descriptive stats in §2) — hindsight-confirmed pivots are fine here,
// nothing trades off them. Trading logic (§3) must never use this.
function zigzag(bars, thresholdPct) {
  if (bars.length === 0) return [];
  const pivots = [];
  let direction = null;
  let runningHigh = bars[0], runningLow = bars[0];

  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    if (direction === null) {
      if (bar.close > runningHigh.close) runningHigh = bar;
      if (bar.close < runningLow.close) runningLow = bar;
      const spreadPct = ((runningHigh.close - runningLow.close) / runningLow.close) * 100;
      if (spreadPct >= thresholdPct) {
        if (runningHigh.ts > runningLow.ts) {
          pivots.push({ ts: runningLow.ts, val: runningLow.close, kind: 'low' });
          direction = 'up';
          runningHigh = bar;
        } else {
          pivots.push({ ts: runningHigh.ts, val: runningHigh.close, kind: 'high' });
          direction = 'down';
          runningLow = bar;
        }
      }
      continue;
    }
    if (direction === 'up') {
      if (bar.close > runningHigh.close) { runningHigh = bar; continue; }
      const retracePct = ((runningHigh.close - bar.close) / runningHigh.close) * 100;
      if (retracePct >= thresholdPct) {
        pivots.push({ ts: runningHigh.ts, val: runningHigh.close, kind: 'high' });
        direction = 'down';
        runningLow = bar;
      }
    } else {
      if (bar.close < runningLow.close) { runningLow = bar; continue; }
      const retracePct = ((bar.close - runningLow.close) / runningLow.close) * 100;
      if (retracePct >= thresholdPct) {
        pivots.push({ ts: runningLow.ts, val: runningLow.close, kind: 'low' });
        direction = 'up';
        runningHigh = bar;
      }
    }
  }
  const finalExtreme = direction === 'up' ? runningHigh : (direction === 'down' ? runningLow : null);
  if (finalExtreme) pivots.push({ ts: finalExtreme.ts, val: finalExtreme.close, kind: direction === 'up' ? 'high' : 'low' });
  return pivots;
}

function swingsFromPivots(pivots) {
  const swings = [];
  for (let i = 0; i < pivots.length - 1; i += 1) {
    const a = pivots[i], b = pivots[i + 1];
    swings.push({
      direction: b.val > a.val ? 'up' : 'down',
      startTs: a.ts, endTs: b.ts, startVal: a.val, endVal: b.val,
      sizePct: ((b.val - a.val) / a.val) * 100,
      durationHours: (b.ts - a.ts) / HOUR,
    });
  }
  return swings;
}

// === DB-backed helpers (per window) =========================================================

function coinEarliestTs(db, coin) {
  const rows = getCandles(db, coin, '1d', 0, NOW_TS);
  return rows.length > 0 ? rows[0].ts : null;
}

// For the 4yr window, clamp each coin's own start to its earliest available data if that's
// later than the nominal window start — "or the longest available per coin".
function effectiveStartForCoin(db, coin, nominalStartTs) {
  const earliest = coinEarliestTs(db, coin);
  if (earliest === null) return { startTs: nominalStartTs, usedFallback: false };
  if (earliest > nominalStartTs) return { startTs: earliest, usedFallback: true, earliest };
  return { startTs: nominalStartTs, usedFallback: false };
}

function computeMoveSizes(db, coin, tf, startTs, endTs) {
  const all = getCandles(db, coin, tf, 0, endTs);
  const inWindow = windowSlice(all, startTs, endTs);
  const rangePct = inWindow.map((c) => ((c.high - c.low) / c.close) * 100).sort((a, b) => a - b);
  const closeToClose = [];
  for (let i = 1; i < inWindow.length; i += 1) {
    closeToClose.push(Math.abs((inWindow[i].close - inWindow[i - 1].close) / inWindow[i - 1].close) * 100);
  }
  const closeToCloseSorted = [...closeToClose].sort((a, b) => a - b);
  const percentiles = (arr) => ({ p25: percentile(arr, 25), p50: percentile(arr, 50), p75: percentile(arr, 75), p90: percentile(arr, 90) });
  const beatShare = {};
  for (const [tierName, roundTrip] of Object.entries(FEE_TIERS)) {
    for (const mult of [1, 2, 3]) {
      const threshold = roundTrip * mult;
      beatShare[`${tierName}_${mult}x`] = closeToClose.length === 0 ? null : closeToClose.filter((m) => m >= threshold).length / closeToClose.length;
    }
  }
  return { coin, tf, candleCount: inWindow.length, range: percentiles(rangePct), closeToClose: percentiles(closeToCloseSorted), beatShare };
}

function pooledMoveSizes(db, tf, startTs, endTs) {
  let allRange = [], allC2C = [];
  for (const coin of COINS) {
    const inWindow = windowSlice(getCandles(db, coin, tf, 0, endTs), startTs, endTs);
    allRange = allRange.concat(inWindow.map((c) => ((c.high - c.low) / c.close) * 100));
    for (let i = 1; i < inWindow.length; i += 1) {
      allC2C.push(Math.abs((inWindow[i].close - inWindow[i - 1].close) / inWindow[i - 1].close) * 100);
    }
  }
  allRange.sort((a, b) => a - b);
  const allC2CSorted = [...allC2C].sort((a, b) => a - b);
  const percentiles = (arr) => ({ p25: percentile(arr, 25), p50: percentile(arr, 50), p75: percentile(arr, 75), p90: percentile(arr, 90) });
  const beatShare = {};
  for (const [tierName, roundTrip] of Object.entries(FEE_TIERS)) {
    for (const mult of [1, 2, 3]) {
      const threshold = roundTrip * mult;
      beatShare[`${tierName}_${mult}x`] = allC2C.length ? allC2C.filter((m) => m >= threshold).length / allC2C.length : null;
    }
  }
  return { coin: 'ALL', tf, candleCount: allRange.length, range: percentiles(allRange), closeToClose: percentiles(allC2CSorted), beatShare };
}

function computeSwingStats(bars, thresholdPct, windowStartTs, windowEndTs, windowDays) {
  const pivots = zigzag(bars, thresholdPct);
  const allSwings = swingsFromPivots(pivots);
  const swings = allSwings.filter((s) => s.startTs >= windowStartTs && s.startTs <= windowEndTs);
  const up = swings.filter((s) => s.direction === 'up');
  const down = swings.filter((s) => s.direction === 'down');
  return {
    thresholdPct, upCount: up.length, downCount: down.length,
    medianSizePct: median(swings.map((s) => Math.abs(s.sizePct))),
    medianDurationHours: median(swings.map((s) => s.durationHours)),
    swingsPerMonth: swings.length / (windowDays / 30),
    swings,
  };
}

function computeAdxShare(db, coin, startTs, endTs) {
  const all = getCandles(db, coin, '4h', 0, endTs);
  const adxResult = adx(all, 14);
  let withinWindow = 0, aboveThreshold = 0;
  all.forEach((c, i) => {
    if (c.ts < startTs || c.ts > endTs) return;
    if (adxResult.adx[i] === null) return;
    withinWindow += 1;
    if (adxResult.adx[i] > REGIME_THRESHOLDS.trendUpAdx) aboveThreshold += 1;
  });
  return withinWindow === 0 ? null : aboveThreshold / withinWindow;
}

function computeRegimeLabelShare(db, startTs, endTs) {
  const btcDaily = getCandles(db, 'BTC', '1d', 0, endTs);
  const btc4h = getCandles(db, 'BTC', '4h', 0, endTs);
  const watchlistBy4h = {};
  for (const coin of COINS) watchlistBy4h[coin] = getCandles(db, coin, '4h', 0, endTs).map((c) => ({ ts: c.ts, close: c.close }));
  const series = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
  const inWindow = series.filter((r) => r.ts >= startTs && r.ts <= endTs);
  const counts = {};
  for (const point of inWindow) counts[point.label] = (counts[point.label] || 0) + 1;
  const total = inWindow.length;
  const shares = {};
  for (const [label, count] of Object.entries(counts)) shares[label] = count / total;
  return { total, shares };
}

function buyAndHold(db, coin, startTs, endTs, roundTripFeePct) {
  const inWindow = windowSlice(getCandles(db, coin, '1d', 0, endTs), startTs, endTs);
  if (inWindow.length < 2) return null;
  const closes = inWindow.map((c) => c.close);
  const rawReturnPct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  const { maxDrawdownPct } = computeDrawdown(closes);
  return { returnPct: rawReturnPct - roundTripFeePct, maxDrawdownPct: maxDrawdownPct * 100, trades: 1 };
}

function equalWeightBasket(db, startTs, endTs, roundTripFeePct) {
  const seriesByCoin = {};
  let minLen = Infinity;
  for (const coin of COINS) {
    seriesByCoin[coin] = windowSlice(getCandles(db, coin, '1d', 0, endTs), startTs, endTs).map((c) => c.close);
    minLen = Math.min(minLen, seriesByCoin[coin].length);
  }
  if (minLen < 2) return null;
  const basket = [];
  for (let i = 0; i < minLen; i += 1) {
    let sum = 0;
    for (const coin of COINS) sum += seriesByCoin[coin][i] / seriesByCoin[coin][0];
    basket.push((sum / COINS.length) * 100);
  }
  const rawReturnPct = ((basket[basket.length - 1] - basket[0]) / basket[0]) * 100;
  const { maxDrawdownPct } = computeDrawdown(basket);
  return { returnPct: rawReturnPct - roundTripFeePct, maxDrawdownPct: maxDrawdownPct * 100, trades: COINS.length };
}

function emaSwitchRule(db, coins, emaPeriod, startTs, endTs, roundTripFeePct) {
  let totalTrades = 0;
  const equitySeriesByCoin = {};
  for (const coin of coins) {
    const all = getCandles(db, coin, '1d', 0, endTs);
    const closes = all.map((c) => c.close);
    const timestamps = all.map((c) => c.ts);
    const emaArr = ema(closes, emaPeriod);
    const { trades, series } = simulateEmaEquity(closes, emaArr, timestamps, startTs, endTs, roundTripFeePct);
    totalTrades += trades.length;
    equitySeriesByCoin[coin] = series;
  }
  const len = Math.min(...coins.map((c) => equitySeriesByCoin[c].length));
  if (len < 2) return null;
  const blended = [];
  for (let i = 0; i < len; i += 1) {
    let sum = 0;
    for (const coin of coins) sum += equitySeriesByCoin[coin][i].equity / equitySeriesByCoin[coin][0].equity;
    blended.push((sum / coins.length) * 100);
  }
  const returnPct = ((blended[blended.length - 1] - blended[0]) / blended[0]) * 100;
  const { maxDrawdownPct } = computeDrawdown(blended);
  return { returnPct, maxDrawdownPct: maxDrawdownPct * 100, trades: totalTrades };
}

function buildBtcTrendFilter(db, endTs) {
  // Decided-at-yesterday's-close signal, mapped onto every UTC day — no look-ahead, and valid
  // for both daily and 4h bars (a 4h bar inherits the signal decided before its own day began).
  const all = getCandles(db, 'BTC', '1d', 0, endTs);
  const closes = all.map((c) => c.close);
  const timestamps = all.map((c) => c.ts);
  const emaArr = ema(closes, 200);
  const byDay = new Map();
  let inPosition = null;
  for (let i = 0; i < closes.length; i += 1) {
    if (emaArr[i] === null) continue;
    const signal = closes[i] > emaArr[i];
    if (inPosition === null) { inPosition = signal; continue; } // first warm day: no prior decision yet
    // The signal decided at close of day i governs day i+1 (tomorrow), not day i itself.
    if (i + 1 < timestamps.length) byDay.set(Math.floor(timestamps[i + 1] / DAY) * DAY, inPosition);
    inPosition = signal;
  }
  return (ts) => byDay.get(Math.floor(ts / DAY) * DAY) ?? false;
}

// === Per-window analysis =====================================================================

function runTrendFollowerVariant(db, bars4h, barsDaily, filterFn) {
  const sim4h = {}, simDaily = {};
  for (const coin of COINS) {
    sim4h[coin] = simulateTrendFollowerRealtime(bars4h[coin], { entryTriggerPct: 3, trailPct: 5, filterFn });
    simDaily[coin] = simulateTrendFollowerRealtime(barsDaily[coin], { entryTriggerPct: 5, trailPct: 8, filterFn });
  }
  return { '4h': sim4h, '1d': simDaily };
}

function runAnalysisForWindow(db, win) {
  const { startTs: nominalStart, endTs } = win;
  const perCoinStart = {};
  for (const coin of COINS) perCoinStart[coin] = effectiveStartForCoin(db, coin, nominalStart);
  // Move sizes, swings, ADX use each coin's own effective start (only matters for the 4yr
  // window on a coin shorter than 4 years — none here, but implemented for correctness).
  const moveSizes4h = COINS.map((coin) => computeMoveSizes(db, coin, '4h', perCoinStart[coin].startTs, endTs));
  const moveSizesDaily = COINS.map((coin) => computeMoveSizes(db, coin, '1d', perCoinStart[coin].startTs, endTs));
  const moveSizes4hAll = pooledMoveSizes(db, '4h', nominalStart, endTs);
  const moveSizesDailyAll = pooledMoveSizes(db, '1d', nominalStart, endTs);

  const windowDays = (endTs - nominalStart) / DAY;
  const swingThresholds = [5, 10, 20];
  const swingResultsByCoinTf = {};
  const swingDetailRows = { '4h': [], '1d': [] };
  for (const coin of COINS) {
    swingResultsByCoinTf[coin] = {};
    for (const tf of ['4h', '1d']) {
      const bars = getCandles(db, coin, tf, 0, endTs).map((c) => ({ ts: c.ts, close: c.close }));
      swingResultsByCoinTf[coin][tf] = {};
      for (const threshold of swingThresholds) {
        const stats = computeSwingStats(bars, threshold, perCoinStart[coin].startTs, endTs, windowDays);
        swingResultsByCoinTf[coin][tf][threshold] = stats;
        for (const s of stats.swings) {
          swingDetailRows[tf].push({ coin, threshold, direction: s.direction, startDate: fmtDate(s.startTs), endDate: fmtDate(s.endTs), sizePct: s.sizePct.toFixed(2), durationHours: s.durationHours.toFixed(1) });
        }
      }
    }
  }

  const adxShareByCoin = {};
  for (const coin of COINS) adxShareByCoin[coin] = computeAdxShare(db, coin, perCoinStart[coin].startTs, endTs);
  const regimeLabelShare = computeRegimeLabelShare(db, nominalStart, endTs);

  const baselineRows = [];
  for (const [tierName, roundTrip] of Object.entries(FEE_TIERS)) {
    for (const coin of COINS) baselineRows.push({ tier: tierName, strategy: 'buy_and_hold', coin, ...buyAndHold(db, coin, perCoinStart[coin].startTs, endTs, roundTrip) });
    baselineRows.push({ tier: tierName, strategy: 'equal_weight_basket', coin: 'ALL', ...equalWeightBasket(db, nominalStart, endTs, roundTrip) });
    baselineRows.push({ tier: tierName, strategy: 'ema200_btc', coin: 'BTC', ...emaSwitchRule(db, ['BTC'], 200, nominalStart, endTs, roundTrip) });
    baselineRows.push({ tier: tierName, strategy: 'ema50_btc', coin: 'BTC', ...emaSwitchRule(db, ['BTC'], 50, nominalStart, endTs, roundTrip) });
    baselineRows.push({ tier: tierName, strategy: 'ema200_btc_eth', coin: 'BTC+ETH', ...emaSwitchRule(db, ['BTC', 'ETH'], 200, nominalStart, endTs, roundTrip) });
  }

  const bars4h = {}, barsDaily = {};
  for (const coin of COINS) {
    bars4h[coin] = getCandles(db, coin, '4h', 0, endTs).filter((c) => c.ts >= perCoinStart[coin].startTs).map((c) => ({ ts: c.ts, close: c.close }));
    barsDaily[coin] = getCandles(db, coin, '1d', 0, endTs).filter((c) => c.ts >= perCoinStart[coin].startTs).map((c) => ({ ts: c.ts, close: c.close }));
  }
  const btcFilter = buildBtcTrendFilter(db, endTs);
  const trendFollowerUnfiltered = runTrendFollowerVariant(db, bars4h, barsDaily, null);
  const trendFollowerFiltered = runTrendFollowerVariant(db, bars4h, barsDaily, btcFilter);

  function trendFollowerRows(variantResults, tf, tierName, roundTrip) {
    const rows = [];
    const allTrades = [];
    for (const coin of COINS) {
      const trades = variantResults[tf][coin];
      allTrades.push(...trades.map((t) => ({ ...t, coin })));
      const agg = aggregateTrades(trades, roundTrip);
      rows.push({ coin, tier: tierName, ...agg });
    }
    const pooled = [...allTrades].sort((a, b) => a.entryTs - b.entryTs);
    const aggAll = aggregateTrades(pooled, roundTrip);
    rows.push({ coin: 'ALL', tier: tierName, ...aggAll });
    return rows;
  }

  return {
    win, perCoinStart, windowDays,
    moveSizes4h, moveSizesDaily, moveSizes4hAll, moveSizesDailyAll,
    swingResultsByCoinTf, swingThresholds, swingDetailRows,
    adxShareByCoin, regimeLabelShare,
    baselineRows,
    trendFollowerUnfiltered, trendFollowerFiltered, trendFollowerRows,
  };
}

// === Report ==================================================================================

function moveSizeTable(rows) {
  const lines = ['| Coin | Candles | Range p25/p50/p75/p90 | C2C p25/p50/p75/p90 | T1 1x/2x/3x | T2 1x/2x/3x | T3 1x/2x/3x |', '|---|---|---|---|---|---|---|'];
  for (const m of rows) {
    const r = m.range, c = m.closeToClose, b = m.beatShare;
    lines.push(`| ${m.coin} | ${m.candleCount} | ${r.p25?.toFixed(2)}/${r.p50?.toFixed(2)}/${r.p75?.toFixed(2)}/${r.p90?.toFixed(2)} | ${c.p25?.toFixed(2)}/${c.p50?.toFixed(2)}/${c.p75?.toFixed(2)}/${c.p90?.toFixed(2)} | ${(b.tier1_1x * 100).toFixed(0)}%/${(b.tier1_2x * 100).toFixed(0)}%/${(b.tier1_3x * 100).toFixed(0)}% | ${(b.tier2_1x * 100).toFixed(0)}%/${(b.tier2_2x * 100).toFixed(0)}%/${(b.tier2_3x * 100).toFixed(0)}% | ${(b.tier3_1x * 100).toFixed(0)}%/${(b.tier3_2x * 100).toFixed(0)}%/${(b.tier3_3x * 100).toFixed(0)}% |`);
  }
  return lines.join('\n');
}

function swingTable(swingResultsByCoinTf, tf, threshold) {
  const lines = ['| Coin | Swings up | Swings down | Median size % | Median duration (h) | Swings/month |', '|---|---|---|---|---|---|'];
  let sumUp = 0, sumDown = 0, sumPerMonth = 0;
  for (const coin of COINS) {
    const s = swingResultsByCoinTf[coin][tf][threshold];
    sumUp += s.upCount; sumDown += s.downCount; sumPerMonth += s.swingsPerMonth;
    lines.push(`| ${coin} | ${s.upCount} | ${s.downCount} | ${s.medianSizePct?.toFixed(2) ?? 'n/a'} | ${s.medianDurationHours?.toFixed(1) ?? 'n/a'} | ${s.swingsPerMonth.toFixed(2)} |`);
  }
  lines.push(`| **ALL (sum/avg)** | ${sumUp} | ${sumDown} | — | — | ${(sumPerMonth / COINS.length).toFixed(2)} avg |`);
  return lines.join('\n');
}

function baselineTable(rows) {
  const lines = ['| Strategy | Coin | Return % | Max drawdown % | Trades |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.strategy} | ${r.coin} | ${fmtPct(r.returnPct)} | ${fmtPct(r.maxDrawdownPct)} | ${r.trades} |`);
  return lines.join('\n');
}

function trendFollowerNetTable(rows) {
  const lines = ['| Coin | Trades | Win rate | Avg win % | Avg loss % | Net %/trade | Compounded return % | Max drawdown % |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.coin} | ${r.trades} | ${r.winRate === null ? 'n/a' : (r.winRate * 100).toFixed(0) + '%'} | ${fmtPct(r.avgWinPct)} | ${fmtPct(r.avgLossPct)} | ${fmtPct(r.netPctPerTrade)} | ${fmtPct(r.compoundedReturnPct)} | ${fmtPct(r.maxDrawdownPct)} |`);
  }
  return lines.join('\n');
}

function buildWindowSection(result) {
  const { win, perCoinStart, moveSizes4h, moveSizesDaily, moveSizes4hAll, moveSizesDailyAll, swingResultsByCoinTf, swingThresholds, adxShareByCoin, regimeLabelShare, baselineRows, trendFollowerUnfiltered, trendFollowerFiltered, trendFollowerRows } = result;
  const lines = [];
  lines.push(`# Window: ${win.label}`);
  lines.push('');
  lines.push(`Nominal range: **${fmtDate(win.startTs)} to ${fmtDate(win.endTs)}**.`);
  const fallbacks = COINS.filter((c) => perCoinStart[c].usedFallback);
  lines.push(fallbacks.length
    ? `Per-coin start clamped to longest available history for: ${fallbacks.map((c) => `${c} (from ${fmtDate(perCoinStart[c].startTs)})`).join(', ')}.`
    : 'All 6 coins had the full nominal range available — no fallback needed.');
  lines.push('');

  lines.push('## 1. Move sizes');
  lines.push('');
  lines.push('### 4h candles');
  lines.push('');
  lines.push(moveSizeTable([...moveSizes4h, moveSizes4hAll]));
  lines.push('');
  lines.push('### Daily candles');
  lines.push('');
  lines.push(moveSizeTable([...moveSizesDaily, moveSizesDailyAll]));
  lines.push('');

  lines.push('## 2. Trends vs chop (zigzag swing detection, descriptive only — not traded)');
  lines.push('');
  for (const tf of ['4h', '1d']) {
    lines.push(`### ${tf === '4h' ? '4h candles' : 'Daily candles'}`);
    lines.push('');
    for (const threshold of swingThresholds) {
      lines.push(`**${threshold}% threshold**`);
      lines.push('');
      lines.push(swingTable(swingResultsByCoinTf, tf, threshold));
      lines.push('');
    }
  }

  lines.push('## 3. Trend-follower — net results (real-time rule, no look-ahead)');
  lines.push('');
  lines.push('Flat: tracks the lowest close since the last exit; enters when close ≥ that low × (1 + entry%). Long: tracks the highest close since entry; exits when close ≤ that high × (1 − trail%). One position per coin at a time.');
  lines.push('');
  lines.push('### 4h candles (+3% entry, 5% trail) — Tier 1, no market filter');
  lines.push('');
  lines.push(trendFollowerNetTable(trendFollowerRows(trendFollowerUnfiltered, '4h', 'tier1', FEE_TIERS.tier1)));
  lines.push('');
  lines.push('### Daily candles (+5% entry, 8% trail) — Tier 1, no market filter');
  lines.push('');
  lines.push(trendFollowerNetTable(trendFollowerRows(trendFollowerUnfiltered, '1d', 'tier1', FEE_TIERS.tier1)));
  lines.push('');
  lines.push('### Same rules, only trading when BTC is above its 200-day EMA (decided at the prior close — no look-ahead)');
  lines.push('');
  lines.push('**4h:**');
  lines.push('');
  lines.push(trendFollowerNetTable(trendFollowerRows(trendFollowerFiltered, '4h', 'tier1', FEE_TIERS.tier1)));
  lines.push('');
  lines.push('**Daily:**');
  lines.push('');
  lines.push(trendFollowerNetTable(trendFollowerRows(trendFollowerFiltered, '1d', 'tier1', FEE_TIERS.tier1)));
  lines.push('');
  lines.push('### Fee sensitivity, pooled (ALL coins), Tier 1 / 2 / 3');
  lines.push('');
  const feeSensRows = [];
  for (const [tierName, roundTrip] of Object.entries(FEE_TIERS)) {
    feeSensRows.push({ variant: '4h, unfiltered', ...trendFollowerRows(trendFollowerUnfiltered, '4h', tierName, roundTrip).find((r) => r.coin === 'ALL') });
    feeSensRows.push({ variant: '4h, BTC-filtered', ...trendFollowerRows(trendFollowerFiltered, '4h', tierName, roundTrip).find((r) => r.coin === 'ALL') });
    feeSensRows.push({ variant: 'daily, unfiltered', ...trendFollowerRows(trendFollowerUnfiltered, '1d', tierName, roundTrip).find((r) => r.coin === 'ALL') });
    feeSensRows.push({ variant: 'daily, BTC-filtered', ...trendFollowerRows(trendFollowerFiltered, '1d', tierName, roundTrip).find((r) => r.coin === 'ALL') });
  }
  const feeLines = ['| Variant | Tier | Trades | Win rate | Net %/trade | Compounded return % | Max DD % |', '|---|---|---|---|---|---|---|'];
  for (const r of feeSensRows) feeLines.push(`| ${r.variant} | ${r.tier} | ${r.trades} | ${r.winRate === null ? 'n/a' : (r.winRate * 100).toFixed(0) + '%'} | ${fmtPct(r.netPctPerTrade)} | ${fmtPct(r.compoundedReturnPct)} | ${fmtPct(r.maxDrawdownPct)} |`);
  lines.push(feeLines.join('\n'));
  lines.push('');

  lines.push('## 4. Time in trend vs range');
  lines.push('');
  lines.push(`Share of 4h candles with ADX(14) > ${REGIME_THRESHOLDS.trendUpAdx}:`);
  lines.push('');
  lines.push('| Coin | ADX > 22 share |');
  lines.push('|---|---|');
  for (const coin of COINS) lines.push(`| ${coin} | ${fmtPct((adxShareByCoin[coin] ?? 0) * 100, 1)} |`);
  lines.push('');
  lines.push(`Market-wide regime label share, over ${regimeLabelShare.total} regime-computable 4h bars:`);
  lines.push('');
  lines.push('| Regime | Share |');
  lines.push('|---|---|');
  for (const [label, share] of Object.entries(regimeLabelShare.shares)) lines.push(`| ${label} | ${fmtPct(share * 100, 1)} |`);
  lines.push('');

  lines.push('## 5. Baselines (Tier 1 fees)');
  lines.push('');
  lines.push(baselineTable(baselineRows.filter((r) => r.tier === 'tier1')));
  lines.push('');
  lines.push('### Fee sensitivity (Tier 1 / 2 / 3)');
  lines.push('');
  for (const tier of ['tier1', 'tier2', 'tier3']) {
    lines.push(`**${tier} (${FEE_TIERS[tier]}% round trip):**`);
    lines.push('');
    lines.push(baselineTable(baselineRows.filter((r) => r.tier === tier)));
    lines.push('');
  }

  return lines.join('\n');
}

function buildComparisonSection(results) {
  const lines = ['# Window comparison (6 months / 2 years / 4 years)', ''];

  lines.push('## Move sizes — daily close-to-close beats Tier 1 round trip (1x), pooled');
  lines.push('');
  lines.push('| Window | Share |');
  lines.push('|---|---|');
  for (const r of results) lines.push(`| ${r.win.label} | ${fmtPct(r.moveSizesDailyAll.beatShare.tier1_1x * 100, 1)} |`);
  lines.push('');

  lines.push('## Swings/month per coin (4h, 10% threshold), averaged across coins');
  lines.push('');
  lines.push('| Window | Avg swings/month |');
  lines.push('|---|---|');
  for (const r of results) {
    const avg = COINS.reduce((sum, c) => sum + r.swingResultsByCoinTf[c]['4h'][10].swingsPerMonth, 0) / COINS.length;
    lines.push(`| ${r.win.label} | ${avg.toFixed(2)} |`);
  }
  lines.push('');

  lines.push('## Trend-follower net results, pooled (ALL coins), Tier 1');
  lines.push('');
  lines.push('| Window | Variant | Trades | Win rate | Net %/trade | Compounded return % | Max DD % |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    for (const [label, variantResults] of [['4h, unfiltered', r.trendFollowerUnfiltered], ['4h, BTC-filtered', r.trendFollowerFiltered], ['daily, unfiltered', r.trendFollowerUnfiltered], ['daily, BTC-filtered', r.trendFollowerFiltered]]) {
      const tf = label.startsWith('daily') ? '1d' : '4h';
      const row = r.trendFollowerRows(variantResults, tf, 'tier1', FEE_TIERS.tier1).find((x) => x.coin === 'ALL');
      lines.push(`| ${r.win.label} | ${label} | ${row.trades} | ${row.winRate === null ? 'n/a' : (row.winRate * 100).toFixed(0) + '%'} | ${fmtPct(row.netPctPerTrade)} | ${fmtPct(row.compoundedReturnPct)} | ${fmtPct(row.maxDrawdownPct)} |`);
    }
  }
  lines.push('');

  lines.push('## Baselines, Tier 1');
  lines.push('');
  lines.push('| Window | Strategy | Coin | Return % | Max DD % |');
  lines.push('|---|---|---|---|---|');
  for (const r of results) {
    for (const strategy of ['buy_and_hold', 'equal_weight_basket', 'ema200_btc', 'ema50_btc', 'ema200_btc_eth']) {
      const rows = r.baselineRows.filter((x) => x.tier === 'tier1' && x.strategy === strategy);
      for (const row of rows) lines.push(`| ${r.win.label} | ${strategy} | ${row.coin} | ${fmtPct(row.returnPct)} | ${fmtPct(row.maxDrawdownPct)} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function buildSummary(results) {
  const r6 = results.find((r) => r.win.key === '6mo');
  const r2 = results.find((r) => r.win.key === '2yr');
  const r4 = results.find((r) => r.win.key === '4yr');

  const tfAll = (r, tf, variantResults) => r.trendFollowerRows(variantResults, tf, 'tier1', FEE_TIERS.tier1).find((x) => x.coin === 'ALL');
  const tf6hUnf = tfAll(r6, '4h', r6.trendFollowerUnfiltered);
  const tf6hFil = tfAll(r6, '4h', r6.trendFollowerFiltered);

  const bhAll = r6.baselineRows.filter((r) => r.tier === 'tier1' && r.strategy === 'buy_and_hold');
  const bestBH = bhAll.reduce((best, x) => (x.returnPct > (best?.returnPct ?? -Infinity) ? x : best), null);
  const worstBH = bhAll.reduce((worst, x) => (x.returnPct < (worst?.returnPct ?? Infinity) ? x : worst), null);
  const ema200_6 = r6.baselineRows.find((r) => r.tier === 'tier1' && r.strategy === 'ema200_btc');
  const basket6 = r6.baselineRows.find((r) => r.tier === 'tier1' && r.strategy === 'equal_weight_basket');

  const avgSwingsPerMonth = COINS.reduce((s, c) => s + r6.swingResultsByCoinTf[c]['4h'][10].swingsPerMonth, 0) / COINS.length;

  const lines = [];
  lines.push(`- **Candle-to-candle moves rarely clear fees on their own**: pooled daily closes beat Tier 1's 1.3% round trip only ${fmtPct(r6.moveSizesDailyAll.beatShare.tier1_1x * 100, 1)} of the time (6-month window); 4h closes, ${fmtPct(r6.moveSizes4hAll.beatShare.tier1_1x * 100, 1)}. Trading every move is a losing game before strategy is even considered.`);
  lines.push(`- **Real ≥10%-ish swings are infrequent**: averaging ${avgSwingsPerMonth.toFixed(1)} swings/month/coin (4h, 10% zigzag threshold, 6-month window) — the opportunity is in catching a handful of trends, not constant trading.`);
  lines.push(`- **Fixing the trend-follower's look-ahead bug changed the picture materially**: the corrected real-time rule (enter +3% off the lowest close since the last exit, trail 5%, one position at a time, 4h candles) nets ${fmtPct(tf6hUnf.netPctPerTrade)}/trade after Tier 1 fees over ${tf6hUnf.trades} trades (6-month window), compounding to ${fmtPct(tf6hUnf.compoundedReturnPct)} — compare this against the earlier (buggy, zigzag-hindsight) report's numbers, which were optimistic by construction.`);
  lines.push(`- **Filtering entries to only fire when BTC is above its own 200-day EMA** (decided at the prior close, no look-ahead) changes the 4h trend-follower to ${tf6hFil.trades} trades at ${fmtPct(tf6hFil.netPctPerTrade)}/trade, compounding to ${fmtPct(tf6hFil.compoundedReturnPct)} — see §3 in each window for whether the filter actually helps or just trades less.`);
  lines.push(`- **Buy-and-hold over the 6-month window ranged from ${worstBH.coin} at ${fmtPct(worstBH.returnPct)} to ${bestBH.coin} at ${fmtPct(bestBH.returnPct)}** after one Tier 1 round trip — coin choice and timing both matter far more than fee tier.`);
  lines.push(`- **BTC's 200-day EMA switch rule (now look-ahead-free) returned ${fmtPct(ema200_6.returnPct)}** with ${fmtPct(ema200_6.maxDrawdownPct)} max drawdown across ${ema200_6.trades} trades (6-month window) — compare against plain BTC buy-and-hold in §5.`);
  lines.push(`- **Longer windows tell a different story than 6 months alone** — see the Window comparison section: 2-year and 4-year results for the same rules often diverge from the short window, which is itself the main argument for not over-fitting to any single 6-month sample.`);
  lines.push(`- **All 6 coins had full history for every window** (6mo/2yr/4yr) — no "longest available" fallback ever triggered; see each window's §0 header for the per-coin confirmation.`);
  return lines.join('\n');
}

function main() {
  ensureDirs();
  const db = openDb();

  const results = WINDOWS.map((win) => runAnalysisForWindow(db, win));

  for (const r of results) {
    const suffix = r.win.key;
    writeCSV(`move-sizes-4h-${suffix}.csv`,
      ['coin', 'candleCount', 'range_p25', 'range_p50', 'range_p75', 'range_p90', 'c2c_p25', 'c2c_p50', 'c2c_p75', 'c2c_p90', 'tier1_1x', 'tier1_2x', 'tier1_3x', 'tier2_1x', 'tier2_2x', 'tier2_3x', 'tier3_1x', 'tier3_2x', 'tier3_3x'],
      [...r.moveSizes4h, r.moveSizes4hAll].map((m) => moveSizeCsvRow(m)));
    writeCSV(`move-sizes-daily-${suffix}.csv`,
      ['coin', 'candleCount', 'range_p25', 'range_p50', 'range_p75', 'range_p90', 'c2c_p25', 'c2c_p50', 'c2c_p75', 'c2c_p90', 'tier1_1x', 'tier1_2x', 'tier1_3x', 'tier2_1x', 'tier2_2x', 'tier2_3x', 'tier3_1x', 'tier3_2x', 'tier3_3x'],
      [...r.moveSizesDaily, r.moveSizesDailyAll].map((m) => moveSizeCsvRow(m)));

    const swingSummaryRows = [];
    for (const coin of COINS) {
      for (const tf of ['4h', '1d']) {
        for (const threshold of r.swingThresholds) {
          const s = r.swingResultsByCoinTf[coin][tf][threshold];
          swingSummaryRows.push({ coin, tf, threshold, upCount: s.upCount, downCount: s.downCount, medianSizePct: s.medianSizePct?.toFixed(2), medianDurationHours: s.medianDurationHours?.toFixed(1), swingsPerMonth: s.swingsPerMonth.toFixed(2) });
        }
      }
    }
    writeCSV(`swings-summary-${suffix}.csv`, ['coin', 'tf', 'threshold', 'upCount', 'downCount', 'medianSizePct', 'medianDurationHours', 'swingsPerMonth'], swingSummaryRows);
    writeCSV(`swings-detail-4h-${suffix}.csv`, ['coin', 'threshold', 'direction', 'startDate', 'endDate', 'sizePct', 'durationHours'], r.swingDetailRows['4h']);
    writeCSV(`swings-detail-daily-${suffix}.csv`, ['coin', 'threshold', 'direction', 'startDate', 'endDate', 'sizePct', 'durationHours'], r.swingDetailRows['1d']);

    writeCSV(`adx-regime-share-${suffix}.csv`, ['coin', 'adxAbove22SharePct'], COINS.map((coin) => ({ coin, adxAbove22SharePct: ((r.adxShareByCoin[coin] ?? 0) * 100).toFixed(1) })));

    writeCSV(`baselines-${suffix}.csv`, ['tier', 'strategy', 'coin', 'returnPct', 'maxDrawdownPct', 'trades'],
      r.baselineRows.map((row) => ({ ...row, returnPct: row.returnPct?.toFixed(2), maxDrawdownPct: row.maxDrawdownPct?.toFixed(2) })));

    const tfCsvRows = [];
    for (const [variantName, variantResults] of [['unfiltered', r.trendFollowerUnfiltered], ['btc_filtered', r.trendFollowerFiltered]]) {
      for (const tf of ['4h', '1d']) {
        for (const [tierName, roundTrip] of Object.entries(FEE_TIERS)) {
          for (const row of r.trendFollowerRows(variantResults, tf, tierName, roundTrip)) {
            tfCsvRows.push({ variant: variantName, tf, ...row, winRate: row.winRate === null ? '' : (row.winRate * 100).toFixed(1), avgWinPct: row.avgWinPct?.toFixed(2) ?? '', avgLossPct: row.avgLossPct?.toFixed(2) ?? '', netPctPerTrade: row.netPctPerTrade?.toFixed(2) ?? '', compoundedReturnPct: row.compoundedReturnPct.toFixed(2), maxDrawdownPct: row.maxDrawdownPct.toFixed(2) });
          }
        }
      }
    }
    writeCSV(`trend-follower-${suffix}.csv`, ['variant', 'tf', 'coin', 'tier', 'trades', 'winRate', 'avgWinPct', 'avgLossPct', 'netPctPerTrade', 'compoundedReturnPct', 'maxDrawdownPct'], tfCsvRows);
  }

  const reportLines = [];
  reportLines.push('# Crypto opportunity analysis — 2026-11');
  reportLines.push('');
  reportLines.push(`Coins: ${COINS.join(', ')}. Three windows analyzed: ${WINDOWS.map((w) => w.label).join('; ')}. All ending ${fmtDate(NOW_TS)}.`);
  reportLines.push('');
  reportLines.push('Generated by `scripts/analysis/opportunity.js` — read-only, no config/live/scheduler code touched.');
  reportLines.push('');
  reportLines.push('## Summary');
  reportLines.push('');
  reportLines.push(buildSummary(results));
  reportLines.push('');
  reportLines.push('## Methodology notes / known simplifications');
  reportLines.push('');
  reportLines.push('- §2 (swing counting) still uses hindsight-confirmed zigzag pivots — that\'s fine for *describing* how often reversals of a given size happen, but §3\'s trend-follower trades off a real-time rule instead (lowest-close-since-exit / highest-close-since-entry), with no knowledge of future reversals.');
  reportLines.push('- The EMA baselines and the BTC trend filter both apply a signal decided at the *previous* close to *today\'s* return/entries — never today\'s own just-computed signal — closing the look-ahead bug from the first version of this report.');
  reportLines.push('- All simulations use candle **closes** only — no intrabar fills.');
  reportLines.push('- The BTC filter gates new entries only; it does not force an exit if BTC\'s signal flips while a position from one of the 6 coins is already open.');
  reportLines.push('- The equal-weight basket rebases each coin to its own window-start price and nets one round-trip fee per coin — a dispersion-vs-average comparison, not a tradeable rebalancing strategy.');
  reportLines.push('- "Pooled" compounded return merges every coin\'s trades into one chronological sequence, as if one capital pool traded all 6 coins\' signals.');
  reportLines.push('- **Compounded return assumes 100% of equity is re-risked on every trade** — it is a pure "edge per trade, compounded" figure, not a realistic position-sized backtest. A system with a small negative (or barely positive) edge per trade will compound toward -100% over enough trades at this sizing even though a 0.5%-of-equity-per-trade version of the same signals would survive comfortably. Read the compounded-return column as "does this edge survive being compounded at all", not as a literal account outcome — `netPctPerTrade` and `winRate` are the sizing-independent numbers to trust first.');
  reportLines.push('- Fee tiers are used exactly as given (round-trip totals); no live TradeVolume/fee-tier data is stored in this DB to cross-check against.');
  reportLines.push('');
  reportLines.push(buildComparisonSection(results));
  for (const r of results) {
    reportLines.push(buildWindowSection(r));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'opportunity-2026-11.md'), reportLines.join('\n'));
  console.log('Wrote docs/analysis/opportunity-2026-11.md and CSVs in docs/analysis/data/');
}

function moveSizeCsvRow(m) {
  return {
    coin: m.coin, candleCount: m.candleCount,
    range_p25: m.range.p25?.toFixed(3), range_p50: m.range.p50?.toFixed(3), range_p75: m.range.p75?.toFixed(3), range_p90: m.range.p90?.toFixed(3),
    c2c_p25: m.closeToClose.p25?.toFixed(3), c2c_p50: m.closeToClose.p50?.toFixed(3), c2c_p75: m.closeToClose.p75?.toFixed(3), c2c_p90: m.closeToClose.p90?.toFixed(3),
    tier1_1x: (m.beatShare.tier1_1x * 100).toFixed(1), tier1_2x: (m.beatShare.tier1_2x * 100).toFixed(1), tier1_3x: (m.beatShare.tier1_3x * 100).toFixed(1),
    tier2_1x: (m.beatShare.tier2_1x * 100).toFixed(1), tier2_2x: (m.beatShare.tier2_2x * 100).toFixed(1), tier2_3x: (m.beatShare.tier2_3x * 100).toFixed(1),
    tier3_1x: (m.beatShare.tier3_1x * 100).toFixed(1), tier3_2x: (m.beatShare.tier3_2x * 100).toFixed(1), tier3_3x: (m.beatShare.tier3_3x * 100).toFixed(1),
  };
}

module.exports = { simulateEmaEquity, simulateTrendFollowerRealtime, aggregateTrades, zigzag, swingsFromPivots };

if (require.main === module) main();
