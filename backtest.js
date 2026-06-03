// backtest.js — no I/O, pure computation. db is passed in from server.js.
'use strict';

// ── Incremental indicator classes (O(n) total, no lookahead) ─────────────────

class IncrEMA {
  constructor(period) {
    this.period = period; this.k = 2 / (period + 1);
    this.value = null; this.buf = [];
  }
  next(v) {
    if (this.value === null) {
      this.buf.push(v);
      if (this.buf.length >= this.period) {
        this.value = this.buf.reduce((a, b) => a + b, 0) / this.period;
        this.buf = null;
      }
      return this.value;
    }
    this.value = v * this.k + this.value * (1 - this.k);
    return this.value;
  }
}

class IncrRSI {
  constructor(period = 14) {
    this.period = period; this.prev = null;
    this.changes = []; this.avgGain = null; this.avgLoss = null;
  }
  next(close) {
    if (this.prev === null) { this.prev = close; return null; }
    const chg = close - this.prev; this.prev = close;
    if (this.avgGain === null) {
      this.changes.push(chg);
      if (this.changes.length < this.period) return null;
      this.avgGain = this.changes.filter(c => c > 0).reduce((a, b) => a + b, 0) / this.period;
      this.avgLoss = this.changes.filter(c => c < 0).reduce((a, b) => a - b, 0) / this.period;
      this.changes = null;
    } else {
      this.avgGain = (this.avgGain * (this.period - 1) + Math.max(0, chg)) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + Math.max(0, -chg)) / this.period;
    }
    return this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
  }
}

class IncrMACD {
  constructor() {
    this.e12 = new IncrEMA(12); this.e26 = new IncrEMA(26); this.sig = new IncrEMA(9);
  }
  next(close) {
    const e12 = this.e12.next(close); const e26 = this.e26.next(close);
    if (e12 === null || e26 === null) return null;
    const macd = e12 - e26;
    const signal = this.sig.next(macd);
    if (signal === null) return null;
    return { macd, signal, histogram: macd - signal };
  }
}

class IncrBollinger {
  constructor(period = 20) { this.period = period; this.win = []; }
  next(close) {
    this.win.push(close);
    if (this.win.length > this.period) this.win.shift();
    if (this.win.length < this.period) return null;
    const mid = this.win.reduce((a, b) => a + b, 0) / this.period;
    const std = Math.sqrt(this.win.reduce((a, v) => a + (v - mid) ** 2, 0) / this.period);
    return { upper: mid + 2 * std, middle: mid, lower: mid - 2 * std };
  }
}

class IncrStochRSI {
  constructor() {
    this.rsi = new IncrRSI(14); this.rsiWin = []; this.rawWin = []; this.kWin = [];
  }
  next(close) {
    const r = this.rsi.next(close);
    if (r === null) return null;
    this.rsiWin.push(r);
    if (this.rsiWin.length > 14) this.rsiWin.shift();
    if (this.rsiWin.length < 14) return null;
    const minR = Math.min(...this.rsiWin), maxR = Math.max(...this.rsiWin);
    const raw = maxR === minR ? 50 : (r - minR) / (maxR - minR) * 100;
    this.rawWin.push(raw);
    if (this.rawWin.length > 3) this.rawWin.shift();
    if (this.rawWin.length < 3) return null;
    const k = this.rawWin.reduce((a, b) => a + b, 0) / 3;
    this.kWin.push(k);
    if (this.kWin.length > 3) this.kWin.shift();
    const d = this.kWin.reduce((a, b) => a + b, 0) / this.kWin.length;
    return { k, d };
  }
}

class IncrVolumeRatio {
  constructor() { this.win = []; }
  next(volume) {
    this.win.push(volume);
    if (this.win.length > 21) this.win.shift();
    if (this.win.length < 21) return null;
    const avg = this.win.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    return avg > 0 ? this.win[20] / avg : null;
  }
}

// ── Signal scoring ────────────────────────────────────────────────────────────

