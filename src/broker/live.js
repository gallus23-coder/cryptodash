'use strict';
const { sizePosition, checkFeeViability, checkGuardrails } = require('../engine/risk');
const { COIN_ALTNAMES } = require('../engine/config');

async function pollOrderStatus(krakenClient, txid, { timeoutMs, pollMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const statusResult = await krakenClient.queryOrders([txid]);
    const order = statusResult[txid];
    if (order.status === 'closed') return order;
    if (order.status === 'canceled') return null;
    await sleep(pollMs);
  }
  return null;
}

async function tryOpenPosition(state, candidate, data, i, config, krakenClient, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;

  const atrPct = (candidate.atr / candidate.entry) * 100;
  if (!checkFeeViability({ atrPct, roundTripFeePct: config.roundTripFeePct })) return null;

  const stopPrice = candidate.entry - candidate.default.stopAtr * candidate.atr;
  const riskPct = config.baseRiskPct * candidate.default.size;
  const sizing = sizePosition({ balance: state.balance, riskPct, entryPrice: candidate.entry, stopPrice });
  const exposurePct = sizing.stakeValue / state.balance;
  const barTs = data.candles4h[i].ts;

  const gate = checkGuardrails(
    { openPositions: state.openPositions.map((p) => ({ coin: p.coin, riskPct: p.riskPct, exposurePct: p.exposurePct })), cooldowns: state.cooldowns },
    { coin: candidate.coin, riskPct, exposurePct, ts: barTs },
    config,
  );
  if (!gate.allowed) return null;

  const pair = COIN_ALTNAMES[candidate.coin];
  const entryPlaced = await krakenClient.addOrder({
    pair, type: 'buy', ordertype: 'limit', price: String(candidate.entry), volume: String(sizing.units),
    oflags: 'post', cl_ord_id: candidate.id,
  });
  const entryTxid = entryPlaced.txid[0];

  const entryOrder = await pollOrderStatus(krakenClient, entryTxid, {
    timeoutMs: config.liveOrderTimeoutMs, pollMs: config.liveOrderPollMs, sleep, now,
  });
  if (!entryOrder) {
    await krakenClient.cancelOrder(entryTxid);
    return null;
  }

  const stopOrderPlaced = await krakenClient.addOrder({
    pair, type: 'sell', ordertype: 'stop-loss', price: String(stopPrice), volume: String(sizing.units),
    cl_ord_id: `${candidate.id}_exit`,
  });

  const position = {
    coin: candidate.coin, setup: candidate.setup, entryTs: barTs, candidateId: candidate.id,
    entryPrice: Number(entryOrder.price), units: sizing.units, riskAmount: sizing.riskAmount,
    riskPct, exposurePct, initialStopPrice: stopPrice, atrAtEntry: candidate.atr,
    exitType: candidate.exitType, trailAtr: candidate.default.trailAtr,
    targetPrice: candidate.exitType === 'target_or_time' ? data.indicators.bollinger20.middle[i] : undefined,
    timeStopTs: candidate.timeStopHours !== undefined ? barTs + candidate.timeStopHours * 3600 : undefined,
    entryFee: Number(entryOrder.fee),
    stopOrderTxid: stopOrderPlaced.txid[0],
  };
  state.openPositions.push(position);
  return position;
}

async function closeAtMarket(position, reason, exitTs, pair, krakenClient, config, deps) {
  await krakenClient.cancelOrder(position.stopOrderTxid);
  const placed = await krakenClient.addOrder({
    pair, type: 'sell', ordertype: 'market', volume: String(position.units),
    cl_ord_id: `${position.candidateId}_${reason}`,
  });
  const txid = placed.txid[0];
  const filled = await pollOrderStatus(krakenClient, txid, {
    timeoutMs: config.liveMarketOrderTimeoutMs, pollMs: config.liveOrderPollMs, sleep: deps.sleep, now: deps.now,
  });
  if (!filled) throw new Error(`market sell order ${txid} did not fill within ${config.liveMarketOrderTimeoutMs}ms`);
  return { exitTs, exitPrice: Number(filled.price), reason, feeAmount: Number(filled.fee) };
}

async function evaluateExit(position, context, krakenClient, config, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;

  const statusResult = await krakenClient.queryOrders([position.stopOrderTxid]);
  const order = statusResult[position.stopOrderTxid];

  if (order.status === 'closed') {
    return { exitTs: context.nowTs, exitPrice: Number(order.price), reason: 'stop', feeAmount: Number(order.fee) };
  }

  const candles1h = context.candles1h;
  if (candles1h.length === 0) return null;

  if (position.exitType === 'trailing_stop') {
    const highestHigh = candles1h.reduce((max, c) => Math.max(max, c.high), position.entryPrice);
    const trailLevel = Math.max(position.initialStopPrice, highestHigh - position.trailAtr * position.atrAtEntry);
    const currentTrigger = Number(order.descr.price);
    if (trailLevel > currentTrigger) {
      await krakenClient.amendOrder({ txid: position.stopOrderTxid, trigger_price: String(trailLevel) });
    }
    return null;
  }

  const lastCandle = candles1h[candles1h.length - 1];

  if (position.exitType === 'target_or_time') {
    if (lastCandle.high >= position.targetPrice) {
      return closeAtMarket(position, 'target', lastCandle.ts, context.pair, krakenClient, config, { sleep, now });
    }
    if (lastCandle.ts >= position.timeStopTs) {
      return closeAtMarket(position, 'time_stop', lastCandle.ts, context.pair, krakenClient, config, { sleep, now });
    }
  }

  if (position.exitType === 'ema_cross_or_time') {
    const isLastHourOfFourHourPeriod = lastCandle.ts % 14400 === 10800;
    if (isLastHourOfFourHourPeriod) {
      const fourHourTs = lastCandle.ts - 10800;
      const ema20 = context.ema20By4hTs.get(fourHourTs);
      if (ema20 !== undefined && lastCandle.close > ema20) {
        return closeAtMarket(position, 'ema_cross', lastCandle.ts, context.pair, krakenClient, config, { sleep, now });
      }
    }
    if (lastCandle.ts >= position.timeStopTs) {
      return closeAtMarket(position, 'time_stop', lastCandle.ts, context.pair, krakenClient, config, { sleep, now });
    }
  }

  return null;
}

function closePosition(state, position, exit, config) {
  const pnl = (exit.exitPrice - position.entryPrice) * position.units - position.entryFee - exit.feeAmount;
  const r = pnl / position.riskAmount;

  state.balance += pnl;
  state.dailyPnl += pnl;
  state.openPositions = state.openPositions.filter((p) => p !== position);
  state.cooldowns[position.coin] = exit.exitTs + config.cooldownHours * 3600;
  state.closedTrades.push({ ...position, exitTs: exit.exitTs, exitPrice: exit.exitPrice, pnl, r, exitReason: exit.reason });
}

module.exports = { pollOrderStatus, tryOpenPosition, evaluateExit, closePosition };
