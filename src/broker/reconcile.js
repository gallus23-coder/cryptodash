'use strict';
const { loadSchedulerState } = require('../data/db');
const { BALANCE_ASSET_CODES } = require('../engine/config');

const BALANCE_TOLERANCE_PCT = 0.001;

async function reconcile(db, mode, krakenClient) {
  if (mode !== 'live') return { ok: true };

  const state = loadSchedulerState(db, mode) || { openPositions: [] };
  const openOrdersResult = await krakenClient.getOpenOrders();
  const balanceResult = await krakenClient.getBalance();

  const openTxids = new Set(Object.keys(openOrdersResult.open || {}));
  const trackedTxids = new Set(state.openPositions.map((p) => p.stopOrderTxid));

  const mismatches = [];

  for (const position of state.openPositions) {
    if (!openTxids.has(position.stopOrderTxid)) {
      mismatches.push({
        type: 'missing_stop_order',
        detail: `position ${position.candidateId} (${position.coin}) expects open stop order ${position.stopOrderTxid}, not found on Kraken`,
      });
    }
  }

  for (const txid of openTxids) {
    if (!trackedTxids.has(txid)) {
      mismatches.push({ type: 'unexpected_order', detail: `Kraken order ${txid} is open but not tracked by any DB position` });
    }
  }

  for (const position of state.openPositions) {
    const assetCode = BALANCE_ASSET_CODES[position.coin];
    const balance = Number(balanceResult[assetCode] ?? 0);
    if (balance < position.units * (1 - BALANCE_TOLERANCE_PCT)) {
      mismatches.push({
        type: 'insufficient_balance',
        detail: `position ${position.candidateId} expects ${position.units} ${position.coin}, Kraken balance is ${balance}`,
      });
    }
  }

  return mismatches.length > 0 ? { ok: false, mismatches } : { ok: true };
}

module.exports = { reconcile, BALANCE_TOLERANCE_PCT };
