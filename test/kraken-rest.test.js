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

test('default nonce generator is strictly increasing even when called twice in the same tick', () => {
  const client = createRestClient({ baseUrl: 'http://unused' });
  const a = client._getNonce();
  const b = client._getNonce();
  assert.ok(b > a, `expected ${b} > ${a}`);
});
