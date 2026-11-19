'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/data/db');
const { createApp } = require('../src/server/app');

function startTestServer(password) {
  const db = openDb(':memory:');
  const app = createApp(db, { password });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port, db }));
  });
}

test('a request with the correct password header succeeds', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Dashboard-Password': 'sekrit' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('a request with no password header is rejected with 401', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('a request with the wrong password header is rejected with 401, same as no header', async () => {
  const { server, port } = await startTestServer('sekrit');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Dashboard-Password': 'wrong' } });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('with no password configured, every request is allowed through', async () => {
  const { server, port } = await startTestServer(undefined);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});
