'use strict';

function parseOhlcvtCsv(csvText) {
  const rows = [];
  let skipped = 0;
  for (const line of csvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(',');
    if (fields.length !== 7 || fields.some((f) => f.trim() === '')) {
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

function aggregateCandles(candles1h, bucketSeconds, { nowTs } = {}) {
  if (candles1h.length === 0) return [];
  const lastChildTs = candles1h[candles1h.length - 1].ts;
  const referenceTs = nowTs !== undefined ? nowTs : lastChildTs + 3600;
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
      closed: bucketStart + bucketSeconds <= referenceTs,
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

function buildCandlesFromTrades(trades, rangeEndTs) {
  const buckets = new Map();
  for (const t of trades) {
    const bucketStart = Math.floor(t.time / 3600) * 3600;
    if (bucketStart + 3600 > rangeEndTs) continue; // forming or out-of-range hour
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart).push(t);
  }

  const result = [];
  for (const [bucketStart, bucketTrades] of buckets) {
    bucketTrades.sort((a, b) => a.time - b.time);
    result.push({
      ts: bucketStart,
      open: bucketTrades[0].price,
      close: bucketTrades[bucketTrades.length - 1].price,
      high: Math.max(...bucketTrades.map((t) => t.price)),
      low: Math.min(...bucketTrades.map((t) => t.price)),
      volume: bucketTrades.reduce((sum, t) => sum + t.volume, 0),
      trades: bucketTrades.length,
      closed: true,
    });
  }
  return result.sort((a, b) => a.ts - b.ts);
}

function filterOutlierCandles(candles, maxHighLowRatio = 10) {
  let dropped = 0;
  const filtered = candles.filter((c) => {
    if (c.low <= 0 || c.high / c.low > maxHighLowRatio) {
      dropped += 1;
      return false;
    }
    return true;
  });
  return { candles: filtered, dropped };
}

module.exports = { parseOhlcvtCsv, aggregateCandles, findGapHours, buildCandlesFromTrades, filterOutlierCandles };
