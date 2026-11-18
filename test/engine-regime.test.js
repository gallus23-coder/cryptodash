'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { labelRegime } = require('../src/engine/regime');

function baseMetrics(overrides = {}) {
  return {
    btcAboveEma200: true, ema200SlopeFalling: false, adx: 25, choppiness: 40,
    breadthPct: 70, volatilityRankPct: 50, btc24hChangePct: 0, positioning: null,
    ...overrides,
  };
}

test('risk_off when volatility rank exceeds the 90th percentile', () => {
  const { label } = labelRegime(baseMetrics({ volatilityRankPct: 95 }));
  assert.equal(label, 'risk_off');
});

test('risk_off when BTC has dropped more than 6% in 24h', () => {
  const { label } = labelRegime(baseMetrics({ btc24hChangePct: -7 }));
  assert.equal(label, 'risk_off');
});

test('risk_off wins even when trend_up conditions are also true (first match wins)', () => {
  const { label } = labelRegime(baseMetrics({ volatilityRankPct: 95, btcAboveEma200: true, adx: 30, breadthPct: 80 }));
  assert.equal(label, 'risk_off');
});

test('trend_up when BTC is above EMA200, ADX > 22, and breadth >= 60%', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: true, adx: 23, breadthPct: 60 }));
  assert.equal(label, 'trend_up');
});

test('not trend_up when breadth is just under 60%', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: true, adx: 30, breadthPct: 59 }));
  assert.notEqual(label, 'trend_up');
});

test('downtrend when BTC is below EMA200 and the EMA200 slope is falling', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: false, ema200SlopeFalling: true, breadthPct: 10 }));
  assert.equal(label, 'downtrend');
});

test('range is the fallback when nothing else matches', () => {
  const { label } = labelRegime(baseMetrics({ btcAboveEma200: false, ema200SlopeFalling: false, adx: 10, breadthPct: 40 }));
  assert.equal(label, 'range');
});

test('echoes the input metrics back unchanged alongside the label', () => {
  const metrics = baseMetrics();
  const result = labelRegime(metrics);
  assert.deepEqual(result.metrics, metrics);
});

const { computeRegimeSeries } = require('../src/engine/regime');

function makeDailySeries(days, closeFn) {
  const HOUR = 3600, DAY = 24 * HOUR;
  return Array.from({ length: days }, (_, i) => ({ ts: i * DAY, close: closeFn(i) }));
}

function make4hSeries(bars, priceFn, { skipIndices = new Set() } = {}) {
  const HOUR = 3600, FOUR_H = 4 * HOUR;
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    if (skipIndices.has(i)) continue; // a real gap — this timestamp is simply absent
    const p = priceFn(i);
    out.push({ ts: i * FOUR_H, high: p + 1, low: p - 1, close: p });
  }
  return out;
}

test('computeRegimeSeries only starts once there is enough daily and 4h history', () => {
  const btcDaily = makeDailySeries(225, (i) => 100 + i * 0.1); // 225 days: 200 for EMA200 + 20 for slope + margin
  const btc4h = make4hSeries(225 * 6, (i) => 100 + i * 0.02);
  const watchlistBy4h = { BTC: btc4h.map((c) => ({ ts: c.ts, close: c.close })) };

  const result = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });

  assert.ok(result.length > 0);
  assert.ok(result.length < btc4h.length, 'should not start from index 0 — not enough warm-up history there');
  assert.ok(result.every((r) => typeof r.label === 'string'));
});

