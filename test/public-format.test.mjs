import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatR, formatScorecardMessage, classifyRow, formatOutcome, escapeHtml, computeTrailStopLevel, buildTradeMarker, buildCandidateMarker } from '../public-v2/js/format.mjs';

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
  const position = { initialStopPrice: 58000, atrAtEntry: 800, trailAtr: 2.5 };
  const candles = [{ high: 61000 }, { high: 62000 }, { high: 60500 }]; // peak 62000, then pulls back
  const level = computeTrailStopLevel(position, candles);
  assert.equal(level, 62000 - 2.5 * 800); // ratchets to the peak's trail level, doesn't fall back with price
});

test('computeTrailStopLevel never goes below the initial stop even with no favorable movement', () => {
  const position = { initialStopPrice: 58000, atrAtEntry: 800, trailAtr: 2.5 };
  const level = computeTrailStopLevel(position, []); // no candles since entry yet
  assert.equal(level, 58000);
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
