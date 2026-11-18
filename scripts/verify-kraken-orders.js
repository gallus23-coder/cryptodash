'use strict';
const { createRestClient } = require('../src/kraken/rest');
const { getKrakenCredentials } = require('../src/config/env');

async function main() {
  const creds = getKrakenCredentials();
  if (!creds.apiKey || !creds.apiSecret) {
    console.error('No Kraken keys found (checked process.env and ~/.config/cryptodash/env)');
    process.exit(1);
  }
  const client = createRestClient(creds);

  const balanceBefore = await client.getBalance();
  console.log('Balance OK, GBP:', balanceBefore.ZGBP);

  const ticker = await client.getTicker(['XXBTZGBP']);
  const price = Number(ticker.XXBTZGBP.a[0]);
  const farBelowMarket = (price * 0.5).toFixed(1); // won't fill, just proving add/cancel works

  const order = await client.addOrder({
    pair: 'XXBTZGBP', type: 'buy', ordertype: 'limit',
    price: farBelowMarket, volume: '0.0001', oflags: 'post',
    cl_ord_id: `c_verify_${Date.now()}`,
  });
  console.log('Placed order:', order.txid);

  const cancel = await client.cancelOrder(order.txid[0]);
  console.log('Cancelled:', cancel);

  // Reservation check: this should be rejected once a sell/stop reserves the full holding.
  // Only run manually and only if the account holds a tiny BTC balance to test against —
  // read the printed error, don't assume; then cancel whichever order actually went through.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
