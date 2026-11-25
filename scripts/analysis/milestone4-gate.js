'use strict';
// Re-runs the milestone 4 gate (per CLAUDE.md / docs/v2-design.md §Pass/fail point) with the
// look-ahead fixes in src/broker/paper.js and src/backtest/run.js applied, under Tier 1 fees,
// over 3 windows. Report only — never touches config_versions, DEFAULT_RISK_CONFIG, or any
// live-affecting state.
//
// Usage: node scripts/analysis/milestone4-gate.js

const fs = require('fs');
const path = require('path');
const { openDb, getCandles } = require('../../src/data/db');
const { runBacktest } = require('../../src/backtest/run');
const { computeExpectancy, computeDrawdown } = require('../../src/backtest/stats');
const { DEFAULT_RISK_CONFIG, COINS } = require('../../src/engine/config');
const { SETUPS_BY_REGIME } = require('../../src/engine/playbook');
const { ema } = require('../../src/engine/indicators');
const { simulateEmaEquity } = require('./opportunity');

const HOUR = 3600, DAY = 24 * HOUR;
const NOW_TS = Math.floor(Date.UTC(2026, 10, 24, 0, 0, 0) / 1000); // 2026-11-24T00:00:00Z — same anchor as opportunity.js

function monthsBefore(endTs, months) {
  const d = new Date(endTs * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate()) / 1000);
}

const WINDOWS = [
  { key: '6mo', label: 'Last 6 months', startTs: monthsBefore(NOW_TS, 6) },
  { key: '2yr', label: 'Last 2 years', startTs: monthsBefore(NOW_TS, 24) },
  { key: '4yr', label: 'Last 4 years', startTs: monthsBefore(NOW_TS, 48) },
];

// Tier 1, as given this time: 0.40% maker + 0.80% taker + 0.1% spread/slippage = 1.3% round trip.
// Same total as the Tier 1 used in opportunity.js, so the two reports are comparable.
const TIER1_FEES = { makerPct: 0.004, takerPct: 0.008 };
const TIER1_SLIPPAGE_PCT = 0.001;
const TIER1_ROUND_TRIP_PCT = 1.3;

function tier1Config() {
  // Both the pre-trade fee-viability gate and the actual fill simulation use the same Tier 1
  // round trip — internally consistent with "re-run under Tier 1", at the cost of a stricter
  // gate (atrPct >= 1.3% * 4 = 5.2%, vs production's 0.65% * 4 = 2.6%) that admits far fewer
  // candidates. See productionGateConfig() for the complementary, less-starved comparison.
  return { ...DEFAULT_RISK_CONFIG, roundTripFeePct: TIER1_ROUND_TRIP_PCT, fees: TIER1_FEES, slippagePct: TIER1_SLIPPAGE_PCT };
}

function productionGateConfig() {
  // Keeps the gate at production's current threshold (0.65% round trip, unchanged from
  // DEFAULT_RISK_CONFIG) but still charges Tier 1 fees on every actual fill — i.e. "what the
  // system would really do today, with the look-ahead fixes and real Tier 1 costs applied to
  // the trades it actually takes," rather than also tightening which candidates it considers.
  return { ...DEFAULT_RISK_CONFIG, fees: TIER1_FEES, slippagePct: TIER1_SLIPPAGE_PCT };
}

function tradeNetPct(trade) {
  const stakeValue = trade.units * trade.entryPrice;
  return (trade.pnl / stakeValue) * 100;
}

function summarizeSetup(trades) {
  const { count, winRate, expectancy, pass } = computeExpectancy(trades);
  const netPcts = trades.map(tradeNetPct);
  const avgNetPct = netPcts.length ? netPcts.reduce((a, b) => a + b, 0) / netPcts.length : null;
  return { trades: count, winRate, avgNetPct, expectancyR: expectancy, gatePass: pass };
}

function buyAndHoldBtc(db, startTs, endTs) {
  const closes = getCandles(db, 'BTC', '1d', startTs, endTs).map((c) => c.close);
  if (closes.length < 2) return null;
  const rawReturnPct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  const { maxDrawdownPct } = computeDrawdown(closes);
  return { returnPct: rawReturnPct - TIER1_ROUND_TRIP_PCT, maxDrawdownPct: maxDrawdownPct * 100, trades: 1 };
}