// Raw score: 0–9 points from indicator conditions.
function computeRawScore(close, rsi, macd, bb, ema200, stochRsi, volRatio) {
  let score = 0;
  if (rsi !== null) { if (rsi < 30) score += 2; else if (rsi <= 45) score += 1; }
  if (macd && macd.macd > 0 && macd.histogram > 0) score += 2;
  if (bb && close < bb.lower) score += 2;
  if (ema200 !== null && close > ema200) score += 1;
  if (stochRsi && stochRsi.k < 20) score += 1;
  if (volRatio !== null && volRatio > 1.5) score += 1;
  return score;
}

// Classify a raw score into a signal, applying:
//   • tightened thresholds (buy ≥6, strong_buy ≥8)
//   • 2-candle confirmation (prevScore must also meet threshold)
//   • market phase gate (no buys when BTC below EMA200)
//   • 4h minimum holding period per coin (lastBuyTs)
function classifySignal(score, prevScore, btcAbove200, lastBuyTs, timestamp) {
  // Sell signals — no gate, no confirmation needed
  if (score <= 1) return 'strong_sell';
  if (score === 2) return 'sell';

  // Buy signals — all three guards must pass
  const canBuy = btcAbove200 !== false; // null (unknown) = allow; false = bear gate
  const COOLDOWN_MS = 4 * 3600000;
  const cooledDown = lastBuyTs === null || (timestamp - lastBuyTs) >= COOLDOWN_MS;

  if (score >= 8 && canBuy && prevScore !== null && prevScore >= 8 && cooledDown) return 'strong_buy';
  if (score >= 6 && canBuy && prevScore !== null && prevScore >= 6 && cooledDown) return 'buy';

  return 'hold';
}

// ── Signal generation for one coin ───────────────────────────────────────────

function generateCoinSignals(candles, testStartTs, forwardWindowsH, btcAbove200Map) {
  // Build timestamp→index for forward price lookup
  const timeIndex = new Map();
  for (let i = 0; i < candles.length; i++) timeIndex.set(candles[i].time, i);

  function priceAt(targetTs) {
    if (timeIndex.has(targetTs)) return candles[timeIndex.get(targetTs)].close;
    for (let off = 1; off <= 5; off++) {
      const t = targetTs + off * 3600000;
      if (timeIndex.has(t)) return candles[timeIndex.get(t)].close;
    }
    return null;
  }

  const ema200 = new IncrEMA(200); const ema50 = new IncrEMA(50);
  const rsi = new IncrRSI(); const macd = new IncrMACD();
  const bb = new IncrBollinger(); const stoch = new IncrStochRSI();
  const vol = new IncrVolumeRatio();

  const signals = [];
  let prevScore = null;  // raw score of previous candle (for 2-candle confirmation)
  let lastBuyTs = null;  // timestamp of last buy/strong_buy (for 4h cooldown)

  for (const c of candles) {
    const e200 = ema200.next(c.close); ema50.next(c.close);
    const r = rsi.next(c.close); const m = macd.next(c.close);
    const b = bb.next(c.close); const s = stoch.next(c.close);
    const v = vol.next(c.volume);

    const score = computeRawScore(c.close, r, m, b, e200, s, v);

    if (c.time < testStartTs) {
      prevScore = score;
      continue;
    }

    const btcAbove = btcAbove200Map.get(c.time) ?? null;
    const signal = classifySignal(score, prevScore, btcAbove, lastBuyTs, c.time);
    if (signal === 'buy' || signal === 'strong_buy') lastBuyTs = c.time;
    prevScore = score;

    const forward = {};
    for (const w of forwardWindowsH) {
      const fp = priceAt(c.time + w * 3600000);
      if (fp !== null) forward[w] = { price: fp, changePct: (fp - c.close) / c.close * 100 };
    }
    signals.push({
      timestamp: c.time, close: c.close, signal, score,
      btcAbove200: btcAbove,
      forward,
    });
  }
  return signals;
}

// ── Per-coin statistics ───────────────────────────────────────────────────────

