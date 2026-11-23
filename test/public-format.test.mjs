import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatR, formatScorecardMessage, classifyRow, formatOutcome, escapeHtml, computeTrailStopLevel, buildTradeMarker, buildCandidateMarker, buildRegimeSegments, REGIME_COLORS, formatRegimeDuration, formatSetupStats, formatGuardrailUsage, buildConfigDiff, formatChecklistStatus, TAB_SECTIONS, getSectionId, computeVisibleRange, formatPct, formatRatio } from '../public-v2/js/format.mjs';

test('formatR shows a sign and 2 decimal places with an R suffix', () => {
  assert.equal(formatR(0.724), '+0.72R');
  assert.equal(formatR(-0.4), '-0.40R');
  assert.equal(formatR(0), '+0.00R');
});

test('formatScorecardMessage shows "not enough data yet" when notEnoughData is true', () => {
  const msg = formatScorecardMessage({ notEnoughData: true, divergedCount: 3, claudeMeanR: 0.1, defaultMeanR: 0.2, days: 30 });
  assert.match(msg, /not enough data/i);
  assert.match(msg, /3/); // still shows the count so far
});

test('formatScorecardMessage shows the Claude vs default comparison once there is enough data', () => {
  const msg = formatScorecardMessage({ notEnoughData: false, divergedCount: 120, claudeMeanR: 0.3, defaultMeanR: 0.1, days: 30 });
  assert.match(msg, /\+0\.30R/);
  assert.match(msg, /\+0\.10R/);
  assert.doesNotMatch(msg, /not enough data/i);
});

test('classifyRow marks a cycle with an error as "error"', () => {
  assert.equal(classifyRow({ error: 'claude cli failed', candidatesCount: 0, openedCount: 0, closedCount: 0 }), 'error');
});

test('classifyRow marks a cycle with opened/closed positions as "activity"', () => {
  assert.equal(classifyRow({ error: null, candidatesCount: 1, openedCount: 1, closedCount: 0 }), 'activity');
  assert.equal(classifyRow({ error: null, candidatesCount: 0, openedCount: 0, closedCount: 1 }), 'activity');
});

test('classifyRow marks a quiet cycle (no error, nothing opened or closed) as "quiet"', () => {
  assert.equal(classifyRow({ error: null, candidatesCount: 0, openedCount: 0, closedCount: 0 }), 'quiet');
});

test('formatOutcome shows the real trade R when a trade was taken', () => {
  const candidate = { trade: { r: 0.72, exitReason: 'target' }, shadowStatus: 'resolved', shadowR: 1.0 };
  assert.match(formatOutcome(candidate), /\+0\.72R/);
  assert.match(formatOutcome(candidate), /target/);
});

test('formatOutcome shows the shadow R when the candidate was skipped (no real trade)', () => {
  const candidate = { trade: null, shadowStatus: 'resolved', shadowR: 1.0, shadowExitReason: 'target' };
  assert.match(formatOutcome(candidate), /shadow/i);
  assert.match(formatOutcome(candidate), /\+1\.00R/);
});

test('formatOutcome says the shadow is still open when shadowStatus is "open"', () => {
  const candidate = { trade: null, shadowStatus: 'open' };
  assert.match(formatOutcome(candidate), /still open|pending/i);
});

test('escapeHtml neutralizes HTML special characters so a Claude-authored reason string can\'t inject markup', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b "quoted" \'single\''), 'a &amp; b &quot;quoted&quot; &#39;single&#39;');
});

test('escapeHtml passes plain text through unchanged', () => {
  assert.equal(escapeHtml('Setup valid, breadth falling, half size.'), 'Setup valid, breadth falling, half size.');
});

test('computeTrailStopLevel mirrors evaluateExit: ratchets up with the highest high, never below the initial stop', () => {
  const position = { entryPrice: 60000, initialStopPrice: 58000, atrAtEntry: 800, trailAtr: 2.5 };
  const candles = [{ high: 61000 }, { high: 62000 }, { high: 60500 }]; // peak 62000, then pulls back
  const level = computeTrailStopLevel(position, candles);
  assert.equal(level, 62000 - 2.5 * 800); // ratchets to the peak's trail level, doesn't fall back with price
});

test('computeTrailStopLevel never goes below the initial stop even with no favorable movement', () => {
  const position = { entryPrice: 58500, initialStopPrice: 58000, atrAtEntry: 800, trailAtr: 2.5 };
  const level = computeTrailStopLevel(position, []); // no candles since entry yet
  assert.equal(level, 58000);
});

