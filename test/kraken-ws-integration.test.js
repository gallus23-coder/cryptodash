'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { KrakenPublicWs } = require('../src/kraken/ws');

test('receives at least one real ticker update for BTC/GBP', async () => {
  const client = new KrakenPublicWs({});
  client.connect();
  await new Promise((resolve) => client.once('open', resolve));
  client.subscribeTicker(['BTC/GBP']);

  const msg = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a ticker update')), 10000);
    client.once('ticker', (m) => { clearTimeout(timer); resolve(m); });
  });

  client.close();
  assert.equal(msg.channel, 'ticker');
});
