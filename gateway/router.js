'use strict';
/**
 * Risk router — combines the deterministic score, the judgment score and identity
 * into one final score. Raise-only: nothing here can lower the deterministic score
 * (trust adjustment for verified tier 1 lands with signature verification).
 *
 *   base  = max(deterministic, judgment)         judgment only counts while fresh
 *   base  = max(base, 0.5) if injection flagged  (floor + flag)
 *   final = min(1, base + identity bump)         tier 5: +0.10, tier 4: +0.05, else 0
 *
 * Identity is a nudge, not a floor: undeclared scripted clients (tier 5) must still
 * reach the store when their behaviour is clean.
 */

const { INJECTION_FLOOR } = require('./judgment');
const { routeFromScore } = require('./risk-scorer');

const JUDGMENT_TTL_MS = 30_000;
const IDENTITY_BUMP = { 5: 0.10, 4: 0.05 };
const MAX_SESSIONS = 2000;

const _inputs = new Map(); // sessionId → { identity, judgment }

function slot(id) {
  let s = _inputs.get(id);
  if (!s) {
    s = { identity: null, judgment: null };
    _inputs.set(id, s);
    if (_inputs.size > MAX_SESSIONS) _inputs.delete(_inputs.keys().next().value);
  }
  return s;
}

/** Feed a bus event (identity.classified or a judgment risk.scored). */
function observe(event) {
  if (event.type === 'identity.classified') {
    const s = slot(event.session_id);
    // Keep the strongest identity evidence seen: a verified tier-2 upgrade must not be overwritten.
    if (!s.identity || event.payload.verified || !s.identity.verified) {
      s.identity = { tier: event.payload.tier, label: event.payload.label, verified: !!event.payload.verified };
    }
  } else if (event.type === 'risk.scored' && event.payload.source === 'judgment') {
    slot(event.session_id).judgment = {
      score: event.payload.score, injection: !!event.payload.injection, ts: event.ts,
    };
  }
}

/**
 * Decide the final score and route for a session. Pure given the observed inputs.
 * @returns { score, route, reasons[], components, raisedBy[] }
 */
function decide(sessionId, deterministic, reasons = [], now = Date.now()) {
  const s = _inputs.get(sessionId) || {};
  const out = [...reasons];
  const raisedBy = [];
  let score = deterministic;

  const j = s.judgment && now - s.judgment.ts <= JUDGMENT_TTL_MS ? s.judgment : null;
  if (j && j.score > score) { score = j.score; raisedBy.push('judgment'); out.push(`judgment:${j.score.toFixed(2)}`); }
  if (j && j.injection) {
    if (score < INJECTION_FLOOR) { score = INJECTION_FLOOR; raisedBy.push('injection_floor'); }
    out.push('injection_flagged');
  }

  const tier = s.identity ? s.identity.tier : null;
  const bump = IDENTITY_BUMP[tier] || 0;
  if (bump) { score += bump; raisedBy.push('identity'); out.push(`identity-tier-${tier}`); }

  score = Math.min(1, Math.max(deterministic, score)); // raise-only guard
  return {
    score,
    route: routeFromScore(score),
    reasons: out,
    raisedBy,
    components: { deterministic, judgment: j ? j.score : null, identity_tier: tier, identity_bump: bump },
  };
}

function reset() { _inputs.clear(); }

module.exports = { observe, decide, reset, JUDGMENT_TTL_MS, IDENTITY_BUMP };