test('computeRegimeSeries looks up breadth by timestamp, so a gap in one coin does not misalign another', () => {
  // Regime points only start once 220 daily bars (200 EMA + 20 slope) have
  // elapsed, so the series needs real margin past that before placing a gap —
  // a gap at day ~83 would never be reachable regardless of total length.
  const DAYS = 300;
  const btcDaily = makeDailySeries(DAYS, (i) => 100 + i); // strongly trending up -> above EMA200
  const btc4h = make4hSeries(DAYS * 6, (i) => 100 + i * 0.5); // also trending up strongly for ADX
  // ETH has a gap well inside the valid (post-warmup) range — its array is
  // shorter and misaligned by position against btc4h from that point on, but
  // every remaining entry's ts is honest.
  const GAP_INDEX = 1500;
  const ethFull = make4hSeries(DAYS * 6, (i) => 50 + i * 0.5);
  const ethWithGap = ethFull.filter((_, i) => i !== GAP_INDEX);

  const watchlistBy4h = {
    BTC: btc4h.map((c) => ({ ts: c.ts, close: c.close })),
    ETH: ethWithGap.map((c) => ({ ts: c.ts, close: c.close })),
  };

  const result = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });

  // Right after the gap, ETH's next real entry must still be matched to the SAME ts
  // as BTC's corresponding bar, not shifted by one position.
  const afterGap = result.find((r) => r.ts === btc4h[GAP_INDEX + 1].ts);
  assert.ok(afterGap, "expected a regime point at the bar right after ETH's gap");
  assert.equal(afterGap.metrics.breadthPct, 100); // both BTC and ETH are trending up, both above their EMA50
});

test('computeRegimeSeries uses the most recently CLOSED daily candle, never one still open at the 4h bar (no look-ahead)', () => {
  const { ema: emaFn } = require('../src/engine/indicators');
  const DAY = 24 * 3600;
  const FOUR_H = 4 * 3600;
  const DAYS = 230;
  const dailyCloses = Array.from({ length: DAYS }, (_, i) => 100 + i); // steadily rising -> ema200 strictly increases day over day
  const btcDaily = dailyCloses.map((close, i) => ({ ts: i * DAY, close }));
  const dailyEma200 = emaFn(dailyCloses, 200);
  const lastClosedIdx = DAYS - 2; // day 228: the last day fully elapsed as of a bar early in day 229
  const stillOpenIdx = DAYS - 1; // day 229: "today", not yet closed
  const midpoint = (dailyEma200[lastClosedIdx] + dailyEma200[stillOpenIdx]) / 2;

  const btc4h = [];
  for (let i = 0; i < DAYS * 6; i += 1) {
    const dayIdx = Math.floor(i / 6);
    const price = 100 + dayIdx;
    btc4h.push({ ts: i * FOUR_H, high: price + 1, low: price - 1, close: price });
  }
  const probeBarIndex = stillOpenIdx * 6 + 1; // 4h into "today" (day 229), well before day229 closes
  btc4h[probeBarIndex] = { ts: probeBarIndex * FOUR_H, high: midpoint + 1, low: midpoint - 1, close: midpoint };

  const watchlistBy4h = { BTC: btc4h.map((c) => ({ ts: c.ts, close: c.close })) };
  const result = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
  const probe = result.find((r) => r.ts === btc4h[probeBarIndex].ts);

  assert.ok(probe, 'expected a regime point at the probe bar');
  // Correct: compare against the last CLOSED day's EMA200 (day 228) — the midpoint price
  // sits above that -> btcAboveEma200 true. Using the still-open day 229's EMA200 instead
  // (the look-ahead bug) would put the same price below it -> false.
  assert.equal(probe.metrics.btcAboveEma200, true);
});

test('computeRegimeSeries never produces NaN or Infinity in any numeric metric', () => {
  const btcDaily = makeDailySeries(225, (i) => 100 + i * 0.1);
  const btc4h = make4hSeries(225 * 6, (i) => 100 + Math.sin(i / 10)); // oscillating, exercises choppiness/ADX edge cases
  const watchlistBy4h = { BTC: btc4h.map((c) => ({ ts: c.ts, close: c.close })) };

  const result = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });

  for (const point of result) {
    for (const [key, value] of Object.entries(point.metrics)) {
      if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `metric ${key} was not finite: ${value}`);
      }
    }
  }
});
