// coingecko.js
'use strict';

// Fetch name, image, market_cap for a single coin. Called once per new coin.
// Returns { cgSymbol, name, image, market_cap }
// cgSymbol is e.g. "BTC" — used as Binance symbol fallback when coin not in SYMBOL_MAP.
async function fetchMetadata(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}` +
    `?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko metadata ${res.status} for ${id}`);
  const data = await res.json();
  return {
    cgSymbol: (data.symbol || '').toUpperCase(), // e.g. "BTC"
    name: data.name,
    image: data.image?.large ?? null,
    market_cap: data.market_data.market_cap.usd ?? null,
  };
}

// Batch-fetch market caps for multiple coins. Called every 24h.
// Returns { [coingeckoId]: market_cap_usd } — market_cap may be null for some coins; callers must guard with != null.
async function refreshMarketCaps(ids) {
  if (!ids.length) return {};
  const url = `https://api.coingecko.com/api/v3/coins/markets` +
    `?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&per_page=250&page=1&sparkline=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko markets ${res.status}`);
  const data = await res.json();
  return Object.fromEntries(data.map(d => [d.id, d.market_cap]));
}

module.exports = { fetchMetadata, refreshMarketCaps };