function btc200DayRule(db, startTs, endTs) {
  const all = getCandles(db, 'BTC', '1d', 0, endTs);
  const closes = all.map((c) => c.close);
  const timestamps = all.map((c) => c.ts);
  const emaArr = ema(closes, 200);
  const { trades, series } = simulateEmaEquity(closes, emaArr, timestamps, startTs, endTs, TIER1_ROUND_TRIP_PCT);
  if (series.length < 2) return null;
  const equities = series.map((s) => s.equity);
  const returnPct = ((equities[equities.length - 1] - equities[0]) / equities[0]) * 100;
  const { maxDrawdownPct } = computeDrawdown(equities);
  return { returnPct, maxDrawdownPct: maxDrawdownPct * 100, trades: trades.length };
}

function fmtPct(v, dp = 2) { return v === null || v === undefined || Number.isNaN(v) ? 'n/a' : `${v.toFixed(dp)}%`; }
function fmtDate(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

function runWindow(db, win, config) {
  const result = runBacktest(db, config, win.startTs, SETUPS_BY_REGIME, {});

  const bySetup = {};
  for (const trade of result.state.closedTrades) {
    (bySetup[trade.setup] = bySetup[trade.setup] || []).push(trade);
  }
  const setupNames = Object.keys(SETUPS_BY_REGIME).flatMap((regime) => SETUPS_BY_REGIME[regime]);
  const uniqueSetups = [...new Set(setupNames)];
  const setupSummaries = uniqueSetups.map((name) => ({ setup: name, ...summarizeSetup(bySetup[name] || []) }));
  const allSummary = { setup: 'ALL', ...summarizeSetup(result.state.closedTrades) };

  const bh = buyAndHoldBtc(db, win.startTs, NOW_TS);
  const rule200 = btc200DayRule(db, win.startTs, NOW_TS);

  return { win, setupSummaries, allSummary, bh, rule200, totalTrades: result.state.closedTrades.length, finalBalance: result.state.balance };
}

function windowTable(result) {
  const lines = [
    '| Row | Trades | Win rate | Net %/trade | Expectancy R | Gate (30+, R>0) |',
    '|---|---|---|---|---|---|',
  ];
  for (const s of [...result.setupSummaries, result.allSummary]) {
    lines.push(`| ${s.setup} | ${s.trades} | ${s.trades ? (s.winRate * 100).toFixed(0) + '%' : 'n/a'} | ${fmtPct(s.avgNetPct)} | ${s.trades ? s.expectancyR.toFixed(2) + 'R' : 'n/a'} | ${s.trades ? (s.gatePass ? 'PASS' : 'FAIL') : 'n/a (0 trades)'} |`);
  }
  lines.push('');
  lines.push('| Benchmark | Return % | Max drawdown % | Trades |');
  lines.push('|---|---|---|---|');
  lines.push(`| BTC buy-and-hold | ${result.bh ? fmtPct(result.bh.returnPct) : 'n/a'} | ${result.bh ? fmtPct(result.bh.maxDrawdownPct) : 'n/a'} | ${result.bh ? result.bh.trades : 'n/a'} |`);
  lines.push(`| BTC 200-day EMA rule | ${result.rule200 ? fmtPct(result.rule200.returnPct) : 'n/a'} | ${result.rule200 ? fmtPct(result.rule200.maxDrawdownPct) : 'n/a'} | ${result.rule200 ? result.rule200.trades : 'n/a'} |`);
  return lines.join('\n');
}

function summaryLine(r) {
  const passing = r.setupSummaries.filter((s) => s.trades > 0 && s.gatePass).map((s) => s.setup);
  const failing = r.setupSummaries.filter((s) => s.trades > 0 && !s.gatePass).map((s) => s.setup);
  const noTrades = r.setupSummaries.filter((s) => s.trades === 0).map((s) => s.setup);
  return `- **${r.win.label}**: ${passing.length ? `passing: ${passing.join(', ')}` : 'no setup passes'}${failing.length ? `; failing: ${failing.join(', ')}` : ''}${noTrades.length ? `; no trades: ${noTrades.join(', ')}` : ''}.`;
}

function writeVariantCsv(outDir, filename, results) {
  const csvRows = [];
  for (const r of results) {
    for (const s of [...r.setupSummaries, r.allSummary]) {
      csvRows.push({
        window: r.win.key, setup: s.setup, trades: s.trades,
        winRate: s.trades ? (s.winRate * 100).toFixed(1) : '', avgNetPct: s.avgNetPct?.toFixed(2) ?? '',
        expectancyR: s.trades ? s.expectancyR.toFixed(2) : '', gatePass: s.trades ? s.gatePass : '',
      });
    }
  }
  const csvHeaders = ['window', 'setup', 'trades', 'winRate', 'avgNetPct', 'expectancyR', 'gatePass'];
  const esc = (v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v);
  fs.writeFileSync(path.join(outDir, 'data', filename),
    [csvHeaders.join(','), ...csvRows.map((r) => csvHeaders.map((h) => esc(r[h])).join(','))].join('\n') + '\n');
}

function main() {
  const db = openDb();
  const tier1GateResults = WINDOWS.map((win) => runWindow(db, win, tier1Config()));
  const productionGateResults = WINDOWS.map((win) => runWindow(db, win, productionGateConfig()));

  const outDir = path.join(__dirname, '..', '..', 'docs', 'analysis');
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  writeVariantCsv(outDir, 'milestone4-gate-tier1-consistent.csv', tier1GateResults);
  writeVariantCsv(outDir, 'milestone4-gate-production-gate.csv', productionGateResults);

  const lines = [];
  lines.push('# Milestone 4 gate re-run — 2026-11, Tier 1 fees, post look-ahead fixes');
  lines.push('');
  lines.push(`Tier 1: 0.40% maker + 0.80% taker + 0.1% spread/slippage = **${TIER1_ROUND_TRIP_PCT}% round trip** — applied to every actual fill in both variants below (previously the simulated fill always used broker/paper.js's own hardcoded defaults regardless of config; the look-ahead fix commit added the additive wiring that makes this override possible).`);
  lines.push('');
  lines.push(`Run after fixing two look-ahead bugs in src/broker/paper.js / src/backtest/run.js / src/scheduler/cycle.js (trailing-stop same-candle sequencing; the entry bar's own hourly candles leaking into the very first post-entry exit check). Windows end ${fmtDate(NOW_TS)}.`);
  lines.push('');
  lines.push('Gate criterion (CLAUDE.md / docs/v2-design.md): a setup passes if it has 30+ trades and positive expectancy (R) after fees.');
  lines.push('');
  lines.push('**Two variants, because the pre-trade fee-viability gate (atrPct >= roundTripFeePct × feeViabilityMultiple) and the fee actually charged on a fill are separate config fields:**');
  lines.push('');
  lines.push(`- **Tier-1-consistent**: the gate ALSO uses the 1.3% Tier 1 round trip (so it only admits candidates whose typical 4h move is >= 5.2%) — fully consistent with "re-run under Tier 1", but a much stricter admission bar than production uses today.`);
  lines.push(`- **Production gate**: the gate stays at production's current 0.65% round trip (admits candidates whose move is >= 2.6%, exactly what the live system would consider today) — only the fill itself is charged at the real Tier 1 rate. This answers "what would the system actually do today, correctly, at real Tier 1 cost."`);
  lines.push('');

  lines.push('## Tier-1-consistent gate (strict admission)');
  lines.push('');
  for (const r of tier1GateResults) {
    lines.push(`### ${r.win.label} (from ${fmtDate(r.win.startTs)})`);
    lines.push('');
    lines.push(`Total trades across all setups: ${r.totalTrades}. Final balance: £${r.finalBalance.toFixed(2)} (started £1000).`);
    lines.push('');
    lines.push(windowTable(r));
    lines.push('');
  }

  lines.push('## Production gate, Tier 1 fills');
  lines.push('');
  for (const r of productionGateResults) {
    lines.push(`### ${r.win.label} (from ${fmtDate(r.win.startTs)})`);
    lines.push('');
    lines.push(`Total trades across all setups: ${r.totalTrades}. Final balance: £${r.finalBalance.toFixed(2)} (started £1000).`);
    lines.push('');
    lines.push(windowTable(r));
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('**Tier-1-consistent gate:**');
  lines.push('');
  for (const r of tier1GateResults) lines.push(summaryLine(r));
  lines.push('');
  lines.push('**Production gate, Tier 1 fills:**');
  lines.push('');
  for (const r of productionGateResults) lines.push(summaryLine(r));
  lines.push('');
  lines.push('Full per-row data: `docs/analysis/data/milestone4-gate-tier1-consistent.csv`, `milestone4-gate-production-gate.csv`.');
  lines.push('');

  fs.writeFileSync(path.join(outDir, 'milestone4-gate-2026-11.md'), lines.join('\n'));
  console.log('Wrote docs/analysis/milestone4-gate-2026-11.md and CSVs in docs/analysis/data/');
}

if (require.main === module) main();

module.exports = { tier1Config, tradeNetPct, summarizeSetup, buyAndHoldBtc, btc200DayRule };
