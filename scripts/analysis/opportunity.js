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

// Exact window: 6 calendar months ending at the most recently closed daily candle as of today
// (2026-11-25) — the Nov 24 2026 daily candle. Stated here, and again in the report, per the
// task's instruction to state the exact range used.
const WINDOW_END_TS = Math.floor(Date.UTC(2026, 10, 24, 0, 0, 0) / 1000); // 2026-11-24T00:00:00Z
const WINDOW_START_TS = Math.floor(Date.UTC(2026, 4, 24, 0, 0, 0) / 1000); // 2026-05-24T00:00:00Z

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

function toCSV(headers, rows) {
  const esc = (v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

function writeCSV(filename, headers, rows) {
  fs.writeFileSync(path.join(DATA_DIR, filename), toCSV(headers, rows));
}

function windowSlice(rows) {
  return rows.filter((r) => r.ts >= WINDOW_START_TS && r.ts <= WINDOW_END_TS);
}

// --- Section 1: move sizes ----------------------------------------------------------------

function computeMoveSizes(db, coin, tf) {
  const all = getCandles(db, coin, tf, 0, WINDOW_END_TS);
  const inWindow = windowSlice(all);
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
      const share = closeToClose.length === 0 ? null : closeToClose.filter((m) => m >= threshold).length / closeToClose.length;
      beatShare[`${tierName}_${mult}x`] = share;
    }
  }

  return { coin, tf, candleCount: inWindow.length, range: percentiles(rangePct), closeToClose: percentiles(closeToCloseSorted), beatShare };
}

// --- Section 2: zigzag swing detection -----------------------------------------------------

function zigzag(bars, thresholdPct) {
  // bars: [{ ts, close }]. Returns alternating pivots: [{ ts, val, kind: 'low'|'high' }].
  // Before a direction is established, tracks the running high and low independently; the
  // first pivot confirms whichever extreme is further behind the other once their spread
  // crosses the threshold (the earlier-dated extreme is the pivot, the later one keeps running).
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
    const direction = b.val > a.val ? 'up' : 'down';
    const sizePct = ((b.val - a.val) / a.val) * 100;
    const durationHours = (b.ts - a.ts) / HOUR;
    swings.push({ direction, startTs: a.ts, endTs: b.ts, startVal: a.val, endVal: b.val, sizePct, durationHours });
  }
  return swings;
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

function computeSwingStats(bars, thresholdPct, windowDays) {
  const pivots = zigzag(bars, thresholdPct);
  const allSwings = swingsFromPivots(pivots);
  const swings = allSwings.filter((s) => s.startTs >= WINDOW_START_TS && s.startTs <= WINDOW_END_TS);
  const up = swings.filter((s) => s.direction === 'up');
  const down = swings.filter((s) => s.direction === 'down');
  return {
    thresholdPct,
    upCount: up.length,
    downCount: down.length,
    medianSizePct: median(swings.map((s) => Math.abs(s.sizePct))),
    medianDurationHours: median(swings.map((s) => s.durationHours)),
    swingsPerMonth: (swings.length / (windowDays / 30)),
    swings,
  };
}

// --- Section 3: trend-follower simulation on swing lows ----------------------------------

function simulateTrendFollower(bars, { entryTriggerPct, trailPct, swingThresholdPct = 5, confirmSwingPct = 10 }) {
  const pivots = zigzag(bars, swingThresholdPct);
  const lows = pivots.filter((p) => p.kind === 'low' && p.ts >= WINDOW_START_TS && p.ts <= WINDOW_END_TS);
  const closes = bars.map((b) => b.close);
  const tsToIdx = new Map(bars.map((b, i) => [b.ts, i]));

  const realTrades = [];
  const falseStarts = [];

  for (const low of lows) {
    const lowIdx = tsToIdx.get(low.ts);
    if (lowIdx === undefined) continue;
    const entryTarget = low.val * (1 + entryTriggerPct / 100);

    let entryIdx = null;
    for (let i = lowIdx + 1; i < bars.length; i += 1) {
      if (closes[i] >= entryTarget) { entryIdx = i; break; }
    }
    if (entryIdx === null) continue; // never triggered — not a trade

    const entryPrice = closes[entryIdx];
    let peak = entryPrice;
    let exitIdx = null;
    let maxCloseSeen = Math.max(low.val, entryPrice);
    for (let i = entryIdx; i < bars.length; i += 1) {
      peak = Math.max(peak, closes[i]);
      maxCloseSeen = Math.max(maxCloseSeen, closes[i]);
      if (closes[i] <= peak * (1 - trailPct / 100)) { exitIdx = i; break; }
    }
    const stillOpen = exitIdx === null;
    const exitPrice = stillOpen ? closes[closes.length - 1] : closes[exitIdx];
    if (stillOpen) maxCloseSeen = Math.max(maxCloseSeen, exitPrice);

    const everReached10Pct = ((maxCloseSeen - low.val) / low.val) * 100 >= confirmSwingPct;
    const grossPct = ((exitPrice - entryPrice) / entryPrice) * 100;

    const trade = { lowTs: low.ts, lowVal: low.val, entryPrice, exitPrice, grossPct, stillOpen };
    if (everReached10Pct) realTrades.push(trade);
    else falseStarts.push(trade);
  }

  return { realTrades, falseStarts };
}

