'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCoinData } = require('../src/backtest/run');

function makeFixture() {
  const DAY = 24 * 3600, FOUR_H = 4 * 3600;
  const candlesDaily = Array.from({ length: 230 }, (_, i) => ({ ts: i * DAY, close: 100 + i * 0.1 }));
  const candles4h = Array.from({ length: 230 * 6 }, (_, i) => {
    const price = 100 + i * 0.02;
    return { ts: i * FOUR_H, open: price, high: price + 1, low: price - 1, close: price };
  });
  const candles1h = Array.from({ length: 230 * 24 }, (_, i) => {
    const price = 100 + i * (0.02 / 4);
    return { ts: i * 3600, open: price, high: price + 0.5, low: price - 0.5, close: price };
  });
  return { candles4h, candles1h, candlesDaily };
}

test('buildCoinData returns one indicator value per 4h candle, with dailyEma200Aligned look-ahead-safe', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();

  const data = buildCoinData({ candles4h, candles1h, candlesDaily });

  assert.equal(data.indicators.ema20.length, candles4h.length);
  assert.equal(data.indicators.dailyEma200Aligned.length, candles4h.length);
  assert.equal(data.indicators.adx14.adx.length, candles4h.length);
  // Well past warm-up (the fixture has 230 days / 1380 4h-bars), everything should be populated.
  const lastIdx = candles4h.length - 1;
  assert.ok(data.indicators.ema20[lastIdx] !== null);
  assert.ok(data.indicators.dailyEma200Aligned[lastIdx] !== null);
});

test('buildCoinData builds ema20By4hTs keyed by each 4h candle\'s own ts, skipping warm-up nulls', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();

  const data = buildCoinData({ candles4h, candles1h, candlesDaily });

  assert.equal(data.ema20By4hTs.size, candles4h.length - 19); // ema20 needs 20 bars, so 19 are null
  const lastBar = candles4h[candles4h.length - 1];
  assert.equal(data.ema20By4hTs.get(lastBar.ts), data.indicators.ema20[candles4h.length - 1]);
  assert.equal(data.ema20By4hTs.has(candles4h[0].ts), false); // index 0 is warm-up, should be skipped
});

const { tryOpenPosition, closePosition } = require('../src/backtest/run');

test("closing the only open position leaves balance equal to starting balance plus that trade's pnl, exactly once", () => {
  const state = { balance: 1000, dailyPnl: 0, openPositions: [], cooldowns: {}, closedTrades: [] };
  const config = {
    baseRiskPct: 0.005, maxOpenPositions: 3, maxTotalRiskPct: 0.015,
    maxCoinExposurePct: 0.20, maxTotalExposurePct: 0.60, cooldownHours: 6, roundTripFeePct: 0.01,
  };
  const candidate = {
    coin: 'BTC', setup: 'trend_breakout', entry: 100, atr: 10,
    default: { action: 'take', size: 1, stopAtr: 1 }, exitType: 'trailing_stop',
  };
  const data = { candles4h: [{ ts: 0, close: 100 }], indicators: { bollinger20: { middle: [null] } } };

  tryOpenPosition(state, candidate, data, 0, config);
  const position = state.openPositions[0];
  closePosition(state, position, { exitTs: 3600, exitPrice: 100, reason: 'stop' }, config);

  const trade = state.closedTrades[0];
  assert.equal(state.balance, 1000 + trade.pnl);
});

test('buildCoinData computes donchianBreakout with the given breakoutLookback, not a hardcoded 20', () => {
  const { candles4h, candles1h, candlesDaily } = makeFixture();
  const data = buildCoinData({ candles4h, candles1h, candlesDaily, breakoutLookback: 10 });
  const { donchian } = require('../src/engine/indicators');
  const expected = donchian(candles4h, 10);
  assert.deepEqual(data.indicators.donchianBreakout.upper, expected.upper);
});

const { runBacktest } = require('../src/backtest/run');
const { openDb, upsertCandles } = require('../src/data/db');

test('a tighter oversold_bounce rsi2Max produces fewer (or equal, never more) trades than a looser one, on the same fixture', () => {
  const db = openDb(':memory:');
  const DAY = 86400, FOUR_H = 4 * 3600, HOUR = 3600;
  const DAYS = 230; // 220-day regime warm-up (EMA200 + slope) + margin, same convention as engine-regime.test.js
  const N = DAYS * 6;

  // Percentage-based moves throughout (not fixed absolute amounts) so ATR% stays roughly flat
  // over the series instead of drifting monotonically as price falls — a fixed-amount wiggle on
  // a falling base makes the LAST bar's ATR% the all-time max of its own trailing window, which
  // trips the volatility-percentile risk_off gate and masks the regime entirely.
  const closes = [];
  let price = 1000;
  for (let i = 0; i < N; i += 1) {
    if (i % 10 === 0 && i > 0) price *= 1.0015; // small bounce every 10 bars
    else price *= 0.9997; // otherwise a steady decline
    closes.push(price);
  }
  // A perfectly periodic range would hit the same percentile-pinning problem once the window is
  // an exact multiple of the period — the sine term breaks that periodicity.
  const bucketOhlc = (i) => {
    const c = closes[i];
    const rangePct = 0.03 * (1 + 0.5 * Math.sin(i * 0.37));
    return { open: c, high: c * (1 + rangePct / 2), low: c * (1 - rangePct / 2), close: c };
  };

  const rows4h = closes.map((c, i) => ({ coin: 'BTC', timeframe: '4h', ts: i * FOUR_H, ...bucketOhlc(i), volume: 1, trades: 1 }));
  upsertCandles(db, rows4h);
  const rows1d = Array.from({ length: DAYS }, (_, d) => {
    const c = closes[d * 6 + 5];
    return { coin: 'BTC', timeframe: '1d', ts: d * DAY, open: c, high: c, low: c, close: c, volume: 1, trades: 1 };
  });
  upsertCandles(db, rows1d);
  // evaluateExit (src/broker/paper.js) only ever looks at 1h candles to detect a stop/target/time
  // stop — without any, a position opens and simply never closes, so closedTrades stays 0 for
  // every config regardless of rsi2Max. One real hour per 4h bucket (matching its full OHLC) plus
  // three flat hours at the bucket's close reproduces the bucket exactly for anything that cares.
  const rows1h = [];
  for (let i = 0; i < N; i += 1) {
    const o = bucketOhlc(i);
    const bucketStart = i * FOUR_H;
    rows1h.push({ coin: 'BTC', timeframe: '1h', ts: bucketStart, ...o, volume: 1, trades: 1 });
    for (let h = 1; h < 4; h += 1) {
      rows1h.push({ coin: 'BTC', timeframe: '1h', ts: bucketStart + h * HOUR, open: o.close, high: o.close, low: o.close, close: o.close, volume: 1, trades: 1 });
    }
  }
  upsertCandles(db, rows1h);

  const { DEFAULT_RISK_CONFIG } = require('../src/engine/config');
  const setupsByRegime = { trend_up: [], range: [], downtrend: ['oversold_bounce'], risk_off: [] };

  const tight = runBacktest(db, DEFAULT_RISK_CONFIG, 0, setupsByRegime, { oversold_bounce: { rsi2Max: 2 } });
  const loose = runBacktest(db, DEFAULT_RISK_CONFIG, 0, setupsByRegime, { oversold_bounce: { rsi2Max: 15 } });

  assert.ok(loose.state.closedTrades.length >= tight.state.closedTrades.length);
  assert.ok(loose.state.closedTrades.length > tight.state.closedTrades.length, 'a looser rsi2Max must open strictly more trades on this fixture');
});
