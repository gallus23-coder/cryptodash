'use strict';

const SYSTEM_PROMPT = `You are the hourly decision layer for a Kraken spot trading bot ("cryptodash").
For each candidate, choose "take" or "skip". If taking, you may resize (0-1x) and adjust stopAtr/trailAtr, but only within the "ranges" given for that candidate - values outside that range will be clamped, not honored as-is.
For open positions, you may tighten a stop (never loosen it) or close. You may disable a setup for the rest of the current regime via setupToggles.
Respond with strict JSON only, matching this shape:
{"decisions":[{"candidateId":"...","action":"take|skip","size":0.0,"stopAtr":0.0,"trailAtr":0.0,"reason":"...","plainReason":"..."}],
 "positionActions":[],"setupToggles":[],"marketNote":"...","plainNote":{"mood":"...","bullets":["..."],"botAction":"..."}}
Any field you omit for a "skip" decision may be left out. Do not include commentary outside the JSON.`;

function buildDecisionPrompt(input) {
  const user = JSON.stringify({
    regime: input.regime,
    regimeMetrics: input.regimeMetrics,
    candidates: input.candidates,
    openPositions: input.openPositions,
    recentTrades: input.recentTrades,
    setupConfig: input.setupConfig,
    guardrailHeadroom: input.guardrailHeadroom,
  });
  return { system: SYSTEM_PROMPT, user };
}

function clamp(value, [min, max]) {
  return Math.min(Math.max(value, min), max);
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateTopLevelShape(parsed) {
  return isPlainObject(parsed)
    && Array.isArray(parsed.decisions)
    && Array.isArray(parsed.positionActions)
    && Array.isArray(parsed.setupToggles);
}

function sanitizeDecision(raw, candidatesById) {
  const candidate = candidatesById.get(raw.candidateId);
  if (!candidate) return null;
  if (raw.action !== 'take' && raw.action !== 'skip') return null;

  const decision = { candidateId: raw.candidateId, action: raw.action, reason: raw.reason || '', plainReason: raw.plainReason || '' };
  if (raw.action === 'take') {
    decision.size = clamp(typeof raw.size === 'number' ? raw.size : candidate.default.size, candidate.ranges.size);
    decision.stopAtr = clamp(typeof raw.stopAtr === 'number' ? raw.stopAtr : candidate.default.stopAtr, candidate.ranges.stopAtr);
    if (candidate.ranges.trailAtr) {
      decision.trailAtr = clamp(typeof raw.trailAtr === 'number' ? raw.trailAtr : candidate.default.trailAtr, candidate.ranges.trailAtr);
    }
  }
  return decision;
}

function sanitizePositionAction(raw, openPositionsByKey) {
  const position = openPositionsByKey.get(`${raw.coin}:${raw.setup}`);
  if (!position) return null;
  if (raw.action === 'close') return { coin: raw.coin, setup: raw.setup, action: 'close' };
  if (raw.action === 'tighten_stop' && typeof raw.newStopPrice === 'number') {
    // "Tighten only": a long's stop only ever moves up. A looser (lower) proposal is dropped, not clamped —
    // clamping to the current stop would silently turn a loosen attempt into a no-op positionAction, which
    // is indistinguishable from "Claude proposed exactly the current stop"; dropping it keeps the log honest.
    if (raw.newStopPrice > position.currentStopPrice) {
      return { coin: raw.coin, setup: raw.setup, action: 'tighten_stop', newStopPrice: raw.newStopPrice };
    }
    return null;
  }
  return null;
}

function sanitizeSetupToggle(raw, setupNameSet) {
  if (!setupNameSet.has(raw.setup)) return null;
  if (raw.action !== 'disable_setup') return null;
  return { setup: raw.setup, action: 'disable_setup' };
}

function fallbackResult(error) {
  return { decisions: [], positionActions: [], setupToggles: [], marketNote: '', plainNote: null, fallback: true, error };
}

function parseDecisionResponse(rawText, { candidates, openPositions, setupNames }) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return fallbackResult(`invalid JSON: ${err.message}`);
  }
  if (!validateTopLevelShape(parsed)) {
    return fallbackResult('response shape invalid: decisions/positionActions/setupToggles must be arrays');
  }

  const candidatesById = new Map(candidates.map((c) => [c.id, c]));
  const openPositionsByKey = new Map(openPositions.map((p) => [`${p.coin}:${p.setup}`, p]));
  const setupNameSet = new Set(setupNames);

  return {
    decisions: parsed.decisions.map((d) => sanitizeDecision(d, candidatesById)).filter(Boolean),
    positionActions: parsed.positionActions.map((p) => sanitizePositionAction(p, openPositionsByKey)).filter(Boolean),
    setupToggles: parsed.setupToggles.map((t) => sanitizeSetupToggle(t, setupNameSet)).filter(Boolean),
    marketNote: typeof parsed.marketNote === 'string' ? parsed.marketNote : '',
    plainNote: parsed.plainNote || null,
    fallback: false,
  };
}

module.exports = { buildDecisionPrompt, parseDecisionResponse };
