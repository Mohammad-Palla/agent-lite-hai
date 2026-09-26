'use strict';
/**
 * Risk Scorer — behavioral, deterministic.
 * Signals: request cadence, sequence shape, search-to-checkout ratio,
 * concurrency, amount vs. budget, prompt-injection strings.
 *
 * NOT: ip, user-agent, declared purpose strings (treated as untrusted).
 */

const { fmt } = require('./currency');

const WEIGHTS = {
  burstRate: 0.30,          // requests/second in window
  noSearchCheckout: 0.25,   // checkout with no search/compare
  highConcurrency: 0.20,    // multiple in-flight checkouts
  overBudget: 0.15,         // amount exceeds wallet policy
  sequenceAnomaly: 0.10,    // weird path sequence (checkout before product)
};

const THRESHOLDS = {
  allow:      0.40,
  quarantine: 0.70,
  // above 0.70 → propose BLOCK
};

const WINDOW_SEC = 10;
const BURST_HIGH = 5;   // >5 req/sec in window = high burst

/**
 * Compute a risk score [0, 1] for the session.
 * Returns { score, reasons[] }
 */
function scoreSession(session) {
  const reasons = [];
  let score = 0;

  // --- Burst rate ---
  const windowReqs = session.requestLog.length;
  if (windowReqs >= 8) {
    score += WEIGHTS.burstRate;
    reasons.push(`heavy-burst:${windowReqs}reqs`);
  } else if (windowReqs >= 4) {
    score += WEIGHTS.burstRate * 0.6;
    reasons.push(`burst:${windowReqs}reqs`);
  }

  // --- Search-to-checkout sequence & counters ---
  const hasSearch = session.searchCount > 0;
  const hasCompare = session.compareCount > 0;
  const hasCheckout = session.checkoutAttempts > 0;

  // --- Repeated checkout spam without search ---
  if (session.checkoutAttempts >= 3 && !hasSearch) {
    score += 0.15;
    reasons.push(`checkout-hammering:${session.checkoutAttempts}`);
  }

  if (hasCheckout && !hasSearch && !hasCompare) {
    score += WEIGHTS.noSearchCheckout;
    reasons.push('no-search-before-checkout');
  } else if (hasCheckout && !hasSearch) {
    score += WEIGHTS.noSearchCheckout * 0.5;
    reasons.push('no-search');
  }

  // --- Concurrency ---
  if (session.concurrentCheckouts > 2) {
    score += WEIGHTS.highConcurrency;
    reasons.push(`concurrent-checkout:${session.concurrentCheckouts}`);
  } else if (session.concurrentCheckouts > 1) {
    score += WEIGHTS.highConcurrency * 0.5;
    reasons.push('concurrent-checkout:2');
  }

  // --- Budget overrun (wallet firewall signal, also a risk signal) ---
  if (session._lastCheckoutAmount > session.walletTxLimit) {
    score += WEIGHTS.overBudget;
    reasons.push(`over-tx-limit:${fmt(session._lastCheckoutAmount)}`);
  }

  // --- Sequence anomaly: checkout before ever viewing a product ---
  const paths = session.requestLog.map(r => r.path);
  const firstCheckoutIdx = paths.findIndex(p => p.includes('/checkout'));
  const firstProductIdx = paths.findIndex(p => p.includes('/product/'));
  if (firstCheckoutIdx !== -1 && firstProductIdx === -1) {
    score += WEIGHTS.sequenceAnomaly;
    reasons.push('checkout-without-product-view');
  }

  // Cap at 1.0
  score = Math.min(1.0, score);

  return { score, reasons };
}

/**
 * Determine routing decision from score.
 * Returns 'ALLOW' | 'QUARANTINE' | 'BLOCK_PROPOSED'
 */
function routeFromScore(score) {
  if (score < THRESHOLDS.allow) return 'ALLOW';
  if (score < THRESHOLDS.quarantine) return 'QUARANTINE';
  return 'BLOCK_PROPOSED';
}

module.exports = { scoreSession, routeFromScore, THRESHOLDS };
