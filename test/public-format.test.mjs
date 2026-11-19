import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatR, formatScorecardMessage, classifyRow, formatOutcome } from '../public-v2/js/format.mjs';

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
