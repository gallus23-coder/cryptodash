'use strict';
const trendBreakout = require('./trendBreakout');
const trendPullback = require('./trendPullback');
const rangeReversion = require('./rangeReversion');
const oversoldBounce = require('./oversoldBounce');

const SETUPS = {
  trend_breakout: trendBreakout, trend_pullback: trendPullback,
  range_reversion: rangeReversion, oversold_bounce: oversoldBounce,
};

const SETUPS_BY_REGIME = {
  trend_up: ['trend_breakout', 'trend_pullback'],
  range: ['range_reversion'],
  downtrend: ['oversold_bounce'],
  risk_off: [],
};

module.exports = { SETUPS, SETUPS_BY_REGIME };
