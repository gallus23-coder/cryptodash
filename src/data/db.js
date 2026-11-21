'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'cryptodash-v2.db');

function openDb(dbPath = process.env.CRYPTODASH_DB_PATH || DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      coin      TEXT    NOT NULL,
      timeframe TEXT    NOT NULL,
      ts        INTEGER NOT NULL,
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      trades    INTEGER,
      PRIMARY KEY (coin, timeframe, ts)
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL, coin TEXT NOT NULL, setup TEXT NOT NULL,
      entry_ts INTEGER NOT NULL, exit_ts INTEGER NOT NULL,
      entry_price REAL NOT NULL, exit_price REAL NOT NULL,
      units REAL NOT NULL, risk_amount REAL NOT NULL,
      pnl REAL NOT NULL, r REAL NOT NULL, exit_reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_state (
      mode TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cycle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, mode TEXT NOT NULL, regime_label TEXT,
      candidates_count INTEGER NOT NULL, opened_count INTEGER NOT NULL, closed_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, mode TEXT NOT NULL,
      coin TEXT NOT NULL, setup TEXT NOT NULL, regime TEXT NOT NULL,
      entry REAL NOT NULL, atr REAL NOT NULL,
      default_json TEXT NOT NULL, ranges_json TEXT NOT NULL, context_json TEXT NOT NULL,
      shadow_status TEXT NOT NULL DEFAULT 'open',
      shadow_exit_ts INTEGER, shadow_pnl REAL, shadow_r REAL, shadow_exit_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, ts INTEGER NOT NULL, mode TEXT NOT NULL,
      action TEXT NOT NULL, size REAL, stop_atr REAL, trail_atr REAL,
      reason TEXT, plain_reason TEXT, default_action TEXT NOT NULL, diverged INTEGER NOT NULL,
      model TEXT NOT NULL, latency_ms INTEGER NOT NULL, raw_response TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS config_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      config_json TEXT NOT NULL, backtest_json TEXT,
      created_ts INTEGER NOT NULL, decided_ts INTEGER
    );
  `);

  const tradeColumns = db.prepare("PRAGMA table_info(trades)").all().map((c) => c.name);
  if (!tradeColumns.includes('candidate_id')) {
    db.exec('ALTER TABLE trades ADD COLUMN candidate_id TEXT');
  }

  const cycleLogColumns = db.prepare("PRAGMA table_info(cycle_log)").all().map((c) => c.name);
  if (!cycleLogColumns.includes('market_note')) {
    db.exec('ALTER TABLE cycle_log ADD COLUMN market_note TEXT');
  }
  if (!cycleLogColumns.includes('plain_note_json')) {
    db.exec('ALTER TABLE cycle_log ADD COLUMN plain_note_json TEXT');
  }

  return db;
}

function insertTrade(db, trade) {
  db.prepare(`
    INSERT INTO trades (mode, coin, setup, entry_ts, exit_ts, entry_price, exit_price, units, risk_amount, pnl, r, exit_reason, candidate_id)
    VALUES (@mode, @coin, @setup, @entryTs, @exitTs, @entryPrice, @exitPrice, @units, @riskAmount, @pnl, @r, @exitReason, @candidateId)
  `).run({ candidateId: null, ...trade });
}

function getTrades(db, mode) {
  return db.prepare(`
    SELECT id, mode, coin, setup,
      entry_ts AS entryTs, exit_ts AS exitTs,
      entry_price AS entryPrice, exit_price AS exitPrice,
      units, risk_amount AS riskAmount, pnl, r, exit_reason AS exitReason,
      candidate_id AS candidateId
    FROM trades WHERE mode = ? ORDER BY exit_ts ASC
  `).all(mode);
}

function insertCandidate(db, candidate) {
  db.prepare(`
    INSERT INTO candidates (id, ts, mode, coin, setup, regime, entry, atr, default_json, ranges_json, context_json)
    VALUES (@id, @ts, @mode, @coin, @setup, @regime, @entry, @atr, @defaultJson, @rangesJson, @contextJson)
    ON CONFLICT(id) DO UPDATE SET
      ts = excluded.ts, mode = excluded.mode, coin = excluded.coin, setup = excluded.setup, regime = excluded.regime,
      entry = excluded.entry, atr = excluded.atr, default_json = excluded.default_json,
      ranges_json = excluded.ranges_json, context_json = excluded.context_json
  `).run({
    id: candidate.id, ts: candidate.ts, mode: candidate.mode, coin: candidate.coin, setup: candidate.setup,
    regime: candidate.regime, entry: candidate.entry, atr: candidate.atr,
    defaultJson: JSON.stringify(candidate.default), rangesJson: JSON.stringify(candidate.ranges),
    contextJson: JSON.stringify(candidate.context),
  });
}

function rowToCandidate(row) {
  if (!row) return null;
  return {
    id: row.id, ts: row.ts, mode: row.mode, coin: row.coin, setup: row.setup, regime: row.regime,
    entry: row.entry, atr: row.atr,
    default: JSON.parse(row.default_json), ranges: JSON.parse(row.ranges_json), context: JSON.parse(row.context_json),
    shadowStatus: row.shadow_status, shadowExitTs: row.shadow_exit_ts,
    shadowPnl: row.shadow_pnl, shadowR: row.shadow_r, shadowExitReason: row.shadow_exit_reason,
  };
}

function getCandidate(db, id) {
  return rowToCandidate(db.prepare('SELECT * FROM candidates WHERE id = ?').get(id));
}

function updateCandidateShadow(db, id, { status, exitTs, pnl, r, exitReason }) {
  db.prepare(`
    UPDATE candidates SET shadow_status = @status, shadow_exit_ts = @exitTs,
      shadow_pnl = @pnl, shadow_r = @r, shadow_exit_reason = @exitReason
    WHERE id = @id
  `).run({ id, status, exitTs, pnl, r, exitReason });
}

function insertDecision(db, decision) {
  db.prepare(`
    INSERT INTO decisions (candidate_id, ts, mode, action, size, stop_atr, trail_atr, reason, plain_reason, default_action, diverged, model, latency_ms, raw_response)
    VALUES (@candidateId, @ts, @mode, @action, @size, @stopAtr, @trailAtr, @reason, @plainReason, @defaultAction, @diverged, @model, @latencyMs, @rawResponse)
  `).run({ ...decision, diverged: decision.diverged ? 1 : 0 });
}

function getDecisions(db, mode, limit = 50) {
  return db.prepare(`
    SELECT candidate_id AS candidateId, ts, mode, action, size, stop_atr AS stopAtr, trail_atr AS trailAtr,
      reason, plain_reason AS plainReason, default_action AS defaultAction, diverged, model, latency_ms AS latencyMs, raw_response AS rawResponse
    FROM decisions WHERE mode = ? ORDER BY ts DESC LIMIT ?
  `).all(mode, limit).map((row) => ({ ...row, diverged: !!row.diverged }));
}

function getDecisionsFiltered(db, { mode = 'paper', from, to, coin, setup, diverged } = {}) {
  const clauses = ['d.mode = @mode'];
  const params = { mode };
  if (from !== undefined) { clauses.push('d.ts >= @from'); params.from = from; }
  if (to !== undefined) { clauses.push('d.ts <= @to'); params.to = to; }
  if (coin !== undefined) { clauses.push('c.coin = @coin'); params.coin = coin; }
  if (setup !== undefined) { clauses.push('c.setup = @setup'); params.setup = setup; }
  if (diverged !== undefined) { clauses.push('d.diverged = @diverged'); params.diverged = diverged ? 1 : 0; }

  return db.prepare(`
    SELECT d.candidate_id AS candidateId, d.ts, d.mode, d.action,
      d.size, d.stop_atr AS stopAtr, d.trail_atr AS trailAtr,
      d.reason, d.plain_reason AS plainReason, d.default_action AS defaultAction,
      d.diverged, d.model, d.latency_ms AS latencyMs,
      c.coin, c.setup, c.regime
    FROM decisions d JOIN candidates c ON c.id = d.candidate_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY d.ts DESC
  `).all(params).map((row) => ({ ...row, diverged: !!row.diverged }));
}

function getCycleLogByTs(db, mode, ts) {
  return db.prepare(`
    SELECT ts, mode, regime_label AS regimeLabel, candidates_count AS candidatesCount,
      opened_count AS openedCount, closed_count AS closedCount, duration_ms AS durationMs, error
    FROM cycle_log WHERE mode = ? AND ts = ?
  `).get(mode, ts) || null;
}

function getCandidatesByTs(db, mode, ts) {
  return db.prepare('SELECT * FROM candidates WHERE mode = ? AND ts = ?').all(mode, ts).map(rowToCandidate);
}

function getTradeByCandidateId(db, candidateId, mode) {
  const row = db.prepare(`
    SELECT id, mode, coin, setup, entry_ts AS entryTs, exit_ts AS exitTs,
      entry_price AS entryPrice, exit_price AS exitPrice, units, risk_amount AS riskAmount,
      pnl, r, exit_reason AS exitReason, candidate_id AS candidateId
    FROM trades WHERE candidate_id = ? AND mode = ?
  `).get(candidateId, mode);
  return row || null;
}

function getDecisionByCandidateId(db, candidateId, mode) {
  const row = db.prepare(`
    SELECT candidate_id AS candidateId, ts, mode, action, size, stop_atr AS stopAtr, trail_atr AS trailAtr,
      reason, plain_reason AS plainReason, default_action AS defaultAction, diverged, model, latency_ms AS latencyMs
    FROM decisions WHERE candidate_id = ? AND mode = ?
  `).get(candidateId, mode);
  return row ? { ...row, diverged: !!row.diverged } : null;
}

function getScorecardData(db, mode, sinceTs) {
  return db.prepare(`
    SELECT c.id AS candidateId, c.shadow_r AS shadowR,
      d.diverged, d.action AS decisionAction,
      t.r AS tradeR
    FROM candidates c
    LEFT JOIN decisions d ON d.candidate_id = c.id AND d.mode = c.mode
    LEFT JOIN trades t ON t.candidate_id = c.id AND t.mode = c.mode
    WHERE c.mode = ? AND c.ts >= ? AND c.shadow_status = 'resolved'
  `).all(mode, sinceTs).map((row) => ({ ...row, diverged: !!row.diverged }));
}

function buildCycleOneLiner({ regimeLabel, candidatesCount, openedCount, closedCount, error }) {
  if (error) return `Problem this hour: ${error}`;
  if (closedCount > 0) return `Closed ${closedCount} position${closedCount === 1 ? '' : 's'} (${regimeLabel}).`;
  if (openedCount > 0) return `Opened ${openedCount} position${openedCount === 1 ? '' : 's'} (${regimeLabel}).`;
  if (candidatesCount > 0) return `${candidatesCount} candidate${candidatesCount === 1 ? '' : 's'} found, none taken (${regimeLabel}).`;
  return `No candidates this hour (${regimeLabel}).`;
}

function buildGoLiveChecklist({ tradeCount, expectancy, scorecardNotEnoughData, scorecardClaudeMeanR }) {
  return {
    trades60: { count: tradeCount, expectancy, required: 60, pass: tradeCount >= 60 && expectancy > 0 },
    scorecard: scorecardNotEnoughData
      ? { pass: null, detail: 'not enough data yet' }
      : { pass: scorecardClaudeMeanR >= 0, claudeMeanR: scorecardClaudeMeanR },
    reconcileTested: { pass: null, detail: 'not testable yet — no live credentials configured / account not funded' },
    killSwitchTested: { pass: true, detail: 'built and deliberately tested — see docs/superpowers/plans/2026-11-21-safety-mechanism-testing.md' },
    dailyLossLimitTested: { pass: true, detail: 'built and deliberately tested — see docs/superpowers/plans/2026-11-21-safety-mechanism-testing.md' },
    krakenKeyNoWithdraw: { pass: null, detail: 'manual check required — confirm permissions in Kraken account settings' },
  };
}

function getCycleLogFiltered(db, { mode = 'paper', from, to, regime, limit = 100 } = {}) {
  const clauses = ['mode = @mode'];
  const params = { mode, limit };
  if (from !== undefined) { clauses.push('ts >= @from'); params.from = from; }
  if (to !== undefined) { clauses.push('ts <= @to'); params.to = to; }
  if (regime !== undefined) { clauses.push('regime_label = @regime'); params.regime = regime; }

  return db.prepare(`
    SELECT ts, mode, regime_label AS regimeLabel, candidates_count AS candidatesCount,
      opened_count AS openedCount, closed_count AS closedCount, duration_ms AS durationMs, error
    FROM cycle_log WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT @limit
  `).all(params).map((row) => ({ ...row, oneLiner: buildCycleOneLiner(row) }));
}

function getTradesByCoin(db, mode, coin, fromTs, toTs) {
  return db.prepare(`
    SELECT id, mode, coin, setup, entry_ts AS entryTs, exit_ts AS exitTs,
      entry_price AS entryPrice, exit_price AS exitPrice, units, risk_amount AS riskAmount,
      pnl, r, exit_reason AS exitReason, candidate_id AS candidateId
    FROM trades WHERE mode = ? AND coin = ? AND entry_ts >= ? AND entry_ts <= ?
    ORDER BY entry_ts ASC
  `).all(mode, coin, fromTs, toTs);
}

function getCandidatesByCoin(db, mode, coin, fromTs, toTs) {
  return db.prepare('SELECT * FROM candidates WHERE mode = ? AND coin = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC')
    .all(mode, coin, fromTs, toTs).map(rowToCandidate);
}

function getRegimeHistory(db, mode, fromTs, toTs) {
  return db.prepare(`
    SELECT ts, regime_label AS label FROM cycle_log
    WHERE mode = ? AND ts >= ? AND ts <= ? AND regime_label IS NOT NULL
    ORDER BY ts ASC
  `).all(mode, fromTs, toTs);
}

function getSetupStats(db, mode, setupName, sinceTs) {
  const { computeExpectancy } = require('../backtest/stats');
  const trades = getTrades(db, mode).filter((t) => t.setup === setupName && t.exitTs >= sinceTs);
  return computeExpectancy(trades);
}

const DEFAULT_CONFIG_VERSION = { riskLevel: 'normal', disabledSetups: [], rangeOverrides: {} };

function rowToConfigVersion(row) {
  if (!row) return null;
  return {
    id: row.id, mode: row.mode, status: row.status,
    config: JSON.parse(row.config_json),
    backtest: row.backtest_json ? JSON.parse(row.backtest_json) : null,
    createdTs: row.created_ts, decidedTs: row.decided_ts,
  };
}

function insertConfigVersion(db, { mode, configJson, backtestJson }) {
  const result = db.prepare(`
    INSERT INTO config_versions (mode, status, config_json, backtest_json, created_ts)
    VALUES (@mode, 'pending', @configJson, @backtestJson, @createdTs)
  `).run({
    mode, configJson: JSON.stringify(configJson), backtestJson: JSON.stringify(backtestJson), createdTs: Date.now(),
  });
  return result.lastInsertRowid;
}

function getActiveConfigVersion(db, mode) {
  const row = db.prepare("SELECT * FROM config_versions WHERE mode = ? AND status = 'active' ORDER BY decided_ts DESC LIMIT 1").get(mode);
  if (row) return rowToConfigVersion(row);
  return { id: null, mode, status: 'active', config: DEFAULT_CONFIG_VERSION, backtest: null, createdTs: null, decidedTs: null };
}

function getPendingConfigVersion(db, mode) {
  const row = db.prepare("SELECT * FROM config_versions WHERE mode = ? AND status = 'pending' ORDER BY created_ts DESC LIMIT 1").get(mode);
  return rowToConfigVersion(row);
}

function supersedePendingConfigVersions(db, mode) {
  db.prepare("UPDATE config_versions SET status = 'superseded' WHERE mode = ? AND status = 'pending'").run(mode);
}

function approveConfigVersion(db, mode, id) {
  const row = db.prepare('SELECT * FROM config_versions WHERE id = ? AND mode = ?').get(id, mode);
  if (!row || row.status !== 'pending') throw new Error(`config version ${id} is not pending`);
  db.transaction(() => {
    db.prepare("UPDATE config_versions SET status = 'superseded' WHERE mode = ? AND status = 'active'").run(mode);
    db.prepare("UPDATE config_versions SET status = 'active', decided_ts = ? WHERE id = ?").run(Date.now(), id);
  })();
}

function rejectConfigVersion(db, mode, id) {
  const row = db.prepare('SELECT * FROM config_versions WHERE id = ? AND mode = ?').get(id, mode);
  if (!row || row.status !== 'pending') throw new Error(`config version ${id} is not pending`);
  db.prepare("UPDATE config_versions SET status = 'rejected', decided_ts = ? WHERE id = ?").run(Date.now(), id);
}

function saveSchedulerState(db, mode, state) {
  db.prepare(`
    INSERT INTO scheduler_state (mode, state_json, updated_ts) VALUES (@mode, @stateJson, @updatedTs)
    ON CONFLICT(mode) DO UPDATE SET state_json = excluded.state_json, updated_ts = excluded.updated_ts
  `).run({ mode, stateJson: JSON.stringify(state), updatedTs: Date.now() });
}

function loadSchedulerState(db, mode) {
  const row = db.prepare('SELECT state_json FROM scheduler_state WHERE mode = ?').get(mode);
  return row ? JSON.parse(row.state_json) : null;
}

function resetKillSwitch(db, mode) {
  const state = loadSchedulerState(db, mode);
  if (!state) throw new Error(`no scheduler state for mode ${mode}`);
  state.killSwitchActive = false;
  state.weeklyPeakBalance = state.balance; // rebase so weeklyDrawdownPct is 0 right away — otherwise the next cycle re-trips the same trigger instantly
  saveSchedulerState(db, mode, state);
  return state;
}

function insertCycleLog(db, row) {
  db.prepare(`
    INSERT INTO cycle_log (ts, mode, regime_label, candidates_count, opened_count, closed_count, duration_ms, error, market_note, plain_note_json)
    VALUES (@ts, @mode, @regimeLabel, @candidatesCount, @openedCount, @closedCount, @durationMs, @error, @marketNote, @plainNoteJson)
  `).run({
    error: null, marketNote: null, ...row,
    plainNoteJson: row.plainNote !== undefined ? JSON.stringify(row.plainNote) : null,
  });
}

function getLatestMarketNote(db, mode) {
  const row = db.prepare(`
    SELECT ts, market_note AS marketNote, plain_note_json AS plainNoteJson
    FROM cycle_log WHERE mode = ? AND market_note IS NOT NULL
    ORDER BY ts DESC LIMIT 1
  `).get(mode);
  if (!row) return null;
  return { ts: row.ts, marketNote: row.marketNote, plainNote: row.plainNoteJson ? JSON.parse(row.plainNoteJson) : null };
}

function getCycleLog(db, mode, limit = 50) {
  return db.prepare('SELECT * FROM cycle_log WHERE mode = ? ORDER BY ts DESC LIMIT ?').all(mode, limit);
}

function upsertCandles(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO candles (coin, timeframe, ts, open, high, low, close, volume, trades)
    VALUES (@coin, @timeframe, @ts, @open, @high, @low, @close, @volume, @trades)
    ON CONFLICT(coin, timeframe, ts) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, volume = excluded.volume, trades = excluded.trades
  `);
  const insertMany = db.transaction((items) => {
    for (const row of items) stmt.run({ trades: null, ...row });
  });
  insertMany(rows);
  return rows.length;
}

