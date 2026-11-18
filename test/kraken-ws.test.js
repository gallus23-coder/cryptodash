'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { KrakenPublicWs } = require('../src/kraken/ws');

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
