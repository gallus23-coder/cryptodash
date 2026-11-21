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

module.exports = { pollOrderStatus, tryOpenPosition };
