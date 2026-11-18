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

module.exports = { parseOhlcvtCsv };
