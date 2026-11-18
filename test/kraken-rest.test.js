'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { createRestClient, KrakenApiError } = require('../src/kraken/rest');

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function expectedSignature(path, postdata, nonce, secretB64) {
  const secret = Buffer.from(secretB64, 'base64');
  const hash = crypto.createHash('sha256').update(nonce + postdata).digest('binary');
  return crypto.createHmac('sha512', secret).update(path, 'latin1').update(hash, 'binary').digest('base64');
}

test('publicRequest GETs /0/public/<endpoint> with query params, no auth headers', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    captured = { method: req.method, url: req.url, headers: req.headers };
    res.end(JSON.stringify({ error: [], result: { unixtime: 123 } }));
  });
  const { port } = server.address();
  const client = createRestClient({ baseUrl: `http://127.0.0.1:${port}` });

  const result = await client.publicRequest('Time', {});

  assert.equal(captured.method, 'GET');
  assert.equal(captured.url, '/0/public/Time');
  assert.equal(captured.headers['api-key'], undefined);
  assert.deepEqual(result, { unixtime: 123 });
  server.close();
});

test('privateRequest POSTs /0/private/<endpoint> with a correctly-signed body', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      captured = { method: req.method, url: req.url, headers: req.headers, body };
      res.end(JSON.stringify({ error: [], result: { ZGBP: '100.0000' } }));
    });
  });
  const { port } = server.address();
  const secret = Buffer.from('test-secret').toString('base64');
  let nonceCalls = 0;
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    apiSecret: secret,
    getNonce: () => 1700000000000 + (nonceCalls++),
  });

  const result = await client.privateRequest('Balance', {});

  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/0/private/Balance');
  assert.equal(captured.headers['api-key'], 'test-key');
  assert.equal(captured.body, 'nonce=1700000000000');
  const expected = expectedSignature('/0/private/Balance', 'nonce=1700000000000', '1700000000000', secret);
  assert.equal(captured.headers['api-sign'], expected);
  assert.deepEqual(result, { ZGBP: '100.0000' });
  server.close();
});

test('privateRequest rejects with KrakenApiError when Kraken returns errors', async () => {
  const server = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => res.end(JSON.stringify({ error: ['EOrder:Insufficient funds'], result: null })));
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k',
    apiSecret: Buffer.from('s').toString('base64'),
  });

  await assert.rejects(
    () => client.privateRequest('AddOrder', {}),
    (err) => err instanceof KrakenApiError && err.errors.includes('EOrder:Insufficient funds'),
  );
  server.close();
});

test('publicRequest aborts with a TimeoutError when the server is too slow', async () => {
  const server = await startMockServer((req, res) => {
    setTimeout(() => res.end(JSON.stringify({ error: [], result: {} })), 300);
  });
  const { port } = server.address();
  const client = createRestClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 50 });

  await assert.rejects(
    () => client.publicRequest('Time', {}),
    (err) => err.name === 'TimeoutError',
  );
  server.close();
});

test('privateRequest aborts with a TimeoutError when the server is too slow', async () => {
  const server = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => setTimeout(() => res.end(JSON.stringify({ error: [], result: {} })), 300));
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 50,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
  });

  await assert.rejects(
    () => client.privateRequest('Balance', {}),
    (err) => err.name === 'TimeoutError',
  );
  server.close();
});

test('privateRequest retries on HTTP 5xx and succeeds once the server recovers', async () => {
  let requestCount = 0;
  const server = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      requestCount += 1;
      if (requestCount < 3) {
        res.statusCode = 503;
        res.end('service unavailable');
      } else {
        res.end(JSON.stringify({ error: [], result: { ok: true } }));
      }
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`, retryBaseDelayMs: 1,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
  });

  const result = await client.privateRequest('Balance', {});

  assert.equal(requestCount, 3);
  assert.deepEqual(result, { ok: true });
  server.close();
});

test('privateRequest retries on EAPI:Rate limit and succeeds once the server recovers', async () => {
  let requestCount = 0;
  const server = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      requestCount += 1;
      if (requestCount < 2) {
        res.end(JSON.stringify({ error: ['EAPI:Rate limit exceeded'], result: null }));
      } else {
        res.end(JSON.stringify({ error: [], result: { ok: true } }));
      }
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`, retryBaseDelayMs: 1,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
  });

  const result = await client.privateRequest('Balance', {});

  assert.equal(requestCount, 2);
  assert.deepEqual(result, { ok: true });
  server.close();
});