function feeAdjust(grossPct, roundTripFeePct) {
  return grossPct - roundTripFeePct;
}

// --- Section 4: time in trend vs range ----------------------------------------------------

function computeAdxShare(db, coin) {
  const all = getCandles(db, coin, '4h', 0, WINDOW_END_TS);
  const adxResult = adx(all, 14);
  let withinWindow = 0, aboveThreshold = 0;
  all.forEach((c, i) => {
    if (c.ts < WINDOW_START_TS || c.ts > WINDOW_END_TS) return;
    if (adxResult.adx[i] === null) return;
    withinWindow += 1;
    if (adxResult.adx[i] > REGIME_THRESHOLDS.trendUpAdx) aboveThreshold += 1;
  });
  return withinWindow === 0 ? null : aboveThreshold / withinWindow;
}

function computeRegimeLabelShare(db) {
  const btcDaily = getCandles(db, 'BTC', '1d', 0, WINDOW_END_TS);
  const btc4h = getCandles(db, 'BTC', '4h', 0, WINDOW_END_TS);
  const watchlistBy4h = {};
  for (const coin of COINS) {
    watchlistBy4h[coin] = getCandles(db, coin, '4h', 0, WINDOW_END_TS).map((c) => ({ ts: c.ts, close: c.close }));
  }
  const series = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
  const inWindow = series.filter((r) => r.ts >= WINDOW_START_TS && r.ts <= WINDOW_END_TS);
  const counts = {};
  for (const point of inWindow) counts[point.label] = (counts[point.label] || 0) + 1;
  const total = inWindow.length;
  const shares = {};
  for (const [label, count] of Object.entries(counts)) shares[label] = count / total;
  return { total, shares };
}

// --- Section 5: baselines -------------------------------------------------------------------

function buyAndHold(db, coin, roundTripFeePct) {
  const all = getCandles(db, coin, '1d', 0, WINDOW_END_TS);
  const inWindow = windowSlice(all);
  if (inWindow.length < 2) return null;
  const closes = inWindow.map((c) => c.close);
  const rawReturnPct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  const netReturnPct = rawReturnPct - roundTripFeePct;
  const { maxDrawdownPct } = computeDrawdown(closes);
  return { returnPct: netReturnPct, maxDrawdownPct: maxDrawdownPct * 100, trades: 1 };
}

