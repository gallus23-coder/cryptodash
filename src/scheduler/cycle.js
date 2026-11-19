'use strict';

const HOUR = 3600, FOUR_H = 4 * HOUR, DAY = 24 * HOUR;

function isFourHourBoundary(tsSeconds) {
  return tsSeconds % FOUR_H === 0;
}

function utcDayKey(tsSeconds) {
  return Math.floor(tsSeconds / DAY);
}

function freshState(startingBalance = 1000) {
  return {
    balance: startingBalance, dailyPnl: 0, currentDay: null,
    weeklyPeakBalance: startingBalance, killSwitchActive: false,
    openPositions: [], cooldowns: {}, closedTrades: [],
    shadowPositions: [], disabledSetups: {}, lastRegimeLabel: null,
  };
}

const { getCandles, loadSchedulerState, saveSchedulerState, insertTrade, insertCycleLog, insertCandidate, updateCandidateShadow, insertDecision, getTrades } = require('../data/db');
const { ingestAllCoins } = require('../data/ingest');
const { computeRegimeSeries } = require('../engine/regime');
const { isDailyLossLimitHit, isKillSwitchTriggered } = require('../engine/risk');
const { buildCoinData } = require('../backtest/run');
const { SETUPS, SETUPS_BY_REGIME } = require('../engine/playbook');
const { DEFAULT_RISK_CONFIG, COIN_ALTNAMES, COINS } = require('../engine/config');
const { evaluateExit, tryOpenPosition, closePosition } = require('../broker/paper');
const { buildCandidateId, attachContext } = require('../engine/candidates');
const { openShadowPosition, resolveShadowPositions } = require('../broker/shadow');
const { decide } = require('../engine/decide');

const persistCycleResults = (db, mode, state) => db.transaction(() => {
  for (const trade of state.closedTrades) {
    insertTrade(db, {
      mode, coin: trade.coin, setup: trade.setup, entryTs: trade.entryTs, exitTs: trade.exitTs,
      entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, units: trade.units,
      riskAmount: trade.riskAmount, pnl: trade.pnl, r: trade.r, exitReason: trade.exitReason,
    });
  }
  state.closedTrades = [];
  saveSchedulerState(db, mode, state);
})();

