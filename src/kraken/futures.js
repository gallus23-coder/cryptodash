'use strict';

const DEFAULT_BASE_URL = 'https://futures.kraken.com/derivatives/api/v3';

function createFuturesClient({ baseUrl = DEFAULT_BASE_URL } = {}) {
  async function getTickers() {
    const res = await fetch(`${baseUrl}/tickers`);
    if (!res.ok) {
      const err = new Error(`Kraken Futures HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (body.result !== 'success') throw new Error(`Kraken Futures error: ${JSON.stringify(body)}`);
    return body.tickers;
  }

  function getFundingContext(tickers, symbol) {
    const ticker = tickers.find((t) => t.symbol === symbol);
    if (!ticker) return null;
    return {
      symbol,
      fundingRate: ticker.fundingRate,
      fundingRatePrediction: ticker.fundingRatePrediction,
      openInterest: ticker.openInterest,
    };
  }

  return { getTickers, getFundingContext };
}

module.exports = { createFuturesClient };