test('computeTrailStopLevel seeds the highest-high with entryPrice, matching evaluateExit exactly (not just candle highs)', () => {
  // All post-entry candle highs are below entryPrice — evaluateExit's own highestHigh starts at
  // entryPrice (src/broker/paper.js), so the trail level must be computed from entryPrice here too,
  // not from -Infinity seeded only by candle highs. initialStopPrice is set to 0 so the floor
  // (Math.max(initialStopPrice, ...)) can never mask the difference between the two seeds —
  // a fixture where the floor binds either way would pass regardless of which seed is used.
  const position = { entryPrice: 60000, initialStopPrice: 0, atrAtEntry: 800, trailAtr: 2.5 };
  const candles = [{ high: 59000 }]; // below entryPrice
  const level = computeTrailStopLevel(position, candles);
  assert.equal(level, 60000 - 2.5 * 800); // trails off entryPrice (60000), not off the lower candle high (59000)
});

test('buildTradeMarker shows an up arrow for an entry-shaped point and a result-colored down arrow for an exit', () => {
  const trade = { entryTs: 1000, exitTs: 2000, r: 0.72, exitReason: 'target' };
  const markers = buildTradeMarker(trade);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].time, 1000);
  assert.equal(markers[0].position, 'belowBar');
  assert.equal(markers[1].time, 2000);
  assert.equal(markers[1].color, '#22c55e'); // positive R -> green
});

test('buildTradeMarker colors a losing exit red', () => {
  const markers = buildTradeMarker({ entryTs: 1000, exitTs: 2000, r: -0.5, exitReason: 'stop' });
  assert.equal(markers[1].color, '#ef4444');
});

test('buildCandidateMarker labels whether Claude took it, skipped it, or a fallback left it undecided', () => {
  const taken = buildCandidateMarker({ ts: 1000, setup: 'trend_pullback', decision: { action: 'take', model: 'claude-sonnet-5' } });
  assert.match(taken.text, /took|take/i);

  const skipped = buildCandidateMarker({ ts: 1000, setup: 'trend_pullback', decision: { action: 'skip', model: 'claude-sonnet-5' } });
  assert.match(skipped.text, /skip/i);

  const fallback = buildCandidateMarker({ ts: 1000, setup: 'trend_pullback', decision: { action: 'skip', model: 'fallback' } });
  assert.match(fallback.text, /fallback/i);
});

test('buildRegimeSegments collapses consecutive same-label rows into one segment', () => {
  const rows = [
    { ts: 1000, label: 'risk_off' }, { ts: 2000, label: 'risk_off' },
    { ts: 3000, label: 'trend_up' },
    { ts: 4000, label: 'risk_off' },
  ];
  const segments = buildRegimeSegments(rows);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].label, 'risk_off');
  assert.equal(segments[0].fromTs, 1000);
  assert.equal(segments[0].toTs, 2000);
  assert.equal(segments[1].label, 'trend_up');
  assert.equal(segments[2].label, 'risk_off');
});

test('REGIME_COLORS has a distinct, defined color for every regime label including risk_off', () => {
  for (const label of ['trend_up', 'range', 'downtrend', 'risk_off']) {
    assert.ok(REGIME_COLORS[label], `missing color for ${label}`);
  }
  const colors = Object.values(REGIME_COLORS);
  assert.equal(new Set(colors).size, colors.length); // all distinct
});

test('formatRegimeDuration reports "not yet known" when there is no regime history at all', () => {
  assert.equal(formatRegimeDuration([], 10000), 'not yet known');
});

test('formatRegimeDuration reports how long the current (last) segment has been active', () => {
  const rows = [{ ts: 0, label: 'risk_off' }, { ts: 3600, label: 'risk_off' }, { ts: 7200, label: 'trend_up' }];
  const nowTs = 7200 + 3600; // 1h into the trend_up segment
  const result = formatRegimeDuration(rows, nowTs);
  assert.match(result, /1h/);
});

test('formatSetupStats reports "No trades yet" for a zero-count stat, not a 0% win rate', () => {
  const result = formatSetupStats({ count: 0, winRate: 0, expectancy: 0, pass: false });
  assert.match(result, /no trades yet/i);
  assert.doesNotMatch(result, /0%/);
});

test('formatSetupStats reports count/winRate/expectancy for a real sample', () => {
  const result = formatSetupStats({ count: 12, winRate: 0.58, expectancy: 0.34, pass: false });
  assert.match(result, /12/);
  assert.match(result, /58%/);
  assert.match(result, /\+0\.34R/);
});

