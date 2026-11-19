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

module.exports = { buildDecisionPrompt };
