'use strict';

function computeTradeR(pnl, riskAmount) {
  return pnl / riskAmount;
}

function computeExpectancy(trades) {
  if (trades.length === 0) return { count: 0, winRate: 0, expectancy: 0, pass: false };
  const totalR = trades.reduce((sum, t) => sum + t.r, 0);
  const expectancy = totalR / trades.length;
  const wins = trades.filter((t) => t.r > 0).length;
  const winRate = wins / trades.length;
  const pass = expectancy > 0 && trades.length >= 30;
  return { count: trades.length, winRate, expectancy, pass };
}

function computeDrawdown(values) {
  let peak = values.length > 0 ? values[0] : 0;
  let maxDrawdownPct = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - v) / peak);
  }
  return { peak, maxDrawdownPct };
}

function computeBenchmarkComparison({ botSeries, btcSeries }) {
  function summarize(series) {
    const returnPct = series.length > 1 ? (series[series.length - 1] - series[0]) / series[0] : 0;
    const { maxDrawdownPct } = computeDrawdown(series);
    const ratio = maxDrawdownPct === 0 ? null : returnPct / maxDrawdownPct;
    return { returnPct, worstDrawdownPct: maxDrawdownPct, ratio };
  }

  return {
    bot: summarize(botSeries),
    btc: summarize(btcSeries),
    cash: { returnPct: 0, worstDrawdownPct: 0, ratio: null },
  };
}

module.exports = { computeTradeR, computeExpectancy, computeDrawdown, computeBenchmarkComparison };
