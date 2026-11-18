'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createFuturesClient } = require('../src/kraken/futures');

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('getTickers fetches /tickers and returns the tickers array', async () => {
  const server = await startMockServer((req, res) => {
    res.end(JSON.stringify({
      result: 'success',
      tickers: [{ symbol: 'PF_XBTUSD', fundingRate: 0.0001, fundingRatePrediction: 0.0002, openInterest: 12345 }],
    }));
  });
  const { port } = server.address();
  const client = createFuturesClient({ baseUrl: `http://127.0.0.1:${port}` });

  const tickers = await client.getTickers();

  assert.equal(tickers.length, 1);
  assert.equal(tickers[0].symbol, 'PF_XBTUSD');
  server.close();
});

test('getTickers throws when Kraken Futures reports an error result', async () => {
  const server = await startMockServer((req, res) => {
    res.end(JSON.stringify({ result: 'error', error: 'someError' }));
  });
  const { port } = server.address();
  const client = createFuturesClient({ baseUrl: `http://127.0.0.1:${port}` });

  await assert.rejects(() => client.getTickers());
  server.close();
});

test('getFundingContext extracts funding/OI fields for a known symbol', () => {
  const client = createFuturesClient({});
  const tickers = [{ symbol: 'PF_XBTUSD', fundingRate: 0.0001, fundingRatePrediction: 0.0002, openInterest: 12345 }];

  const ctx = client.getFundingContext(tickers, 'PF_XBTUSD');

  assert.deepEqual(ctx, { symbol: 'PF_XBTUSD', fundingRate: 0.0001, fundingRatePrediction: 0.0002, openInterest: 12345 });
});

test('getFundingContext returns null for an unknown symbol', () => {
  const client = createFuturesClient({});
  assert.equal(client.getFundingContext([], 'PF_XBTUSD'), null);
});