test('privateRequest gives up after the retry limit and throws the last error', async () => {
  let requestCount = 0;
  const server = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      requestCount += 1;
      res.statusCode = 503;
      res.end('service unavailable');
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`, retryBaseDelayMs: 1, retries: 2,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
  });

  await assert.rejects(() => client.privateRequest('Balance', {}), (err) => err.status === 503);
  assert.equal(requestCount, 3); // initial try + 2 retries
  server.close();
});

test('addOrder never retries, even on HTTP 5xx', async () => {
  let requestCount = 0;
  const server = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      requestCount += 1;
      res.statusCode = 503;
      res.end('service unavailable');
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`, retryBaseDelayMs: 1,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
  });

  await assert.rejects(() => client.addOrder({ pair: 'XXBTZGBP', type: 'buy', ordertype: 'market', volume: '0.001' }));
  assert.equal(requestCount, 1);
  server.close();
});

test('default nonce generator is strictly increasing even when called twice in the same tick', () => {
  const client = createRestClient({ baseUrl: 'http://unused' });
  const a = client._getNonce();
  const b = client._getNonce();
  assert.ok(b > a, `expected ${b} > ${a}`);
});

test('getOhlc marks the last candle as not closed and the rest as closed', async () => {
  const server = await startMockServer((req, res) => {
    res.end(JSON.stringify({
      error: [],
      result: {
        XXBTZGBP: [
          [1000, '10', '11', '9', '10.5', '10.2', '5', 3],
          [1060, '10.5', '12', '10', '11.5', '11', '6', 4],
        ],
        last: 1060,
      },
    }));
  });
  const { port } = server.address();
  const client = createRestClient({ baseUrl: `http://127.0.0.1:${port}` });

  const { candles, last } = await client.getOhlc('XXBTZGBP', { interval: 1 });

  assert.equal(candles.length, 2);
  assert.equal(candles[0].closed, true);
  assert.equal(candles[1].closed, false);
  assert.equal(candles[1].time, 1060);
  assert.equal(last, 1060);
  server.close();
});

test('addOrder posts to /0/private/AddOrder with the given params plus nonce', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = body;
      res.end(JSON.stringify({ error: [], result: { txid: ['OABC-TEST'], descr: { order: 'buy 0.001 XXBTZGBP' } } }));
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
    getNonce: () => 1,
  });

  const result = await client.addOrder({
    pair: 'XXBTZGBP', type: 'buy', ordertype: 'limit', price: '10000', volume: '0.001',
    cl_ord_id: 'c_test_001', validate: true,
  });

  assert.equal(captured, 'nonce=1&pair=XXBTZGBP&type=buy&ordertype=limit&price=10000&volume=0.001&cl_ord_id=c_test_001&validate=true');
  assert.deepEqual(result.txid, ['OABC-TEST']);
  server.close();
});

test('amendOrder posts to /0/private/AmendOrder with trigger_price', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = { url: req.url, body };
      res.end(JSON.stringify({ error: [], result: { amend_id: 'AMEND-1' } }));
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
    getNonce: () => 1,
  });

  const result = await client.amendOrder({ txid: 'OABC-TEST', trigger_price: '-50' });

  assert.equal(captured.url, '/0/private/AmendOrder');
  assert.equal(captured.body, 'nonce=1&txid=OABC-TEST&trigger_price=-50');
  assert.equal(result.amend_id, 'AMEND-1');
  server.close();
});

test('cancelOrder posts txid to /0/private/CancelOrder', async () => {
  let captured;
  const server = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = body;
      res.end(JSON.stringify({ error: [], result: { count: 1 } }));
    });
  });
  const { port } = server.address();
  const client = createRestClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k', apiSecret: Buffer.from('s').toString('base64'),
    getNonce: () => 1,
  });

  const result = await client.cancelOrder('OABC-TEST');

  assert.equal(captured, 'nonce=1&txid=OABC-TEST');
  assert.equal(result.count, 1);
  server.close();
});
