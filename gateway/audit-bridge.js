'use strict';
/**
 * Audit → bus bridge. Translates existing audit-log entries into contract events
 * so the built modules (which only write to the audit log) join the bus without edits.
 */

const log = require('./audit-log');
const sessions = require('./session-store');
const bus = require('./bus');

const WALLET_DECISION = {
  CHECKOUT_EXECUTED: 'auto_allow',
  WALLET_APPROVAL_REQUIRED: 'needs_approval',
  WALLET_AUTO_DENIED: 'auto_deny',
  WALLET_SANDBOX_BLOCKED: 'sandbox_blocked',
};

const APPROVAL_OUTCOME = {
  APPROVED: 'approved',
  DENIED: 'denied',
  IDEMPOTENCY_GUARD: 'noop_reclick',
  REVALIDATION_REQUIRED: 'reapproval_required',
  ACTION_FAILED: 'failed',
};

const _lastRoute = new Map();
let _started = false;

function sessionView(id) {
  if (!sessions.has(id)) return {};
  const s = sessions.get(id);
  return { route: s.route, sandboxed: s.sandboxed, riskScore: s.riskScore };
}

function translate(entry) {
  const { type, sessionId: sid, meta = {} } = entry;
  const view = sessionView(sid);

  if (type === 'TOOL_CALL') {
    bus.publish('ingress.accepted', sid, { method: meta.method, path: meta.path, ...view });
    const s = sessions.has(sid) ? sessions.get(sid) : null;
    bus.publish('session.updated', sid, {
      window_requests: s ? s.requestLog.length : 0,
      active_sessions: sessions.all().length,
      ...view,
    });
  } else if (type === 'RISK') {
    // `score`/`reasons` are the router's final values; `deterministic`/`det_reasons` are the behaviour scorer's own.
    bus.publish('risk.scored', sid, {
      source: 'router', score: meta.score, reasons: meta.reasons || [], route: meta.route,
      deterministic: meta.deterministic ?? meta.score, det_reasons: meta.detReasons || meta.reasons || [],
      components: meta.components, raisedBy: meta.raisedBy || [], ...view,
    });
    const prev = _lastRoute.get(sid) || null;
    if (prev !== meta.route) {
      _lastRoute.set(sid, meta.route);
      bus.publish('route.decided', sid, { from: prev, to: meta.route, score: meta.score });
    }
  } else if (type === 'BLOCK_APPLIED') {
    bus.publish('route.decided', sid, { from: _lastRoute.get(sid) || null, to: 'BLOCKED', score: null });
    _lastRoute.set(sid, 'BLOCKED');
  } else if (WALLET_DECISION[type]) {
    bus.publish('wallet.checked', sid, { decision: WALLET_DECISION[type], amount: meta.amount, item: meta.item, ...view });
  } else if (type === 'UNTRUSTED_INPUT_IGNORED') {
    // Justification text is never followed; it is only handed to the judgment scorer as data.
    bus.publish('wallet.checked', sid, { decision: 'justification_ignored', justification: meta.injectedReason, ...view });
  } else if (type === 'APPROVAL_PENDING') {
    bus.publish('approval.requested', sid, { hash: meta.hash, action: meta.action, actionData: meta.actionData });
  } else if (APPROVAL_OUTCOME[type]) {
    bus.publish('approval.resolved', sid, { hash: meta.hash, outcome: APPROVAL_OUTCOME[type], action: meta.action });
  }

  bus.publish('audit.appended', sid, { seq: entry.seq, type });
}

function start() {
  if (_started) return;
  _started = true;
  log.on('entry', (entry) => {
    try { translate(entry); } catch (err) { console.error('[bridge]', err.message); }
  });
}

module.exports = { start, translate };