test('formatGuardrailUsage reports a "used / max" text and a percentage, capped at 100', () => {
  assert.deepEqual(formatGuardrailUsage({ used: 1, max: 3 }), { text: '1 / 3', pct: 33 });
  assert.deepEqual(formatGuardrailUsage({ used: 0.015, max: 0.015 }), { text: '0.015 / 0.015', pct: 100 });
});

test('buildConfigDiff reports a risk level change', () => {
  const diff = buildConfigDiff(
    { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} },
    { riskLevel: 'cautious', disabledSetups: [], rangeOverrides: {} },
  );
  assert.equal(diff.length, 1);
  assert.match(diff[0], /risk level.*normal.*cautious/i);
});

test('buildConfigDiff reports a setup being disabled', () => {
  const diff = buildConfigDiff(
    { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} },
    { riskLevel: 'normal', disabledSetups: ['trend_breakout'], rangeOverrides: {} },
  );
  assert.equal(diff.length, 1);
  assert.match(diff[0], /trend_breakout.*disabled/i);
});

test('buildConfigDiff reports a setup being re-enabled', () => {
  const diff = buildConfigDiff(
    { riskLevel: 'normal', disabledSetups: ['trend_breakout'], rangeOverrides: {} },
    { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} },
  );
  assert.equal(diff.length, 1);
  assert.match(diff[0], /trend_breakout.*enabled/i);
});

test('buildConfigDiff returns an empty array when nothing changed', () => {
  const config = { riskLevel: 'normal', disabledSetups: ['oversold_bounce'], rangeOverrides: {} };
  const diff = buildConfigDiff(config, { ...config, disabledSetups: ['oversold_bounce'] });
  assert.deepEqual(diff, []);
});

test('buildConfigDiff reports multiple simultaneous changes', () => {
  const diff = buildConfigDiff(
    { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} },
    { riskLevel: 'bold', disabledSetups: ['trend_breakout', 'oversold_bounce'], rangeOverrides: {} },
  );
  assert.equal(diff.length, 3); // risk level + 2 setups disabled
});

test('formatChecklistStatus shows a done icon for pass: true', () => {
  assert.deepEqual(formatChecklistStatus(true), { icon: '✅', label: 'Done' });
});

test('formatChecklistStatus shows a not-yet icon for pass: false', () => {
  assert.deepEqual(formatChecklistStatus(false), { icon: '❌', label: 'Not yet' });
});

test('formatChecklistStatus shows a pending icon for pass: null', () => {
  assert.deepEqual(formatChecklistStatus(null), { icon: '⏳', label: 'Pending' });
});

test('getSectionId maps every known tab key to its section id', () => {
  assert.equal(getSectionId('decisionLog'), 'decision-log-tab');
  assert.equal(getSectionId('charts'), 'charts-tab');
  assert.equal(getSectionId('strategy'), 'strategy-tab');
  assert.equal(getSectionId('golive'), 'golive-tab');
});

test('getSectionId returns undefined for an unknown tab key', () => {
  assert.equal(getSectionId('nonsense'), undefined);
});

test('TAB_SECTIONS lists all 4 tabs in display order', () => {
  assert.deepEqual(Object.keys(TAB_SECTIONS), ['decisionLog', 'charts', 'strategy', 'golive']);
});

test('computeVisibleRange returns a from/to window ending at the latest candle', () => {
  const latestTs = 1700000000;
  assert.deepEqual(computeVisibleRange(30, latestTs), { from: latestTs - 30 * 86400, to: latestTs });
});

test('computeVisibleRange for 1 week uses 7 days', () => {
  const latestTs = 1700000000;
  assert.deepEqual(computeVisibleRange(7, latestTs), { from: latestTs - 7 * 86400, to: latestTs });
});

test('computeVisibleRange returns null for the ALL preset (caller uses fitContent instead)', () => {
  assert.equal(computeVisibleRange(null, 1700000000), null);
});

test('formatPct shows a sign and 1 decimal place as a percentage', () => {
  assert.equal(formatPct(0.012), '+1.2%');
  assert.equal(formatPct(-0.079), '-7.9%');
  assert.equal(formatPct(0), '+0.0%');
});

test('formatRatio shows 2 decimal places', () => {
  assert.equal(formatRatio(0.67), '0.67');
});

test('formatRatio shows n/a for a null ratio (zero drawdown, nothing to divide by)', () => {
  assert.equal(formatRatio(null), 'n/a');
});
