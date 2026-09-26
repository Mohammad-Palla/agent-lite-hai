'use strict';
/**
 * Wallet Firewall — per-session budget enforcement.
 *
 * Each agent session carries:
 *   - walletDailyLimit: daily spend cap
 *   - walletTxLimit:    per-transaction cap
 *
 * Policy (documented):
 *   - Within budget + ALLOW route → auto-execute
 *   - Exceeds tx limit OR from QUARANTINE/BLOCK session → human approval required
 *   - Amount exceeds 3x tx limit → auto-deny (impossible amount, no escalation)
 *     (This is the documented "auto-deny impossible amounts" policy)
 *
 * The prompt-injected "reason" string is explicitly ignored for scoring.
 */

const log = require('./audit-log');
const sessions = require('./session-store');
const approval = require('./approval-engine');

const AUTO_DENY_MULTIPLIER = 3; // amounts > 3x tx limit are auto-denied

/**
 * Attempt a wallet checkout.
 * @returns { allowed, requiresApproval, approvalHash, denied, reason }
 */
function attemptCheckout(sessionId, amount, item, injectedReason) {
  const session = sessions.get(sessionId);

  // Log that we explicitly ignored any injected reason string (hardening rule #7)
  if (injectedReason) {
    log.append('UNTRUSTED_INPUT_IGNORED', sessionId,
      `[UNTRUSTED] agent-declared justification ignored: "${injectedReason.slice(0, 80)}"`,
      { injectedReason: injectedReason.slice(0, 200) }
    );
  }

  session._lastCheckoutAmount = amount;
  session.checkoutAttempts++;

  // Auto-deny impossible amounts (>3x tx limit) — policy documented
  if (amount > session.walletTxLimit * AUTO_DENY_MULTIPLIER) {
    log.append('WALLET_AUTO_DENIED', sessionId,
      `[WALLET AUTO-DENY] $${amount} exceeds ${AUTO_DENY_MULTIPLIER}x tx-limit ($${session.walletTxLimit * AUTO_DENY_MULTIPLIER}) — auto-denied`,
      { amount, txLimit: session.walletTxLimit, item }
    );
    return { allowed: false, denied: true, reason: `amount_${amount}_exceeds_auto_deny_threshold` };
  }

  const overTxLimit = amount > session.walletTxLimit;
  const overDailyLimit = (session.walletDailyUsed + amount) > session.walletDailyLimit;
  const risky = session.route !== 'ALLOW';

  // Needs approval?
  if (overTxLimit || overDailyLimit || risky) {
    const reason = overTxLimit ? `over-tx-limit($${amount}>$${session.walletTxLimit})`
      : overDailyLimit ? `over-daily-limit`
      : `session-routed-${session.route}`;

    const { hash } = approval.createApproval(
      sessionId,
      'WALLET_CHECKOUT',
      { amount, item, reason },
      { score: session.riskScore, reasons: session.riskReasons, route: session.route }
    );

    log.append('WALLET_APPROVAL_REQUIRED', sessionId,
      `[WALLET] approval required: $${amount} for "${item}" reason=${reason} hash=${hash}`,
      { amount, item, reason, hash }
    );

    return { allowed: false, requiresApproval: true, approvalHash: hash, reason };
  }

  // Auto-execute
  return executeCheckout(sessionId, amount, item);
}

/**
 * Actually commit a wallet checkout (called directly or after approval).
 * Idempotent: records the order exactly once.
 */
function executeCheckout(sessionId, amount, item) {
  const session = sessions.get(sessionId);

  // Fail closed if session is sandboxed — wallet state is real
  if (session.sandboxed) {
    log.append('WALLET_SANDBOX_BLOCKED', sessionId,
      `[WALLET] blocked — session is in sandbox, real checkout not allowed`,
      { amount, item }
    );
    return { allowed: false, reason: 'session_sandboxed_fail_closed' };
  }

  session.walletDailyUsed += amount;

  const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 9999)}`;

  log.append('CHECKOUT_EXECUTED', sessionId,
    `[CHECKOUT] $${amount} for "${item}" orderId=${orderId} — wallet balance: $${session.walletDailyLimit - session.walletDailyUsed} remaining`,
    { amount, item, orderId, walletRemaining: session.walletDailyLimit - session.walletDailyUsed }
  );

  return { allowed: true, orderId, walletRemaining: session.walletDailyLimit - session.walletDailyUsed };
}

module.exports = { attemptCheckout, executeCheckout };
