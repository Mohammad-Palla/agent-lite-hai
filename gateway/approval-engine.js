'use strict';
/**
 * Approval Engine — manages human-gated irreversible actions.
 *
 * Hardening rules implemented:
 * 1. Approval binds to one exact action via hash(sessionId, action, timestamp)
 * 2. Idempotent: double-click/retry executes exactly once
 * 3. Re-validates state at commit time, requires re-approval if stale
 * 4. All events recorded in audit log
 */

const crypto = require('crypto');
const log = require('./audit-log');
const sessions = require('./session-store');

// Applied approvals: hash → { result, appliedAt }
const _applied = new Map();

// Pending approvals: hash → { sessionId, action, actionData, ts, riskSnapshot }
const _pending = new Map();

/**
 * Create a new approval request.
 * Returns { hash, pendingEntry }
 */
function createApproval(sessionId, action, actionData, riskSnapshot) {
  const ts = Date.now();
  const hash = crypto
    .createHash('sha256')
    .update(`${sessionId}|${action}|${JSON.stringify(actionData)}|${ts}`)
    .digest('hex')
    .slice(0, 16);

  const pendingEntry = { hash, sessionId, action, actionData, ts, riskSnapshot };
  _pending.set(hash, pendingEntry);

  log.append('APPROVAL_PENDING', sessionId,
    `[APPROVAL PENDING] ${action} ${JSON.stringify(actionData)} hash=${hash}`,
    { hash, action, actionData, riskSnapshot }
  );

  return { hash, pendingEntry };
}

/**
 * Apply a pending approval (human clicked APPROVE).
 * Idempotent — repeated calls return the original result without re-executing.
 * Re-validates session state before applying.
 *
 * @returns { ok, result, reason }
 */
function applyApproval(hash, actFn) {
  // Idempotency guard
  if (_applied.has(hash)) {
    const prev = _applied.get(hash);
    log.append('IDEMPOTENCY_GUARD', prev.sessionId,
      `[IDEMPOTENCY] approval ${hash} already applied — no-op`,
      { hash, prev }
    );
    return { ok: true, result: prev.result, idempotent: true };
  }

  const pending = _pending.get(hash);
  if (!pending) {
    return { ok: false, reason: 'approval_not_found', hash };
  }

  // The session must still exist. sessions.get() would silently create a blank one (risk 0), which then
  // "drifts" from the risk the Judge was shown and throws the approval away with no explanation. Fail closed instead.
  if (!sessions.has(pending.sessionId)) {
    log.append('REVALIDATION_REQUIRED', pending.sessionId,
      `[REVALIDATION] session-${pending.sessionId} is no longer in memory — approval cancelled (nothing was executed)`,
      { hash, reason: 'session_expired' }
    );
    _pending.delete(hash);
    return { ok: false, reason: 'session_expired', hash };
  }

  // Re-validate session state (hardening rule #3)
  const session = sessions.get(pending.sessionId);
  const scoreDrift = Math.abs(session.riskScore - pending.riskSnapshot.score);
  if (scoreDrift > 0.25) {
    log.append('REVALIDATION_REQUIRED', pending.sessionId,
      `[REVALIDATION] score drifted ${scoreDrift.toFixed(2)} since approval shown — require re-approval`,
      { hash, oldScore: pending.riskSnapshot.score, newScore: session.riskScore }
    );
    _pending.delete(hash);
    return { ok: false, reason: 'state_changed_reapproval_required', scoreDrift };
  }

  // Execute the action
  let result;
  try {
    result = actFn(pending);
  } catch (err) {
    log.append('ACTION_FAILED', pending.sessionId,
      `[ACTION FAILED] ${pending.action} hash=${hash}: ${err.message}`, { hash }
    );
    return { ok: false, reason: 'action_threw', error: err.message };
  }

  // Record as applied (idempotency record)
  _applied.set(hash, { ...pending, result, appliedAt: Date.now() });
  _pending.delete(hash);

  log.append('APPROVED', pending.sessionId,
    `[APPROVED] by human-1 @ ${new Date().toISOString().slice(11, 19)} action=${pending.action} hash=${hash}`,
    { hash, action: pending.action, actionData: pending.actionData, result }
  );

  return { ok: true, result };
}

/**
 * Deny a pending approval (human clicked DENY).
 */
function denyApproval(hash, by = 'human-1', why = '') {
  const pending = _pending.get(hash);
  if (!pending) return { ok: false, reason: 'not_found' };

  _pending.delete(hash);
  // Denied decisions are NOT replayable
  _applied.set(hash, { ...pending, result: 'denied', by, why, appliedAt: Date.now() });

  log.append('DENIED', pending.sessionId,
    `[DENIED] by ${by} @ ${new Date().toISOString().slice(11, 19)} action=${pending.action} hash=${hash}${why ? ` (${why})` : ''}`,
    { hash }
  );

  return { ok: true };
}

function getPending(hash) { return _pending.get(hash); }
function getAllPending() { return [..._pending.values()]; }
function isApplied(hash) { return _applied.has(hash); }
function getApplied(hash) { return _applied.get(hash); }

module.exports = { createApproval, applyApproval, denyApproval, getPending, getAllPending, isApplied, getApplied };