function getCandles(db, coin, timeframe, fromTs, toTs) {
  return db.prepare(`
    SELECT ts, open, high, low, close, volume, trades FROM candles
    WHERE coin = ? AND timeframe = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(coin, timeframe, fromTs, toTs);
}

function getLastCandleTime(db, coin, timeframe) {
  const row = db.prepare(`
    SELECT MAX(ts) as maxTs FROM candles WHERE coin = ? AND timeframe = ?
  `).get(coin, timeframe);
  return row.maxTs ?? null;
}

function getExistingTimes(db, coin, timeframe, fromTs, toTs) {
  return db.prepare(`
    SELECT ts FROM candles WHERE coin = ? AND timeframe = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC
  `).all(coin, timeframe, fromTs, toTs).map((r) => r.ts);
}

module.exports = {
  openDb, upsertCandles, getCandles, getLastCandleTime, getExistingTimes, DEFAULT_DB_PATH,
  insertTrade, getTrades, saveSchedulerState, loadSchedulerState, insertCycleLog, getCycleLog,
  insertCandidate, getCandidate, updateCandidateShadow, insertDecision, getDecisions,
  getDecisionsFiltered, getCycleLogByTs, getCandidatesByTs, getTradeByCandidateId, getDecisionByCandidateId,
  getScorecardData, buildCycleOneLiner, getCycleLogFiltered, buildGoLiveChecklist,
  getTradesByCoin, getCandidatesByCoin, getRegimeHistory, getLatestMarketNote, getSetupStats,
  insertConfigVersion, getActiveConfigVersion, getPendingConfigVersion,
  approveConfigVersion, rejectConfigVersion, supersedePendingConfigVersions,
  resetKillSwitch,
};