async function runCycle(db, krakenClient, mode, config = DEFAULT_RISK_CONFIG, now = Date.now()) {
  const startedAt = Date.now();
  const nowHour = Math.floor(now / 1000 / HOUR) * HOUR;
  let regimeLabel = null, candidatesCount = 0, openedCount = 0, closedCount = 0;

  try {
    await ingestAllCoins(db, krakenClient, COIN_ALTNAMES, now);

    const btcDaily = getCandles(db, 'BTC', '1d', 0, nowHour);
    const btc4h = getCandles(db, 'BTC', '4h', 0, nowHour);
    const watchlistBy4h = {};
    const coinData = {};
    for (const coin of COINS) {
      const candles4h = getCandles(db, coin, '4h', 0, nowHour);
      watchlistBy4h[coin] = candles4h.map((c) => ({ ts: c.ts, close: c.close }));
      coinData[coin] = buildCoinData({
        candles4h,
        candles1h: getCandles(db, coin, '1h', 0, nowHour + FOUR_H),
        candlesDaily: getCandles(db, coin, '1d', 0, nowHour),
      });
    }

    const regimeSeries = computeRegimeSeries({ btcDaily, btc4h, watchlistBy4h });
    const currentRegime = [...regimeSeries].reverse().find((r) => r.ts <= nowHour);
    regimeLabel = currentRegime ? currentRegime.label : null;

    const state = loadSchedulerState(db, mode) || freshState();
    state.shadowPositions = state.shadowPositions || [];
    state.disabledSetups = state.disabledSetups || {};
    if (state.lastRegimeLabel === undefined) state.lastRegimeLabel = null;

    const dayKey = utcDayKey(nowHour);
    if (state.currentDay !== dayKey) {
      state.currentDay = dayKey;
      state.dailyPnl = 0;
    }
    if (state.lastRegimeLabel !== regimeLabel) {
      state.disabledSetups = {}; // "disable for the rest of the current regime" — a new regime clears it
      state.lastRegimeLabel = regimeLabel;
    }

    for (const position of [...state.openPositions]) {
      const data = coinData[position.coin];
      const candles1hSlice = data.candles1h.filter((c) => c.ts > position.entryTs && c.ts <= nowHour);
      const exit = evaluateExit(position, { candles1h: candles1hSlice, ema20By4hTs: data.ema20By4hTs });
      if (exit) {
        closePosition(state, position, exit, config);
        closedCount += 1;
      }
    }

    const { stillOpen, resolved } = resolveShadowPositions(state.shadowPositions, coinData);
    state.shadowPositions = stillOpen;
    for (const outcome of resolved) {
      updateCandidateShadow(db, outcome.candidateId, {
        status: 'resolved', exitTs: outcome.exitTs, pnl: outcome.pnl, r: outcome.r, exitReason: outcome.exitReason,
      });
    }

    state.weeklyPeakBalance = Math.max(state.weeklyPeakBalance, state.balance);
    const weeklyDrawdownPct = (state.weeklyPeakBalance - state.balance) / state.weeklyPeakBalance;
    if (isKillSwitchTriggered(weeklyDrawdownPct, config)) state.killSwitchActive = true;
    const balanceAtDayStart = state.balance - state.dailyPnl;
    const dailyLossHit = isDailyLossLimitHit(state.dailyPnl / balanceAtDayStart, config);

    if (regimeLabel && isFourHourBoundary(nowHour) && !state.killSwitchActive && !dailyLossHit && regimeLabel !== 'risk_off') {
      const cycleCandidates = [];
      const candidateContextById = new Map(); // candidateId -> { data, i }, so tryOpenPosition's args are available later without recomputing findIndex
      for (const coin of COINS) {
        const data = coinData[coin];
        const i = data.candles4h.findIndex((c) => c.ts === nowHour);
        if (i === -1) continue;
        for (const setupName of SETUPS_BY_REGIME[regimeLabel] || []) {
          if (state.disabledSetups[setupName] === regimeLabel) continue; // setup disabled for the rest of this regime
          const candidate = SETUPS[setupName].evaluate(coin, data.candles4h, data.indicators, i, regimeLabel);
          if (!candidate) continue;

          const withContext = attachContext(candidate, data.indicators, i);
          const fullCandidate = { ...withContext, id: buildCandidateId(nowHour, coin, setupName), mode, regime: regimeLabel, ts: nowHour };
          insertCandidate(db, fullCandidate);
          candidatesCount += 1;

          const alreadyHasShadow = state.shadowPositions.some((p) => p.candidateId === fullCandidate.id);
          if (!alreadyHasShadow) {
            state.shadowPositions.push(openShadowPosition(fullCandidate, data, i));
          }

          candidateContextById.set(fullCandidate.id, { data, i });
          cycleCandidates.push(fullCandidate);
        }
      }

      if (cycleCandidates.length > 0 || state.openPositions.length > 0) {
        const recentTrades = getTrades(db, mode).slice(-20);
        const guardrailHeadroom = {
          openPositionsRemaining: config.maxOpenPositions - state.openPositions.length,
          totalRiskPctRemaining: config.maxTotalRiskPct - state.openPositions.reduce((sum, p) => sum + p.riskPct, 0),
        };
        const decisionInput = {
          regime: regimeLabel, regimeMetrics: {}, candidates: cycleCandidates,
          openPositions: state.openPositions.map((p) => ({ coin: p.coin, setup: p.setup, currentStopPrice: p.initialStopPrice })),
          recentTrades: recentTrades.map((t) => ({ coin: t.coin, setup: t.setup, r: t.r, exitReason: t.exitReason })),
          setupConfig: Object.keys(SETUPS).reduce((acc, name) => {
            acc[name] = state.disabledSetups[name] === regimeLabel ? 'disabled_this_regime' : 'active';
            return acc;
          }, {}),
          guardrailHeadroom, setupNames: Object.keys(SETUPS),
        };

        const result = await decide(decisionInput, config);
        const decidedIds = new Set();

        for (const decision of result.decisions) {
          decidedIds.add(decision.candidateId);
          const candidate = cycleCandidates.find((c) => c.id === decision.candidateId);
          if (!candidate) continue; // defensive: parseDecisionResponse already guarantees this won't happen
          const diverged = decision.action !== candidate.default.action
            || (decision.action === 'take' && (decision.size !== candidate.default.size || decision.stopAtr !== candidate.default.stopAtr));

          insertDecision(db, {
            candidateId: candidate.id, ts: nowHour, mode, action: decision.action,
            size: decision.size ?? null, stopAtr: decision.stopAtr ?? null, trailAtr: decision.trailAtr ?? null,
            reason: decision.reason, plainReason: decision.plainReason, defaultAction: candidate.default.action,
            diverged, model: config.claudeModel, latencyMs: 0, rawResponse: JSON.stringify(decision),
          });

          if (decision.action === 'take') {
            const adjustedCandidate = {
              ...candidate,
              default: { ...candidate.default, size: decision.size, stopAtr: decision.stopAtr, trailAtr: decision.trailAtr ?? candidate.default.trailAtr },
            };
            const { data, i } = candidateContextById.get(candidate.id);
            const before = state.openPositions.length;
            tryOpenPosition(state, adjustedCandidate, data, i, config);
            if (state.openPositions.length > before) openedCount += 1;
          }
        }

        for (const candidate of cycleCandidates) {
          if (decidedIds.has(candidate.id)) continue;
          insertDecision(db, {
            candidateId: candidate.id, ts: nowHour, mode, action: 'skip',
            size: null, stopAtr: null, trailAtr: null,
            reason: result.fallback ? (result.error || 'fallback') : 'not in decisions (unknown id or invalid action, dropped by parseDecisionResponse)',
            plainReason: result.fallback ? 'Sat out this hour after a problem talking to the decision model.' : 'Sat out.',
            defaultAction: candidate.default.action, diverged: false,
            model: result.fallback ? 'fallback' : config.claudeModel, latencyMs: 0, rawResponse: JSON.stringify(result),
          });
        }

        for (const action of result.positionActions) {
          const position = state.openPositions.find((p) => p.coin === action.coin && p.setup === action.setup);
          if (!position) continue;
          if (action.action === 'close') {
            const closingBar = coinData[position.coin].candles4h.find((c) => c.ts === nowHour);
            if (!closingBar) continue; // no 4h candle at this exact ts for this coin — skip rather than crash on undefined.close
            closePosition(state, position, { exitTs: nowHour, exitPrice: closingBar.close, reason: 'claude_close' }, config);
            closedCount += 1;
          } else if (action.action === 'tighten_stop') {
            position.initialStopPrice = Math.max(position.initialStopPrice, action.newStopPrice);
          }
        }

        for (const toggle of result.setupToggles) {
          if (toggle.action === 'disable_setup') state.disabledSetups[toggle.setup] = regimeLabel;
        }
      }
    }

    persistCycleResults(db, mode, state);
    insertCycleLog(db, {
      ts: nowHour, mode, regimeLabel, candidatesCount, openedCount, closedCount,
      durationMs: Date.now() - startedAt,
    });

    return { regimeLabel, candidatesCount, openedCount, closedCount };
  } catch (err) {
    insertCycleLog(db, {
      ts: nowHour, mode, regimeLabel, candidatesCount, openedCount, closedCount,
      durationMs: Date.now() - startedAt, error: err.message,
    });
    return { error: err.message };
  }
}

module.exports = { isFourHourBoundary, utcDayKey, freshState, persistCycleResults, runCycle };
