import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatR, formatScorecardMessage } from '../public-v2/js/format.mjs';

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
