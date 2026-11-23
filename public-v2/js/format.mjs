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

export function formatRegimeDuration(historyRows, nowTs) {
  const segments = buildRegimeSegments(historyRows);
  if (segments.length === 0) return 'not yet known';
  const current = segments[segments.length - 1];
  const heldSeconds = nowTs - current.fromTs;
  const hours = Math.floor(heldSeconds / 3600);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${current.label}, held for ${days}d ${hours % 24}h`;
  return `${current.label}, held for ${hours}h`;
}

export function formatSetupStats(stats) {
  if (stats.count === 0) return 'No trades yet.';
  return `${stats.count} trades, ${Math.round(stats.winRate * 100)}% win rate, ${formatR(stats.expectancy)} expectancy`;
}

export function formatGuardrailUsage({ used, max }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return { text: `${used} / ${max}`, pct };
}

export const TAB_SECTIONS = {
  decisionLog: 'decision-log-tab', charts: 'charts-tab', strategy: 'strategy-tab', golive: 'golive-tab',
};

export function getSectionId(tabKey) {
  return TAB_SECTIONS[tabKey];
}

export function formatChecklistStatus(pass) {
  if (pass === true) return { icon: '✅', label: 'Done' };
  if (pass === false) return { icon: '❌', label: 'Not yet' };
  return { icon: '⏳', label: 'Pending' };
}

export function buildConfigDiff(activeConfig, pendingConfig) {
  const lines = [];
  if (activeConfig.riskLevel !== pendingConfig.riskLevel) {
    lines.push(`Risk level: ${activeConfig.riskLevel} → ${pendingConfig.riskLevel}`);
  }
  const allSetups = new Set([...activeConfig.disabledSetups, ...pendingConfig.disabledSetups]);
  for (const setup of allSetups) {
    const wasDisabled = activeConfig.disabledSetups.includes(setup);
    const willBeDisabled = pendingConfig.disabledSetups.includes(setup);
    if (wasDisabled !== willBeDisabled) {
      lines.push(`${setup}: ${willBeDisabled ? 'enabled → disabled' : 'disabled → enabled'}`);
    }
  }
  return lines;
}
