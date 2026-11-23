'use strict';
const { ema, adx, choppiness, atr } = require('./indicators');

const REGIME_THRESHOLDS = {
  riskOffVolatilityRankPct: 90, riskOffBtc24hChangePct: -6, trendUpAdx: 22, trendUpBreadthPct: 60,
};

function labelRegime(metrics) {
  const { btcAboveEma200, ema200SlopeFalling, adx: adxValue, breadthPct, volatilityRankPct, btc24hChangePct } = metrics;

  let label;
  if (volatilityRankPct > REGIME_THRESHOLDS.riskOffVolatilityRankPct || btc24hChangePct <= REGIME_THRESHOLDS.riskOffBtc24hChangePct) {
    label = 'risk_off';
  } else if (btcAboveEma200 && adxValue > REGIME_THRESHOLDS.trendUpAdx && breadthPct >= REGIME_THRESHOLDS.trendUpBreadthPct) {
    label = 'trend_up';
  } else if (!btcAboveEma200 && ema200SlopeFalling) {
    label = 'downtrend';
  } else {
    label = 'range';
  }

  return { label, metrics };
}

const DAILY_EMA_PERIOD = 200;
const DAILY_SLOPE_LOOKBACK = 20;
const ADX_PERIOD = 14;
const VOLATILITY_WINDOW_BARS = 90 * 6; // 90 days of 4h bars
const DAY_SECONDS = 24 * 3600;

function alignDailyIndices(dailySeries, fourHourSeries) {
  const result = new Array(fourHourSeries.length).fill(null);
  if (dailySeries.length === 0) return result;
  let dailyPointer = 0;
  for (let i = 0; i < fourHourSeries.length; i += 1) {
    const bar = fourHourSeries[i];
    while (dailyPointer + 1 < dailySeries.length && dailySeries[dailyPointer + 1].ts + DAY_SECONDS <= bar.ts) {
      dailyPointer += 1;
    }
    result[i] = dailySeries[dailyPointer].ts + DAY_SECONDS <= bar.ts ? dailyPointer : null;
  }
  return result;
}

function computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h }) {
  const dailyCloses = btcDaily.map((c) => c.close);
  const dailyEma200 = ema(dailyCloses, DAILY_EMA_PERIOD);

  const adxResult = adx(btc4h, ADX_PERIOD);
  const choppinessSeries = choppiness(btc4h, ADX_PERIOD);
  const atrSeries = atr(btc4h, ADX_PERIOD);
  const atrPctSeries = atrSeries.map((v, i) => (v === null ? null : (v / btc4h[i].close) * 100));

  const breadthLookups = {};
  for (const [coin, series] of Object.entries(watchlistBy4h)) {
    const closes = series.map((c) => c.close);
    const ema50 = ema(closes, 50);
    const byTs = new Map();
    series.forEach((c, i) => {
      if (ema50[i] !== null) byTs.set(c.ts, c.close >= ema50[i]);
    });
    breadthLookups[coin] = byTs;
  }
  const coinNames = Object.keys(watchlistBy4h);

  const dailyIdx = alignDailyIndices(btcDaily, btc4h);
  const results = [];

  for (let i = 0; i < btc4h.length; i += 1) {
    const bar = btc4h[i];
    const dailyPointer = dailyIdx[i];
    if (dailyPointer === null) continue; // no completed daily candle yet at all
    const ema200Now = dailyEma200[dailyPointer];
    const slopeIdx = dailyPointer - DAILY_SLOPE_LOOKBACK;
    if (ema200Now === null || slopeIdx < 0 || dailyEma200[slopeIdx] === null) continue;
    const ema200Then = dailyEma200[slopeIdx];

    if (adxResult.adx[i] === null || atrPctSeries[i] === null) continue;

    const windowStart = Math.max(0, i - VOLATILITY_WINDOW_BARS + 1);
    const window = atrPctSeries.slice(windowStart, i + 1).filter((v) => v !== null);
    const countBelowOrEqual = window.filter((v) => v <= atrPctSeries[i]).length;
    const volatilityRankPct = (countBelowOrEqual / window.length) * 100;

    let breadthCount = 0;
    for (const coin of coinNames) {
      if (breadthLookups[coin].get(bar.ts)) breadthCount += 1;
    }
    const breadthPct = (breadthCount / coinNames.length) * 100;

    const prevIdx = i - 6; // 6 bars of 4h = 24h
    const btc24hChangePct = prevIdx >= 0 ? ((bar.close - btc4h[prevIdx].close) / btc4h[prevIdx].close) * 100 : 0;

    const metrics = {
      btcAboveEma200: bar.close >= ema200Now,
      ema200SlopeFalling: ema200Now < ema200Then,
      adx: adxResult.adx[i],
      choppiness: choppinessSeries[i],
      breadthPct,
      volatilityRankPct,
      btc24hChangePct,
      positioning: null,
    };

    results.push({ ts: bar.ts, ...labelRegime(metrics) });
  }

  return results;
}

module.exports = { labelRegime, computeRegimeSeries, alignDailyIndices, REGIME_THRESHOLDS };
