'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { KrakenPublicWs, computeReconnectDelay } = require('../src/kraken/ws');

function startWsServer() {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0 }, () => resolve(wss));
  });
}

test('auto-reconnects and re-sends subscriptions after the connection drops', async () => {
  const wss = await startWsServer();
  const port = wss.address().port;
  const received = [];
  let connectionCount = 0;

  wss.on('connection', (socket) => {
    connectionCount += 1;
    socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    if (connectionCount === 1) {
      // Drop the first connection shortly after it subscribes, to force a reconnect.
      setTimeout(() => socket.close(), 200);
    }
  });

  const client = new KrakenPublicWs({ url: `ws://127.0.0.1:${port}`, reconnectDelayMs: 100 });
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));
  client.subscribeTicker(['BTC/GBP']);

  await new Promise((resolve) => setTimeout(resolve, 600)); // let it drop, reconnect, and resubscribe

  client.close();
  wss.close();

  assert.ok(connectionCount >= 2, `expected at least 2 connections, got ${connectionCount}`);
  assert.deepEqual(received[0], { method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/GBP'] } });
  assert.ok(received.length >= 2, 'expected the subscription to be re-sent after reconnect');
  assert.deepEqual(received[received.length - 1], { method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/GBP'] } });
});

test('emits channel-named events keyed off msg.channel', async () => {
  const wss = await startWsServer();
  const port = wss.address().port;
  wss.on('connection', (socket) => {
    socket.on('message', () => {
      socket.send(JSON.stringify({ channel: 'ticker', type: 'update', data: [{ symbol: 'BTC/GBP', last: 50000 }] }));
    });
  });

  const client = new KrakenPublicWs({ url: `ws://127.0.0.1:${port}` });
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));
  client.subscribeTicker(['BTC/GBP']);

  const msg = await new Promise((resolve) => client.once('ticker', resolve));

  client.close();
  wss.close();

  assert.equal(msg.data[0].symbol, 'BTC/GBP');
});

test('close() cancels a pending reconnect instead of letting it fire later', async () => {
  const wss = await startWsServer();
  const port = wss.address().port;
  let openCount = 0;
  wss.on('connection', (socket) => {
    // Every connection is dropped immediately, forcing a reconnect to be scheduled.
    socket.close();
  });

  const client = new KrakenPublicWs({ url: `ws://127.0.0.1:${port}`, reconnectDelayMs: 100 });
  client.on('open', () => { openCount += 1; });
  client.connect();
  await new Promise((resolve) => client.once('close', resolve)); // the drop that schedules a reconnect
  const openCountAfterDrop = openCount;

  client.close(); // must cancel that pending reconnect
  wss.close();

  await new Promise((resolve) => setTimeout(resolve, 300)); // longer than reconnectDelayMs

  assert.equal(openCount, openCountAfterDrop, 'close() should have cancelled the pending reconnect before it could open again');
});

test('computeReconnectDelay doubles each attempt and caps at maxMs', () => {
  assert.equal(computeReconnectDelay(0, { baseMs: 100, maxMs: 5000 }), 100);
  assert.equal(computeReconnectDelay(1, { baseMs: 100, maxMs: 5000 }), 200);
  assert.equal(computeReconnectDelay(2, { baseMs: 100, maxMs: 5000 }), 400);
  assert.equal(computeReconnectDelay(10, { baseMs: 100, maxMs: 1000 }), 1000);
});

test('reconnects on heartbeat silence even without the server dropping the connection', async () => {
  const wss = await startWsServer();
  const port = wss.address().port;
  let connectionCount = 0;
  wss.on('connection', () => { connectionCount += 1; });

  const client = new KrakenPublicWs({
    url: `ws://127.0.0.1:${port}`, reconnectDelayMs: 50, heartbeatTimeoutMs: 100,
  });
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));

  await new Promise((resolve) => setTimeout(resolve, 400));

  client.close();
  wss.close();

  assert.ok(connectionCount >= 2, `expected at least 2 connections from heartbeat timeout, got ${connectionCount}`);
});

test('does not re-send an identical subscription twice', async () => {
  const wss = await startWsServer();
  const port = wss.address().port;
  const received = [];
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  });

  const client = new KrakenPublicWs({ url: `ws://127.0.0.1:${port}` });
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));

  client.subscribeTicker(['BTC/GBP']);
  client.subscribeTicker(['BTC/GBP']);
  await new Promise((resolve) => setTimeout(resolve, 100));

  client.close();
  wss.close();

  assert.equal(client.subscriptions.length, 1);
  assert.equal(received.length, 1);
});

test('emits an error when a subscribe ack reports success:false', async () => {
  const wss = await startWsServer();
  const port = wss.address().port;
  wss.on('connection', (socket) => {
    socket.on('message', () => {
      socket.send(JSON.stringify({ method: 'subscribe', success: false, error: 'Currency pair not supported' }));
    });
  });

  const client = new KrakenPublicWs({ url: `ws://127.0.0.1:${port}` });
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));
  client.subscribeTicker(['NOPE/GBP']);

  const err = await new Promise((resolve) => client.once('error', resolve));

  client.close();
  wss.close();

  assert.match(err.message, /Currency pair not supported/);
});