function calcCoinStats(signals, forwardWindowsH) {
  const ACTION_CLASSES = ['strong_buy', 'buy', 'sell', 'strong_sell'];
  const isBull = c => c === 'strong_buy' || c === 'buy';

  const byWindowByClass = {};
  for (const w of forwardWindowsH) {
    byWindowByClass[w] = {};
    for (const cls of ACTION_CLASSES) {
      const sigs = signals.filter(s => s.signal === cls && s.forward[w] != null);
      const wins = sigs.filter(s => isBull(cls) ? s.forward[w].changePct > 0 : s.forward[w].changePct < 0);
      const losses = sigs.filter(s => isBull(cls) ? s.forward[w].changePct <= 0 : s.forward[w].changePct >= 0);
      const gains = wins.map(s => Math.abs(s.forward[w].changePct));
      const lossAmts = losses.map(s => Math.abs(s.forward[w].changePct));
      const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;
      const avgLoss = lossAmts.length ? lossAmts.reduce((a, b) => a + b, 0) / lossAmts.length : 0;
      const winRate = sigs.length > 0 ? wins.length / sigs.length : 0;
      const rr = avgLoss > 0 ? avgGain / avgLoss : null;
      byWindowByClass[w][cls] = {
        count: sigs.length, wins: wins.length,
        winRate: +winRate.toFixed(4), avgGain: +avgGain.toFixed(4),
        avgLoss: +avgLoss.toFixed(4), rr: rr !== null ? +rr.toFixed(3) : null,
        ev: +((winRate * avgGain) - ((1 - winRate) * avgLoss)).toFixed(4),
      };
    }
  }

  // Best window for BUY signals (highest combined BUY+STRONG_BUY win rate)
  let bestWindow = forwardWindowsH[0], bestWR = -1;
  for (const w of forwardWindowsH) {
    const sigs = signals.filter(s => (s.signal === 'buy' || s.signal === 'strong_buy') && s.forward[w]);
    if (!sigs.length) continue;
    const wr = sigs.filter(s => s.forward[w].changePct > 0).length / sigs.length;
    if (wr > bestWR) { bestWR = wr; bestWindow = w; }
  }

  // Classification counts
  const byClassification = {};
  for (const cls of ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell']) {
    byClassification[cls] = signals.filter(s => s.signal === cls).length;
  }

  // Max consecutive losses (at best window)
  let maxConsecLoss = 0, streak = 0;
  for (const s of signals.filter(s => s.signal !== 'hold')) {
    if (!s.forward[bestWindow]) continue;
    const loss = isBull(s.signal) ? s.forward[bestWindow].changePct <= 0 : s.forward[bestWindow].changePct >= 0;
    if (loss) { streak++; maxConsecLoss = Math.max(maxConsecLoss, streak); } else streak = 0;
  }

  // Avg hours between BUY signals
  const buyTimes = signals.filter(s => s.signal === 'buy' || s.signal === 'strong_buy').map(s => s.timestamp);
  let avgHoursBetweenBuys = null;
  if (buyTimes.length >= 2) {
    const gaps = buyTimes.slice(1).map((t, i) => (t - buyTimes[i]) / 3600000);
    avgHoursBetweenBuys = +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1);
  }

  // Phase split (only if 10+ BUY signals in each phase)
  const aboveBuys = signals.filter(s => s.btcAbove200 === true  && (s.signal === 'buy' || s.signal === 'strong_buy') && s.forward[bestWindow]);
  const belowBuys = signals.filter(s => s.btcAbove200 === false && (s.signal === 'buy' || s.signal === 'strong_buy') && s.forward[bestWindow]);
  let phaseSplit = null;
  if (aboveBuys.length >= 10 && belowBuys.length >= 10) {
    phaseSplit = {
      aboveEMA200: { count: aboveBuys.length, winRate: +(aboveBuys.filter(s => s.forward[bestWindow].changePct > 0).length / aboveBuys.length).toFixed(4) },
      belowEMA200: { count: belowBuys.length, winRate: +(belowBuys.filter(s => s.forward[bestWindow].changePct > 0).length / belowBuys.length).toFixed(4) },
    };
  }

  return {
    totalSignals: signals.length,
    byClassification,
    byWindowByClass,
    bestWindow,
    avgHoursBetweenBuys,
    maxConsecutiveLosses: maxConsecLoss,
    phaseSplit,
  };
}

