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

test('getFundingContext converts the absolute fundingRate to a percentage of markPrice', () => {
  // Confirmed against the real API (2026-11-18): fundingRate/fundingRatePrediction
  // are absolute quote-currency amounts, not fractions of price — e.g. PF_XBTUSD
  // returned fundingRate: -0.1604697 against markPrice: 64022.37, i.e. about
  // -0.00025% per period, not -16%. Must divide by markPrice before use.
  const client = createFuturesClient({});
  const tickers = [{
    symbol: 'PF_XBTUSD', fundingRate: -0.1604697, fundingRatePrediction: 0.6826404,
    openInterest: 12345, markPrice: 64022.3737,
  }];

  const ctx = client.getFundingContext(tickers, 'PF_XBTUSD');

  assert.deepEqual(ctx, {
    symbol: 'PF_XBTUSD',
    fundingRate: -0.1604697,
    fundingRatePrediction: 0.6826404,
    openInterest: 12345,
    fundingRatePct: (-0.1604697 / 64022.3737) * 100,
    fundingRatePredictionPct: (0.6826404 / 64022.3737) * 100,
  });
  assert.ok(ctx.fundingRatePct < 0 && ctx.fundingRatePct > -0.001, `expected a tiny negative percentage, got ${ctx.fundingRatePct}`);
});

test('getFundingContext returns null percentages when markPrice is missing', () => {
  const client = createFuturesClient({});
  const tickers = [{ symbol: 'PF_XBTUSD', fundingRate: -0.16, fundingRatePrediction: 0.68, openInterest: 12345 }];

  const ctx = client.getFundingContext(tickers, 'PF_XBTUSD');

  assert.equal(ctx.fundingRatePct, null);
  assert.equal(ctx.fundingRatePredictionPct, null);
});

test('getTickers aborts with a TimeoutError when the server is too slow', async () => {
  const server = await startMockServer((req, res) => {
    setTimeout(() => res.end(JSON.stringify({ result: 'success', tickers: [] })), 300);
  });
  const { port } = server.address();
  const client = createFuturesClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 50 });

  await assert.rejects(
    () => client.getTickers(),
    (err) => err.name === 'TimeoutError',
  );
  server.close();
});

test('getFundingContext returns null for an unknown symbol', () => {
  const client = createFuturesClient({});
  assert.equal(client.getFundingContext([], 'PF_XBTUSD'), null);
});
