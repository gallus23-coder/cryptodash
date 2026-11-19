'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS } = require('../src/engine/config');

test('DEFAULT_RISK_CONFIG matches design spec §5.4 values', () => {
  assert.equal(DEFAULT_RISK_CONFIG.baseRiskPct, 0.005);
  assert.equal(DEFAULT_RISK_CONFIG.maxOpenPositions, 3);
  assert.equal(DEFAULT_RISK_CONFIG.maxTotalRiskPct, 0.015);
  assert.equal(DEFAULT_RISK_CONFIG.maxCoinExposurePct, 0.20);
  assert.equal(DEFAULT_RISK_CONFIG.maxTotalExposurePct, 0.60);
  assert.equal(DEFAULT_RISK_CONFIG.cooldownHours, 6);
  assert.equal(DEFAULT_RISK_CONFIG.dailyLossLimitPct, 0.03);
  assert.equal(DEFAULT_RISK_CONFIG.weeklyKillSwitchPct, 0.08);
});

test('COIN_ALTNAMES has the 6 watchlist coins with their confirmed Kraken altnames', () => {
  assert.deepEqual(COIN_ALTNAMES, {
    BTC: 'XBTGBP', ETH: 'ETHGBP', SOL: 'SOLGBP', XRP: 'XRPGBP', ADA: 'ADAGBP', LINK: 'LINKGBP',
  });
});

test('COINS is derived from COIN_ALTNAMES and matches the backtest\'s coin list', () => {
  assert.deepEqual(COINS.sort(), ['ADA', 'BTC', 'ETH', 'LINK', 'SOL', 'XRP']);
});
