'use strict';
const { ema, rsi, atr, adx, donchian, bollinger } = require('../engine/indicators');
const { alignDailyIndices } = require('../engine/regime');

function buildCoinData({ candles4h, candles1h, candlesDaily }) {
  const closes4h = candles4h.map((c) => c.close);
  const dailyCloses = candlesDaily.map((c) => c.close);
  const dailyEma200 = ema(dailyCloses, 200);
  const dailyIdx = alignDailyIndices(candlesDaily, candles4h);
  const dailyEma200Aligned = dailyIdx.map((idx) => (idx === null ? null : dailyEma200[idx]));

  const indicators = {
    ema20: ema(closes4h, 20),
    ema50: ema(closes4h, 50),
    rsi14: rsi(closes4h, 14),
    rsi2: rsi(closes4h, 2),
    atr14: atr(candles4h, 14),
    donchian20: donchian(candles4h, 20),
    bollinger20: bollinger(closes4h, 20, 2),
    adx14: adx(candles4h, 14),
    dailyEma200Aligned,
  };

  const ema20By4hTs = new Map();
  candles4h.forEach((c, i) => {
    if (indicators.ema20[i] !== null) ema20By4hTs.set(c.ts, indicators.ema20[i]);
  });

  return { candles4h, candles1h, indicators, ema20By4hTs };
}

module.exports = { buildCoinData };
