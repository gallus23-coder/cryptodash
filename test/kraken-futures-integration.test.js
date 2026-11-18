'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFuturesClient } = require('../src/kraken/futures');

test('real Kraken Futures tickers include PF_XBTUSD funding/OI', async () => {
  const client = createFuturesClient({});
  const tickers = await client.getTickers();
  const ctx = client.getFundingContext(tickers, 'PF_XBTUSD');
  assert.ok(ctx, 'expected to find PF_XBTUSD in the tickers list');
  assert.equal(typeof ctx.fundingRate, 'number');
  assert.equal(typeof ctx.openInterest, 'number');
  assert.equal(typeof ctx.fundingRatePct, 'number');
  assert.ok(Math.abs(ctx.fundingRatePct) < 5, `expected a small percentage, got ${ctx.fundingRatePct} — fundingRate units may have changed`);
});
