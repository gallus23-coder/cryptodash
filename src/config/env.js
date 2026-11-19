'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'cryptodash', 'env');

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function loadEnvFile(filePath = DEFAULT_PATH) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = stripQuotes(trimmed.slice(idx + 1).trim());
  }
  return out;
}

// systemd loads /etc/cryptodash/env (owned by a separate user) via EnvironmentFile,
// so process.env is the primary source; the file loader is only a local-dev fallback.
function getKrakenCredentials(filePath) {
  if (process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET) {
    return { apiKey: process.env.KRAKEN_API_KEY, apiSecret: process.env.KRAKEN_API_SECRET };
  }
  const resolvedPath = filePath || process.env.CRYPTODASH_ENV_FILE || DEFAULT_PATH;
  const env = loadEnvFile(resolvedPath);
  return {
    apiKey: process.env.KRAKEN_API_KEY || env.KRAKEN_API_KEY,
    apiSecret: process.env.KRAKEN_API_SECRET || env.KRAKEN_API_SECRET,
  };
}

function getDashboardPassword(filePath) {
  if (process.env.DASHBOARD_PASSWORD) return process.env.DASHBOARD_PASSWORD;
  const resolvedPath = filePath || process.env.CRYPTODASH_ENV_FILE || DEFAULT_PATH;
  return loadEnvFile(resolvedPath).DASHBOARD_PASSWORD;
}

module.exports = { loadEnvFile, getKrakenCredentials, getDashboardPassword, DEFAULT_PATH };
