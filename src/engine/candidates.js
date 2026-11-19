'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildCandidateId(tsSeconds, coin, setup) {
  const d = new Date(tsSeconds * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  return `c_${yyyy}${mm}${dd}_${hh}_${coin}_${setup}`;
}

function attachContext(candidate, indicators, i) {
  return {
    ...candidate,
    context: { rsi14: indicators.rsi14[i], adx4h: indicators.adx14.adx[i] },
  };
}

module.exports = { buildCandidateId, attachContext };