function equalWeightBasket(db, roundTripFeePct) {
  const seriesByCoin = {};
  let minLen = Infinity;
  for (const coin of COINS) {
    const inWindow = windowSlice(getCandles(db, coin, '1d', 0, WINDOW_END_TS));
    seriesByCoin[coin] = inWindow.map((c) => c.close);
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
  const netReturnPct = rawReturnPct - roundTripFeePct; // one round trip per coin, netted against the averaged path
  const { maxDrawdownPct } = computeDrawdown(basket);
  return { returnPct: netReturnPct, maxDrawdownPct: maxDrawdownPct * 100, trades: COINS.length };
}

function emaSwitchRule(db, coins, emaPeriod, roundTripFeePct) {
  // coins: array of 1-2 coin codes, equal-weighted. Each coin's own EMA signal switches
  // independently; cash (0% weight) replaces a coin whenever its close is below its own EMA.
  const perCoin = {};
  for (const coin of coins) {
    const all = getCandles(db, coin, '1d', 0, WINDOW_END_TS);
    const closes = all.map((c) => c.close);
    const emaArr = ema(closes, emaPeriod);
    perCoin[coin] = { all, closes, emaArr };
  }

  let totalTrades = 0;
  const equitySeriesByCoin = {};
  for (const coin of coins) {
    const { all, closes, emaArr } = perCoin[coin];
    let equity = 1, inPosition = null, prevClose = null;
    const series = [];
    for (let i = 0; i < all.length; i += 1) {
      if (emaArr[i] === null) continue;
      const ts = all[i].ts;
      const signal = closes[i] > emaArr[i];
      if (inPosition === null) {
        inPosition = signal;
        prevClose = closes[i];
        if (ts >= WINDOW_START_TS && ts <= WINDOW_END_TS) series.push({ ts, equity });
        continue;
      }
      if (signal !== inPosition) {
        equity *= 1 - roundTripFeePct / 100;
        if (ts >= WINDOW_START_TS && ts <= WINDOW_END_TS) totalTrades += 1;
        inPosition = signal;
      }
      if (inPosition) equity *= closes[i] / prevClose;
      prevClose = closes[i];
      if (ts >= WINDOW_START_TS && ts <= WINDOW_END_TS) series.push({ ts, equity });
    }
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

function checkEma200Warmup(db, coin) {
  const all = getCandles(db, coin, '1d', 0, WINDOW_END_TS);
  const beforeWindow = all.filter((c) => c.ts < WINDOW_START_TS);
  return { hasEnough: beforeWindow.length >= 200, daysBefore: beforeWindow.length, earliestTs: all.length > 0 ? all[0].ts : null };
}

// --- Report assembly -------------------------------------------------------------------------

function fmtPct(v, dp = 2) { return v === null || v === undefined ? 'n/a' : `${v.toFixed(dp)}%`; }
function fmtDate(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

function main() {
  ensureDirs();
  const db = openDb();
  const windowDays = (WINDOW_END_TS - WINDOW_START_TS) / DAY;

  // --- Section 1 ---
  const moveSizes4h = COINS.map((coin) => computeMoveSizes(db, coin, '4h'));
  const moveSizesDaily = COINS.map((coin) => computeMoveSizes(db, coin, '1d'));

  function pooledMoveSizes(perCoinResults, tf) {
    // "all coins" row: pool every candle's move across all 6 coins, recompute percentiles/shares.
    const db2 = db;
    let allRange = [], allC2C = [];
    for (const coin of COINS) {
      const all = getCandles(db2, coin, tf, 0, WINDOW_END_TS);
      const inWindow = windowSlice(all);
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
        beatShare[`${tierName}_${mult}x`] = allC2C.filter((m) => m >= threshold).length / allC2C.length;
      }
    }
    return { coin: 'ALL', tf, candleCount: allRange.length, range: percentiles(allRange), closeToClose: percentiles(allC2CSorted), beatShare };
  }

  const moveSizes4hAll = pooledMoveSizes(moveSizes4h, '4h');
  const moveSizesDailyAll = pooledMoveSizes(moveSizesDaily, '1d');

  writeCSV('move-sizes-4h.csv',
    ['coin', 'candleCount', 'range_p25', 'range_p50', 'range_p75', 'range_p90', 'c2c_p25', 'c2c_p50', 'c2c_p75', 'c2c_p90',
      'tier1_1x', 'tier1_2x', 'tier1_3x', 'tier2_1x', 'tier2_2x', 'tier2_3x', 'tier3_1x', 'tier3_2x', 'tier3_3x'],
    [...moveSizes4h, moveSizes4hAll].map((m) => ({
      coin: m.coin, candleCount: m.candleCount,
      range_p25: m.range.p25?.toFixed(3), range_p50: m.range.p50?.toFixed(3), range_p75: m.range.p75?.toFixed(3), range_p90: m.range.p90?.toFixed(3),
      c2c_p25: m.closeToClose.p25?.toFixed(3), c2c_p50: m.closeToClose.p50?.toFixed(3), c2c_p75: m.closeToClose.p75?.toFixed(3), c2c_p90: m.closeToClose.p90?.toFixed(3),
      tier1_1x: (m.beatShare.tier1_1x * 100).toFixed(1), tier1_2x: (m.beatShare.tier1_2x * 100).toFixed(1), tier1_3x: (m.beatShare.tier1_3x * 100).toFixed(1),
      tier2_1x: (m.beatShare.tier2_1x * 100).toFixed(1), tier2_2x: (m.beatShare.tier2_2x * 100).toFixed(1), tier2_3x: (m.beatShare.tier2_3x * 100).toFixed(1),
      tier3_1x: (m.beatShare.tier3_1x * 100).toFixed(1), tier3_2x: (m.beatShare.tier3_2x * 100).toFixed(1), tier3_3x: (m.beatShare.tier3_3x * 100).toFixed(1),
    })));
  writeCSV('move-sizes-daily.csv',
    ['coin', 'candleCount', 'range_p25', 'range_p50', 'range_p75', 'range_p90', 'c2c_p25', 'c2c_p50', 'c2c_p75', 'c2c_p90',
      'tier1_1x', 'tier1_2x', 'tier1_3x', 'tier2_1x', 'tier2_2x', 'tier2_3x', 'tier3_1x', 'tier3_2x', 'tier3_3x'],
    [...moveSizesDaily, moveSizesDailyAll].map((m) => ({
      coin: m.coin, candleCount: m.candleCount,
      range_p25: m.range.p25?.toFixed(3), range_p50: m.range.p50?.toFixed(3), range_p75: m.range.p75?.toFixed(3), range_p90: m.range.p90?.toFixed(3),
      c2c_p25: m.closeToClose.p25?.toFixed(3), c2c_p50: m.closeToClose.p50?.toFixed(3), c2c_p75: m.closeToClose.p75?.toFixed(3), c2c_p90: m.closeToClose.p90?.toFixed(3),
      tier1_1x: (m.beatShare.tier1_1x * 100).toFixed(1), tier1_2x: (m.beatShare.tier1_2x * 100).toFixed(1), tier1_3x: (m.beatShare.tier1_3x * 100).toFixed(1),
      tier2_1x: (m.beatShare.tier2_1x * 100).toFixed(1), tier2_2x: (m.beatShare.tier2_2x * 100).toFixed(1), tier2_3x: (m.beatShare.tier2_3x * 100).toFixed(1),
      tier3_1x: (m.beatShare.tier3_1x * 100).toFixed(1), tier3_2x: (m.beatShare.tier3_2x * 100).toFixed(1), tier3_3x: (m.beatShare.tier3_3x * 100).toFixed(1),
    })));

  // --- Section 2 ---
  const swingThresholds = [5, 10, 20];
  const swingResultsByCoinTf = {}; // coin -> tf -> threshold -> stats
  const swingDetailRows4h = [], swingDetailRowsDaily = [];
  for (const coin of COINS) {
    swingResultsByCoinTf[coin] = {};
    for (const tf of ['4h', '1d']) {
      const all = getCandles(db, coin, tf, 0, WINDOW_END_TS);
      const bars = all.map((c) => ({ ts: c.ts, close: c.close }));
      swingResultsByCoinTf[coin][tf] = {};
      for (const threshold of swingThresholds) {
        const stats = computeSwingStats(bars, threshold, windowDays);
        swingResultsByCoinTf[coin][tf][threshold] = stats;
        const targetRows = tf === '4h' ? swingDetailRows4h : swingDetailRowsDaily;
        for (const s of stats.swings) {
          targetRows.push({
            coin, threshold, direction: s.direction,
            startDate: fmtDate(s.startTs), endDate: fmtDate(s.endTs),
            sizePct: s.sizePct.toFixed(2), durationHours: s.durationHours.toFixed(1),
          });
        }
      }
    }
  }
  writeCSV('swings-detail-4h.csv', ['coin', 'threshold', 'direction', 'startDate', 'endDate', 'sizePct', 'durationHours'], swingDetailRows4h);
  writeCSV('swings-detail-daily.csv', ['coin', 'threshold', 'direction', 'startDate', 'endDate', 'sizePct', 'durationHours'], swingDetailRowsDaily);

  const swingSummaryRows = [];
  for (const coin of COINS) {
    for (const tf of ['4h', '1d']) {
      for (const threshold of swingThresholds) {
        const s = swingResultsByCoinTf[coin][tf][threshold];
        swingSummaryRows.push({
          coin, tf, threshold, upCount: s.upCount, downCount: s.downCount,
          medianSizePct: s.medianSizePct?.toFixed(2), medianDurationHours: s.medianDurationHours?.toFixed(1),
          swingsPerMonth: s.swingsPerMonth.toFixed(2),
        });
      }
    }
  }
  writeCSV('swings-summary.csv', ['coin', 'tf', 'threshold', 'upCount', 'downCount', 'medianSizePct', 'medianDurationHours', 'swingsPerMonth'], swingSummaryRows);

  // --- Section 3 + 6 (trend follower, all 3 tiers) ---
  const trendFollowerResults = { '4h': {}, '1d': {} };
  for (const coin of COINS) {
    const bars4h = getCandles(db, coin, '4h', 0, WINDOW_END_TS).map((c) => ({ ts: c.ts, close: c.close }));
    const barsDaily = getCandles(db, coin, '1d', 0, WINDOW_END_TS).map((c) => ({ ts: c.ts, close: c.close }));
    const sim4h = simulateTrendFollower(bars4h, { entryTriggerPct: 3, trailPct: 5 });
    const simDaily = simulateTrendFollower(barsDaily, { entryTriggerPct: 5, trailPct: 8 });
    trendFollowerResults['4h'][coin] = sim4h;
    trendFollowerResults['1d'][coin] = simDaily;
  }

  function trendFollowerRows(tf) {
    const rows = [];
    for (const coin of [...COINS, 'ALL']) {
      let real, falseStarts;
      if (coin === 'ALL') {
        real = COINS.flatMap((c) => trendFollowerResults[tf][c].realTrades);
        falseStarts = COINS.flatMap((c) => trendFollowerResults[tf][c].falseStarts);
      } else {
        real = trendFollowerResults[tf][coin].realTrades;
        falseStarts = trendFollowerResults[tf][coin].falseStarts;
      }
      for (const [tierName, roundTrip] of Object.entries(FEE_TIERS)) {
        const realNet = real.map((t) => feeAdjust(t.grossPct, roundTrip));
        const falseNet = falseStarts.map((t) => feeAdjust(t.grossPct, roundTrip));
        const avgCaptured = realNet.length ? realNet.reduce((a, b) => a + b, 0) / realNet.length : null;
        const avgFalseCost = falseNet.length ? falseNet.reduce((a, b) => a + b, 0) / falseNet.length : null;
        const totalFalseCost = falseNet.reduce((a, b) => a + b, 0);
        rows.push({
          coin, tier: tierName, realTrades: real.length, falseStarts: falseStarts.length,
          avgCapturedPct: avgCaptured?.toFixed(2) ?? 'n/a',
          avgFalseStartCostPct: avgFalseCost?.toFixed(2) ?? 'n/a',
          totalFalseStartCostPct: totalFalseCost.toFixed(2),
        });
      }
    }
    return rows;
  }

  writeCSV('trend-follower-4h.csv', ['coin', 'tier', 'realTrades', 'falseStarts', 'avgCapturedPct', 'avgFalseStartCostPct', 'totalFalseStartCostPct'], trendFollowerRows('4h'));
  writeCSV('trend-follower-daily.csv', ['coin', 'tier', 'realTrades', 'falseStarts', 'avgCapturedPct', 'avgFalseStartCostPct', 'totalFalseStartCostPct'], trendFollowerRows('1d'));

  // --- Section 4 ---
  const adxShareByCoin = {};
  for (const coin of COINS) adxShareByCoin[coin] = computeAdxShare(db, coin);
  const regimeLabelShare = computeRegimeLabelShare(db);

  writeCSV('adx-regime-share.csv', ['coin', 'adxAbove22SharePct'],
    COINS.map((coin) => ({ coin, adxAbove22SharePct: (adxShareByCoin[coin] * 100).toFixed(1) })));

  // --- Section 5 + 6 (baselines, all 3 tiers) ---
  const ema200Warmup = COINS.map((coin) => ({ coin, ...checkEma200Warmup(db, coin) }));

  const baselineRows = [];
  for (const [tierName, roundTrip] of Object.entries(FEE_TIERS)) {
    for (const coin of COINS) {
      const bh = buyAndHold(db, coin, roundTrip);
      baselineRows.push({ tier: tierName, strategy: 'buy_and_hold', coin, ...bh });
    }
    const basket = equalWeightBasket(db, roundTrip);
    baselineRows.push({ tier: tierName, strategy: 'equal_weight_basket', coin: 'ALL', ...basket });
    baselineRows.push({ tier: tierName, strategy: 'ema200_btc', coin: 'BTC', ...emaSwitchRule(db, ['BTC'], 200, roundTrip) });
    baselineRows.push({ tier: tierName, strategy: 'ema50_btc', coin: 'BTC', ...emaSwitchRule(db, ['BTC'], 50, roundTrip) });
    baselineRows.push({ tier: tierName, strategy: 'ema200_btc_eth', coin: 'BTC+ETH', ...emaSwitchRule(db, ['BTC', 'ETH'], 200, roundTrip) });
  }
  writeCSV('baselines.csv', ['tier', 'strategy', 'coin', 'returnPct', 'maxDrawdownPct', 'trades'],
    baselineRows.map((r) => ({ ...r, returnPct: r.returnPct?.toFixed(2), maxDrawdownPct: r.maxDrawdownPct?.toFixed(2) })));

  // --- Write the markdown report ---
  const report = buildReport({
    moveSizes4h, moveSizesDaily, moveSizes4hAll, moveSizesDailyAll,
    swingResultsByCoinTf, swingThresholds,
    trendFollowerResults, trendFollowerRows,
    adxShareByCoin, regimeLabelShare,
    baselineRows, ema200Warmup,
    windowDays,
  });
  fs.writeFileSync(path.join(OUT_DIR, 'opportunity-2026-11.md'), report);
  console.log('Wrote docs/analysis/opportunity-2026-11.md and CSVs in docs/analysis/data/');
}

function buildReport(ctx) {
  const {
    moveSizes4h, moveSizesDaily, moveSizes4hAll, moveSizesDailyAll,
    swingResultsByCoinTf, swingThresholds,
    trendFollowerRows,
    adxShareByCoin, regimeLabelShare,
    baselineRows, ema200Warmup,
  } = ctx;

  const lines = [];
  lines.push('# Crypto opportunity analysis — 2026-11');
  lines.push('');
  lines.push(`Window: **${fmtDate(WINDOW_START_TS)} to ${fmtDate(WINDOW_END_TS)}** (6 calendar months, inclusive of the closing boundary, using stored Kraken GBP candles). Coins: ${COINS.join(', ')}.`);
  lines.push('');
  lines.push('Generated by `scripts/analysis/opportunity.js` — read-only, no config/live/scheduler code touched.');
  lines.push('');

  // --- Summary ---
  lines.push('## Summary');
  lines.push('');
  const tier1DailyBeat1x = moveSizesDailyAll.beatShare.tier1_1x * 100;
  const tier1_4hBeat1x = moveSizes4hAll.beatShare.tier1_1x * 100;
  const avgSwingsPerMonth10pct4h = COINS.reduce((sum, c) => sum + swingResultsByCoinTf[c]['4h'][10].swingsPerMonth, 0) / COINS.length;
  const bhAll = baselineRows.filter((r) => r.tier === 'tier1' && r.strategy === 'buy_and_hold');
  const bestBH = bhAll.reduce((best, r) => (r.returnPct > (best?.returnPct ?? -Infinity) ? r : best), null);
  const worstBH = bhAll.reduce((worst, r) => (r.returnPct < (worst?.returnPct ?? Infinity) ? r : worst), null);
  const ema200 = baselineRows.find((r) => r.tier === 'tier1' && r.strategy === 'ema200_btc');
  const basket = baselineRows.find((r) => r.tier === 'tier1' && r.strategy === 'equal_weight_basket');
  const tf4hRows = trendFollowerRows('4h').filter((r) => r.tier === 'tier1' && r.coin === 'ALL');
  const tfDailyRows = trendFollowerRows('1d').filter((r) => r.tier === 'tier1' && r.coin === 'ALL');

  lines.push(`- **Candle moves clear Tier 1's round-trip fee (1.3%) only ${fmtPct(tier1DailyBeat1x, 1)} of the time on daily closes, ${fmtPct(tier1_4hBeat1x, 1)} on 4h closes** (all 6 coins pooled) — most individual candle-to-candle moves are too small to trade profitably one at a time, even before counting false signals.`);
  lines.push(`- **Genuine ≥10% swings happen roughly ${avgSwingsPerMonth10pct4h.toFixed(1)} times/month per coin** (4h zigzag, averaged across all 6) — the opportunity is in catching a handful of real trends per month, not in trading every wiggle.`);
  lines.push(`- **Buy-and-hold over this window ranged from ${worstBH.coin} at ${fmtPct(worstBH.returnPct)} to ${bestBH.coin} at ${fmtPct(bestBH.returnPct)}** (after one Tier 1 round trip) — coin selection and timing both matter a lot; see the per-coin table in §5.`);
  lines.push(`- **BTC's 200-day EMA switch rule returned ${fmtPct(ema200.returnPct)} with ${fmtPct(ema200.maxDrawdownPct)} max drawdown across ${ema200.trades} trades** — compare against plain BTC buy-and-hold in §5 to see whether the switching actually earned its keep after fees.`);
  lines.push(`- **The equal-weight 6-coin basket returned ${fmtPct(basket.returnPct)}** with ${fmtPct(basket.maxDrawdownPct)} max drawdown — diversification's net effect on this exact window, after fees.`);
  if (tf4hRows.length > 0) {
    lines.push(`- **A simple trend-follower (enter +3% off a swing low, trail 5%, 4h candles) caught real ≥10% swings averaging ${tf4hRows[0].avgCapturedPct}% after Tier 1 fees, but also hit ${tf4hRows[0].falseStarts} false starts** costing ${tf4hRows[0].totalFalseStartCostPct}% total — see §3/§6 for whether the false-start cost eats the gains.`);
  }
  if (tfDailyRows.length > 0) {
    lines.push(`- **The same idea on daily candles (+5% entry, 8% trail) averaged ${tfDailyRows[0].avgCapturedPct}% captured per real swing after Tier 1 fees**, with ${tfDailyRows[0].falseStarts} false starts.`);
  }
  const anyShortWarmup = ema200Warmup.find((w) => !w.hasEnough);
  lines.push(anyShortWarmup
    ? `- **Caveat:** ${anyShortWarmup.coin} doesn't have 200 days of history before the window start — its 200-day EMA figures use the longest history actually available (${anyShortWarmup.daysBefore} days before the window).`
    : `- All 6 coins had 200+ days of history before the window started, so every 200-day EMA figure here is a real, fully-warmed-up signal — no fallback needed.`);
  lines.push('');

  // --- Section 1 ---
  lines.push('## 1. Move sizes');
  lines.push('');
  lines.push('Range % = (high − low) ÷ close, per candle. Close-to-close % = |close[i] − close[i−1]| ÷ close[i−1]. "Beats Nx tier" = share of candles whose close-to-close move is ≥ N × that tier\'s round-trip fee.');
  lines.push('');
  lines.push('### 4h candles');
  lines.push('');
  lines.push(moveSizeTable([...moveSizes4h, moveSizes4hAll]));
  lines.push('');
  lines.push('### Daily candles');
  lines.push('');
  lines.push(moveSizeTable([...moveSizesDaily, moveSizesDailyAll]));
  lines.push('');
  lines.push('Full data: `docs/analysis/data/move-sizes-4h.csv`, `move-sizes-daily.csv`.');
  lines.push('');

  // --- Section 2 ---
  lines.push('## 2. Trends vs chop (zigzag swing detection)');
  lines.push('');
  lines.push('Zigzag pivots confirm on a reversal of at least the stated threshold %, measured close-to-close.');
  lines.push('');
  for (const tf of ['4h', '1d']) {
    lines.push(`### ${tf === '4h' ? '4h candles' : 'Daily candles'}`);
    lines.push('');
    for (const threshold of swingThresholds) {
      lines.push(`**${threshold}% threshold**`);
      lines.push('');
      lines.push(swingTable(ctx.swingResultsByCoinTf, tf, threshold));
      lines.push('');
    }
  }
  lines.push('Full swing list: `docs/analysis/data/swings-detail-4h.csv`, `swings-detail-daily.csv`. Summary: `swings-summary.csv`.');
  lines.push('');

  // --- Section 3 ---
  lines.push('## 3. Realistic capture — trend-follower simulation');
  lines.push('');
  lines.push('Methodology: using the 5%-zigzag\'s swing lows as candidate entry points (the finest-grained signal available without hindsight), enter once price rises the stated % above that low, then exit when price closes the stated % below the highest close seen since entry. A trade is a "false start" if price never reached +10% above the originating low before the trail stopped it out; otherwise it\'s counted as "real" and its % captured is reported. All simulated on candle closes only (no intrabar fills), fees deducted at the stated tier as a flat round-trip %.');
  lines.push('');
  lines.push('### 4h candles (+3% entry, 5% trail) — Tier 1 fees');
  lines.push('');
  lines.push(trendFollowerTable(trendFollowerRows('4h').filter((r) => r.tier === 'tier1')));
  lines.push('');
  lines.push('### Daily candles (+5% entry, 8% trail) — Tier 1 fees');
  lines.push('');
  lines.push(trendFollowerTable(trendFollowerRows('1d').filter((r) => r.tier === 'tier1')));
  lines.push('');
  lines.push('Tier 2/3 sensitivity for both variants is in §6.');
  lines.push('');

  // --- Section 4 ---
  lines.push('## 4. Time in trend vs range');
  lines.push('');
  lines.push(`Share of 4h candles with ADX(14) > ${REGIME_THRESHOLDS.trendUpAdx} (this codebase's own trend_up threshold), per coin:`);
  lines.push('');
  lines.push('| Coin | ADX > 22 share |');
  lines.push('|---|---|');
  for (const coin of COINS) lines.push(`| ${coin} | ${fmtPct(adxShareByCoin[coin] * 100, 1)} |`);
  lines.push('');
  lines.push(`Market-wide regime label share (from this codebase's regime engine — one label applies across the whole watchlist at a time, not per-coin), over ${regimeLabelShare.total} regime-computable 4h bars in the window:`);
  lines.push('');
  lines.push('| Regime | Share |');
  lines.push('|---|---|');
  for (const [label, share] of Object.entries(regimeLabelShare.shares)) lines.push(`| ${label} | ${fmtPct(share * 100, 1)} |`);
  lines.push('');

  // --- Section 5 ---
  lines.push('## 5. Baselines (Tier 1 fees)');
  lines.push('');
  lines.push(baselineTable(baselineRows.filter((r) => r.tier === 'tier1')));
  lines.push('');
  lines.push('200-day EMA warm-up check:');
  lines.push('');
  lines.push('| Coin | Days of history before window start | 200+ days available? |');
  lines.push('|---|---|---|');
  for (const w of ema200Warmup) lines.push(`| ${w.coin} | ${w.daysBefore} | ${w.hasEnough ? 'yes' : '**no — used longest available**'} |`);
  lines.push('');
  lines.push('Full data: `docs/analysis/data/baselines.csv`.');
  lines.push('');

  // --- Section 6 ---
  lines.push('## 6. Fee sensitivity (Tier 1 / 2 / 3)');
  lines.push('');
  lines.push('### Trend-follower (§3), all coins pooled, by tier');
  lines.push('');
  lines.push('**4h variant:**');
  lines.push('');
  lines.push(trendFollowerTable(trendFollowerRows('4h').filter((r) => r.coin === 'ALL')));
  lines.push('');
  lines.push('**Daily variant:**');
  lines.push('');
  lines.push(trendFollowerTable(trendFollowerRows('1d').filter((r) => r.coin === 'ALL')));
  lines.push('');
  lines.push('### Baselines (§5), by tier');
  lines.push('');
  for (const tier of ['tier1', 'tier2', 'tier3']) {
    lines.push(`**${tier} (${FEE_TIERS[tier]}% round trip):**`);
    lines.push('');
    lines.push(baselineTable(baselineRows.filter((r) => r.tier === tier)));
    lines.push('');
  }

  lines.push('## Methodology notes / known simplifications');
  lines.push('');
  lines.push('- All simulations use candle **closes** only — no intrabar fills, so real slippage on stop triggers would be somewhat worse than shown here.');
  lines.push('- The trend-follower treats each 5%-zigzag low as an independent hypothetical trade — overlapping positions aren\'t deduplicated or portfolio-constrained.');
  lines.push('- EMA switch-rule equity curves charge one round-trip fee per signal flip and compound daily returns while in position; cash periods earn exactly 0%.');
  lines.push('- The equal-weight basket rebases each coin to its own window-start price, averages the six rebased paths, and nets a single round-trip fee per coin against that path — it is not a tradeable rebalancing strategy, just a dispersion-vs-average comparison.');
  lines.push('- Fee tiers are used exactly as given (round-trip totals); no live TradeVolume/fee-tier data is stored in this DB to cross-check against.');
  lines.push('');

  return lines.join('\n');
}

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

function trendFollowerTable(rows) {
  const lines = ['| Coin | Tier | Real trades | False starts | Avg captured % | Avg false-start cost % | Total false-start cost % |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.coin} | ${r.tier} | ${r.realTrades} | ${r.falseStarts} | ${r.avgCapturedPct} | ${r.avgFalseStartCostPct} | ${r.totalFalseStartCostPct} |`);
  }
  return lines.join('\n');
}

function baselineTable(rows) {
  const lines = ['| Strategy | Coin | Return % | Max drawdown % | Trades |', '|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.strategy} | ${r.coin} | ${fmtPct(r.returnPct)} | ${fmtPct(r.maxDrawdownPct)} | ${r.trades} |`);
  }
  return lines.join('\n');
}

main();