// ── £100 simulation ───────────────────────────────────────────────────────────

function runSimulation(allSignals, coinStats, forwardWindowsH) {
  const FEE = 0.0026;
  let pot = 100, totalFees = 0, trades = 0;
  let winningTrades = 0, losingTrades = 0;
  let largestWin = 0, largestLoss = 0, minPot = 100;
  let positions = [];
  const equityCurve = [];

  // Merge signals from all coins into a single timeline
  const timeline = [];
  for (const [coinId, signals] of Object.entries(allSignals)) {
    for (const s of signals) timeline.push({ ...s, coinId });
  }
  timeline.sort((a, b) => a.timestamp - b.timestamp || a.coinId.localeCompare(b.coinId));
  if (!timeline.length) return null;

  equityCurve.push({ timestamp: timeline[0].timestamp - 3600000, potValue: 100 });

  function recordEquity(ts) {
    minPot = Math.min(minPot, pot);
    equityCurve.push({ timestamp: ts, potValue: Math.max(0, +pot.toFixed(4)) });
  }

  function closePos(pos, exitPrice, ts) {
    if (exitPrice == null) return;
    const gross = pos.units * exitPrice;
    const exitFee = gross * FEE;
    const net = gross - exitFee;
    const pnl = net - pos.invested;
    pot += net; totalFees += exitFee; trades++;
    if (pnl >= 0) { winningTrades++; largestWin = Math.max(largestWin, pnl); }
    else { losingTrades++; largestLoss = Math.max(largestLoss, -pnl); }
    recordEquity(ts);
  }

  for (const event of timeline) {
    if (pot < 10) break;
    const { coinId, timestamp, close, signal } = event;
    const stats = coinStats[coinId];
    if (!stats) continue;

    // Time-based exits
    const next = [];
    for (const pos of positions) {
      if (pos.exitTimestamp <= timestamp) { closePos(pos, pos.exitPrice, timestamp); }
      else next.push(pos);
    }
    positions = next;

    // SELL: early exit from this coin
    if (signal === 'sell' || signal === 'strong_sell') {
      const kept = [];
      for (const pos of positions) {
        if (pos.coinId === coinId) closePos(pos, close, timestamp);
        else kept.push(pos);
      }
      positions = kept;
      continue;
    }

    // BUY: open position
    if ((signal === 'buy' || signal === 'strong_buy') && pot >= 10) {
      const pct = signal === 'strong_buy' ? 0.08 : 0.05;
      const coinExposure = positions.filter(p => p.coinId === coinId).reduce((s, p) => s + p.invested, 0);
      let invest = Math.min(pot * pct, pot * 0.5 - coinExposure);
      if (invest < 1) continue;

      const entryFee = invest * FEE;
      const units = (invest - entryFee) / close;
      pot -= invest; totalFees += entryFee;

      const bw = stats.bestWindow;
      positions.push({
        coinId, units, invested: invest,
        exitTimestamp: timestamp + bw * 3600000,
        exitPrice: event.forward[bw]?.price ?? null,
      });
      recordEquity(timestamp);
    }
  }

  // Close remaining positions at best available price
  const lastTs = timeline[timeline.length - 1].timestamp;
  for (const pos of positions) closePos(pos, pos.exitPrice ?? null, lastTs);
  positions = [];
  equityCurve.push({ timestamp: lastTs, potValue: Math.max(0, +pot.toFixed(4)) });

  return {
    startingPot: 100,
    finalPot: +pot.toFixed(4),
    profitLoss: +(pot - 100).toFixed(4),
    profitLossPct: +((pot - 100) / 100 * 100).toFixed(2),
    trades, winningTrades, losingTrades,
    largestWin: +largestWin.toFixed(4),
    largestLoss: +largestLoss.toFixed(4),
    minPot: +minPot.toFixed(4),
    totalFees: +totalFees.toFixed(4),
    equityCurve,
  };
}

