'use strict';
const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://api.kraken.com';

class KrakenApiError extends Error {
  constructor(errors) {
    super(`Kraken API error: ${errors.join(', ')}`);
    this.name = 'KrakenApiError';
    this.errors = errors;
  }
}

function sign(path, postdata, nonce, apiSecret) {
  const secretBuf = Buffer.from(apiSecret, 'base64');
  const hashDigest = crypto.createHash('sha256').update(nonce + postdata).digest('binary');
  return crypto
    .createHmac('sha512', secretBuf)
    .update(path, 'latin1')
    .update(hashDigest, 'binary')
    .digest('base64');
}

function makeDefaultNonce() {
  let last = 0;
  return () => {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
}

function createRestClient({ apiKey, apiSecret, baseUrl = DEFAULT_BASE_URL, getNonce } = {}) {
  const nonceFn = getNonce || makeDefaultNonce();

  async function publicRequest(endpoint, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const path = `/0/public/${endpoint}`;
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url);
    return parseResponse(res);
  }

  async function privateRequest(endpoint, params = {}) {
    const nonce = String(nonceFn());
    const postdata = new URLSearchParams({ nonce, ...params }).toString();
    const path = `/0/private/${endpoint}`;
    const signature = sign(path, postdata, nonce, apiSecret);
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': apiKey,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postdata,
    });
    return parseResponse(res);
  }

  async function parseResponse(res) {
    if (!res.ok) {
      const err = new Error(`Kraken HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (body.error && body.error.length > 0) throw new KrakenApiError(body.error);
    return body.result;
  }

  async function getServerTime() {
    return publicRequest('Time');
  }

  async function getAssetPairs(pairs) {
    return publicRequest('AssetPairs', pairs ? { pair: pairs.join(',') } : {});
  }

  async function getTicker(pairs) {
    return publicRequest('Ticker', { pair: pairs.join(',') });
  }

  async function getOhlc(pair, { interval = 1, since } = {}) {
    const params = { pair, interval: String(interval) };
    if (since !== undefined) params.since = String(since);
    const result = await publicRequest('OHLC', params);
    const { last, ...rest } = result;
    const rows = rest[Object.keys(rest)[0]];
    const candles = rows.map(([time, open, high, low, close, vwap, volume, count], i) => ({
      time, open: Number(open), high: Number(high), low: Number(low), close: Number(close),
      vwap: Number(vwap), volume: Number(volume), count,
      closed: i < rows.length - 1,
    }));
    return { candles, last };
  }

  async function getBalance() {
    return privateRequest('Balance');
  }

  async function addOrder(params) {
    return privateRequest('AddOrder', params);
  }

  async function amendOrder(params) {
    return privateRequest('AmendOrder', params);
  }

  async function cancelOrder(txid) {
    return privateRequest('CancelOrder', { txid });
  }

  async function getOpenOrders() {
    return privateRequest('OpenOrders');
  }

  return {
    publicRequest, privateRequest, sign, _getNonce: nonceFn,
    getServerTime, getAssetPairs, getTicker, getOhlc,
    getBalance, addOrder, amendOrder, cancelOrder, getOpenOrders,
  };
}

module.exports = { createRestClient, KrakenApiError, sign };
