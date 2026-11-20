export function formatR(value) {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${Math.abs(value).toFixed(2)}R`;
}

export function formatScorecardMessage({ notEnoughData, divergedCount, claudeMeanR, defaultMeanR, days }) {
  if (notEnoughData) {
    return `Not enough data yet (${divergedCount} override${divergedCount === 1 ? '' : 's'} so far — need about 100).`;
  }
  return `Over the last ${days} days: Claude averaged ${formatR(claudeMeanR)} per overridden trade vs ${formatR(defaultMeanR)} for the untouched default.`;
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function classifyRow({ error, candidatesCount, openedCount, closedCount }) {
  if (error) return 'error';
  if (openedCount > 0 || closedCount > 0) return 'activity';
  return 'quiet';
}

export function formatOutcome(candidate) {
  if (candidate.trade) {
    return `Real trade: ${formatR(candidate.trade.r)} (${candidate.trade.exitReason}).`;
  }
  if (candidate.shadowStatus === 'open') {
    return 'Shadow (what the default would have done) is still open, pending.';
  }
  return `Shadow outcome (not actually taken): ${formatR(candidate.shadowR)} (${candidate.shadowExitReason}).`;
}

export function computeTrailStopLevel(position, candlesSinceEntry) {
  // Seeded with entryPrice, matching evaluateExit's own highestHigh seed (src/broker/paper.js) —
  // seeding at -Infinity would understate the trail level whenever every post-entry candle high
  // stays below entryPrice, showing a lower stop on the chart than the position would actually use.
  const highestHigh = candlesSinceEntry.reduce((max, c) => Math.max(max, c.high), position.entryPrice);
  return Math.max(position.initialStopPrice, highestHigh - position.trailAtr * position.atrAtEntry);
}

export function buildTradeMarker(trade) {
  const color = trade.r >= 0 ? '#22c55e' : '#ef4444';
  return [
    { time: trade.entryTs, position: 'belowBar', shape: 'arrowUp', color: '#8b92a5', text: 'entry' },
    { time: trade.exitTs, position: 'aboveBar', shape: 'arrowDown', color, text: `${trade.exitReason} ${formatR(trade.r)}` },
  ];
}

export function buildCandidateMarker(candidate) {
  const { decision } = candidate;
  let text;
  if (!decision) text = `${candidate.setup}: no decision recorded`;
  else if (decision.model === 'fallback') text = `${candidate.setup}: fallback (Claude call failed)`;
  else if (decision.action === 'take') text = `${candidate.setup}: Claude took it`;
  else text = `${candidate.setup}: Claude skipped it`;
  return { time: candidate.ts, position: 'inBar', shape: 'circle', color: '#8b92a5', size: 0.5, text };
}

export const REGIME_COLORS = { trend_up: '#22c55e', range: '#d97706', downtrend: '#ef4444', risk_off: '#6b7280' };

export function buildRegimeSegments(historyRows) {
  const segments = [];
  for (const row of historyRows) {
    const last = segments[segments.length - 1];
    if (last && last.label === row.label) {
      last.toTs = row.ts;
    } else {
      segments.push({ fromTs: row.ts, toTs: row.ts, label: row.label });
    }
  }
  return segments;
}
