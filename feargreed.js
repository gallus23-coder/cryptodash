// feargreed.js
'use strict';

const FNG_URL = 'https://api.alternative.me/fng/?limit=1';

// Fetch current Fear & Greed index from Alternative.me.
// Returns { value: number, classification: string }.
// Throws on network error or non-ok HTTP status.
async function fetchFearGreed() {
  const res = await fetch(FNG_URL);
  if (!res.ok) throw new Error(`Fear & Greed API ${res.status}`);
  const body = await res.json();
  const d = body.data[0];
  return { value: parseInt(d.value, 10), classification: d.value_classification };
}

module.exports = { fetchFearGreed };
