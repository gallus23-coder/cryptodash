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

export function classifyRow({ error, candidatesCount, openedCount, closedCount }) {
  if (error) return 'error';
  if (openedCount > 0 || closedCount > 0) return 'activity';
  return 'quiet';
}
