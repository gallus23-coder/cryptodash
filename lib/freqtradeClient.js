// lib/freqtradeClient.js
'use strict';

// Factory function — creates an authenticated Freqtrade API client.
// Each instance manages its own JWT token with automatic refresh on 401.
// Responses are cached for CACHE_TTL_MS to avoid hammering the API.

const CACHE_TTL_MS = 30 * 1000; // 30 seconds

function createFreqtradeClient(baseUrl, username, password) {
  let _token    = null;
  const _cache  = new Map(); // path → { data, fetchedAt }

  async function _login() {
    const b64 = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await fetch(`${baseUrl}/token/login`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', 'Authorization': `Basic ${b64}` },
    });
    if (!res.ok) throw new Error(`FT login ${baseUrl} failed: ${res.status}`);
    _token = (await res.json()).access_token;
  }

  async function request(method, path, body) {
    if (!_token) await _login();
    const makeOpts = () => ({
      method,
      headers: {
        'content-type':  'application/json',
        'Authorization': `Bearer ${_token}`,
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    let res = await fetch(`${baseUrl}${path}`, makeOpts());
    if (res.status === 401) {
      await _login();
      res = await fetch(`${baseUrl}${path}`, makeOpts());
    }
    return res;
  }

  // GET with 30s cache
  async function getCached(path) {
    const cached = _cache.get(path);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    const res = await request('GET', path);
    if (!res.ok) throw new Error(`FT GET ${path} → ${res.status}`);
    const data = await res.json();
    _cache.set(path, { data, fetchedAt: Date.now() });
    return data;
  }

  function invalidateCache(path) {
    if (path) _cache.delete(path);
    else _cache.clear();
  }

  // Graceful wrapper — returns null on any error
  async function safeGet(path) {
    try { return await getCached(path); }
    catch { return null; }
  }

  return { request, getCached, safeGet, invalidateCache, baseUrl };
}

const FT_CREDS = {
  username: process.env.FREQTRADE_USERNAME || 'cryptodash',
  password: process.env.FREQTRADE_PASSWORD || 'Swagger23!',
};
const FT_TREND_CREDS = {
  username: process.env.FREQTRADE_TREND_USERNAME || FT_CREDS.username,
  password: process.env.FREQTRADE_TREND_PASSWORD || FT_CREDS.password,
};

const meanReversionClient = createFreqtradeClient(
  'http://localhost:8080/api/v1',
  FT_CREDS.username,
  FT_CREDS.password,
);

const trendClient = createFreqtradeClient(
  'http://localhost:8081/api/v1',
  FT_TREND_CREDS.username,
  FT_TREND_CREDS.password,
);

module.exports = { meanReversionClient, trendClient, createFreqtradeClient };
