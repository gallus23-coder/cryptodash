'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'cryptodash', 'env');

function loadEnvFile(filePath = DEFAULT_PATH) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function getKrakenCredentials(filePath = DEFAULT_PATH) {
  const env = loadEnvFile(filePath);
  return { apiKey: env.KRAKEN_API_KEY, apiSecret: env.KRAKEN_API_SECRET };
}

module.exports = { loadEnvFile, getKrakenCredentials, DEFAULT_PATH };
