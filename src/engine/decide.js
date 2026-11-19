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
  if (!isPlainObject(raw)) return null;
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
  if (!isPlainObject(raw)) return null;
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
  if (!isPlainObject(raw)) return null;
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

const { execFile } = require('child_process');
const os = require('os');

function buildCliArgs(promptPair, config) {
  return [
    '-p', '--output-format', 'json',
    '--model', config.claudeModel,
    '--effort', config.claudeEffort,
    '--allowedTools', '',
    '--system-prompt', promptPair.system,
    promptPair.user,
  ];
}

function stripMarkdownFences(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\n([\s\S]*)\n```$/);
  return match ? match[1] : trimmed;
}

function callClaudeCli(promptPair, config) {
  return new Promise((resolve, reject) => {
    // cwd is deliberately NOT this repo, so the call never discovers this project's own CLAUDE.md —
    // defense in depth, since this repo's CLAUDE.md is irrelevant to a decision call and only adds tokens.
    // Note: user-level SessionStart hooks (e.g. a terse-response-style hook) still fire regardless of cwd —
    // confirmed by a real call. They don't corrupt the response as long as the user prompt is directive
    // ("respond now with X"); a prompt inviting the model to describe its own context (e.g. "confirm you
    // understood") can surface that hook text instead of the task — a prompt-design pitfall, not a cwd bug.
    execFile('claude', buildCliArgs(promptPair, config), { cwd: os.tmpdir(), timeout: config.claudeTimeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`claude cli failed: ${err.message}`));
      let wrapper;
      try {
        wrapper = JSON.parse(stdout);
      } catch (parseErr) {
        return reject(new Error(`claude cli returned non-JSON output: ${parseErr.message}`));
      }
      if (wrapper.is_error) return reject(new Error(`claude cli reported an error: ${wrapper.result}`));
      resolve(stripMarkdownFences(wrapper.result));
    });
  });
}

async function decide(input, config, deps = { callClaudeCli }) {
  const promptPair = buildDecisionPrompt(input);
  let rawText;
  try {
    rawText = await deps.callClaudeCli(promptPair, config);
  } catch (err) {
    return { decisions: [], positionActions: [], setupToggles: [], marketNote: '', plainNote: null, fallback: true, error: err.message };
  }
  return parseDecisionResponse(rawText, { candidates: input.candidates, openPositions: input.openPositions, setupNames: input.setupNames });
}

module.exports = { buildDecisionPrompt, parseDecisionResponse, buildCliArgs, stripMarkdownFences, callClaudeCli, decide };
