'use strict';

const DEFAULT_BASE_URL = 'https://futures.kraken.com/derivatives/api/v3';

function createFuturesClient({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 10000 } = {}) {
  async function getTickers() {
    const res = await fetch(`${baseUrl}/tickers`, { signal: AbortSignal.timeout(timeoutMs) });
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
    // Kraken Futures reports fundingRate/fundingRatePrediction as absolute
    // quote-currency amounts, not a fraction of price — divide by markPrice.
    const { markPrice } = ticker;
    return {
      symbol,
      fundingRate: ticker.fundingRate,
      fundingRatePrediction: ticker.fundingRatePrediction,
      openInterest: ticker.openInterest,
      fundingRatePct: markPrice ? (ticker.fundingRate / markPrice) * 100 : null,
      fundingRatePredictionPct: markPrice ? (ticker.fundingRatePrediction / markPrice) * 100 : null,
    };
  }

  return { getTickers, getFundingContext };
}

module.exports = { createFuturesClient };