// ── Benchmark: buy-and-hold equally weighted ──────────────────────────────────

function calcBenchmark(allSignals) {
  const FEE = 0.0026;
  const coinIds = Object.keys(allSignals).filter(id => allSignals[id].length > 0);
  if (!coinIds.length) return null;
  const perCoin = 100 / coinIds.length;
  let finalValue = 0;
  for (const id of coinIds) {
    const sigs = allSignals[id];
    const startPrice = sigs[0].close;
    const endPrice   = sigs[sigs.length - 1].close;
    const units = (perCoin * (1 - FEE)) / startPrice;
    finalValue += units * endPrice * (1 - FEE);
  }
  return { finalValue: +finalValue.toFixed(4), returnPct: +((finalValue - 100) / 100 * 100).toFixed(2) };
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runBacktest(db, params, onProgress) {
  const { coins, days, forwardWindows } = params;
  const testStartTs = Date.now() - days * 24 * 3600 * 1000;

  const allMeta = db.getAllMeta();
  const coinList = (coins === 'all')
    ? allMeta.map(m => m.id)
    : (Array.isArray(coins) ? coins : [coins]);

  // Market phase: BTC 200 EMA per hour in test period
  const btcAbove200Map = new Map();
  let marketPhase = null;
  const btcMeta = allMeta.find(m => m.id === 'bitcoin');
  if (btcMeta) {
    const btcCandles = db.getCandles('bitcoin', '1h', 0);
    const ema200 = new IncrEMA(200);
    let above = 0, total = 0, emaStart = null, emaEnd = null;
    for (const c of btcCandles) {
      const e = ema200.next(c.close);
      if (e === null) continue;
      if (c.time >= testStartTs) {
        const isAbove = c.close > e;
        btcAbove200Map.set(c.time, isAbove);
        if (isAbove) above++;
        total++;
        if (emaStart === null) emaStart = e;
        emaEnd = e;
      }
    }
    if (total > 0) {
      const pct = above / total;
      marketPhase = {
        label: pct < 0.30 ? 'Predominantly Bearish' : pct < 0.70 ? 'Mixed / Ranging' : 'Predominantly Bullish',
        abovePct: +(pct * 100).toFixed(1),
        ema200Start: emaStart !== null ? +emaStart.toFixed(2) : null,
        ema200End:   emaEnd   !== null ? +emaEnd.toFixed(2)   : null,
      };
    }
  }

  onProgress(5, 'Market phase complete');

  // Generate signals per coin
  const allSignals = {};
  const allStats   = {};
  let processed = 0;

  for (const coinId of coinList) {
    const candles = db.getCandles(coinId, '1h', 0);
    if (candles.length < 200) {
      processed++;
      onProgress(5 + Math.round((processed / coinList.length) * 75), `Skipped ${coinId}`);
      continue;
    }
    allSignals[coinId] = generateCoinSignals(candles, testStartTs, forwardWindows, btcAbove200Map);
    allStats[coinId]   = calcCoinStats(allSignals[coinId], forwardWindows);
    processed++;
    onProgress(5 + Math.round((processed / coinList.length) * 75), `Processed ${coinId}`);
  }

  onProgress(82, 'Running simulation');
  const simulation = runSimulation(allSignals, allStats, forwardWindows);
  const benchmark  = calcBenchmark(allSignals);

  onProgress(96, 'Finalising');

  // Slim signals for storage (drop forward prices of individual candles for HOLDs)
  const slimSignals = {};
  for (const [id, sigs] of Object.entries(allSignals)) {
    slimSignals[id] = sigs
      .filter(s => s.signal !== 'hold') // store only actionable signals
      .map(s => ({ timestamp: s.timestamp, close: s.close, signal: s.signal, score: s.score, btcAbove200: s.btcAbove200, forward: s.forward }));
  }

  return {
    runAt: Date.now(),
    params: { coins, days, forwardWindows },
    marketPhase,
    coinStats: allStats,
    simulation,
    benchmark,
    signals: slimSignals,
  };
}

module.exports = { runBacktest };
