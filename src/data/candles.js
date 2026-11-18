'use strict';

function parseOhlcvtCsv(csvText) {
  const rows = [];
  let skipped = 0;
  for (const line of csvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(',');
    if (fields.length !== 7) {
      skipped += 1;
      continue;
    }
    const [ts, open, high, low, close, volume, trades] = fields.map(Number);
    if ([ts, open, high, low, close, volume, trades].some(Number.isNaN)) {
      skipped += 1;
      continue;
    }
    rows.push({ ts, open, high, low, close, volume, trades });
  }
  return { rows, skipped };
}

function aggregateCandles(candles1h, bucketSeconds) {
  if (candles1h.length === 0) return [];
  const lastChildTs = candles1h[candles1h.length - 1].ts;
  const buckets = new Map();

  for (const c of candles1h) {
    const bucketStart = Math.floor(c.ts / bucketSeconds) * bucketSeconds;
    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, { ts: bucketStart, children: [] });
    }
    buckets.get(bucketStart).children.push(c);
  }

  const result = [];
  for (const [bucketStart, { children }] of buckets) {
    children.sort((a, b) => a.ts - b.ts);
    const first = children[0];
    const last = children[children.length - 1];
    const allTradesNull = children.every((c) => c.trades === null || c.trades === undefined);
    result.push({
      ts: bucketStart,
      open: first.open,
      close: last.close,
      high: Math.max(...children.map((c) => c.high)),
      low: Math.min(...children.map((c) => c.low)),
      volume: children.reduce((sum, c) => sum + c.volume, 0),
      trades: allTradesNull ? null : children.reduce((sum, c) => sum + (c.trades || 0), 0),
      closed: bucketStart + bucketSeconds <= lastChildTs + 3600,
    });
  }
  return result.sort((a, b) => a.ts - b.ts);
}

function findGapHours(existingTs, fromTs, toTs, stepSeconds = 3600) {
  const existing = new Set(existingTs);
  const gaps = [];
  for (let ts = fromTs; ts <= toTs; ts += stepSeconds) {
    if (!existing.has(ts)) gaps.push(ts);
  }
  return gaps;
}

module.exports = { parseOhlcvtCsv, aggregateCandles, findGapHours };
