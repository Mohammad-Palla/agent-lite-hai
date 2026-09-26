'use strict';
/**
 * Session Store — tracks per-session behavioral state for risk scoring.
 * Keyed by sessionId. Mutable rolling window, not an audit trail.
 */

const { randomUUID } = require('crypto');
const { WALLET_TX_LIMIT, WALLET_DAILY_LIMIT } = require('./currency');

const WINDOW_MS = 10_000;   // 10-second rolling window for burst detection
const MAX_SESSIONS = 2000;

class SessionStore {
  constructor() {
    this._sessions = new Map();
  }

  /** Get or create a session record */
  get(sessionId) {
    if (!this._sessions.has(sessionId)) {
      const s = {
        id: sessionId,
        createdAt: Date.now(),
        route: 'ALLOW',           // ALLOW | QUARANTINE | BLOCK_PROPOSED
        requestLog: [],           // { ts, path, method }
        searchCount: 0,
        compareCount: 0,
        checkoutAttempts: 0,
        lastCheckoutTs: null,
        concurrentCheckouts: 0,
        riskScore: 0,
        riskReasons: [],
        walletDailyUsed: 0,
        walletDailyLimit: WALLET_DAILY_LIMIT,
        walletTxLimit: WALLET_TX_LIMIT,
        blockRuleApplied: false,
        blockRuleHash: null,
        pendingApprovals: new Map(),  // hash → { action, ts, applied }
        sandboxed: false,
        agentType: 'unknown',      // set by agent header
        // For re-validation: snapshot of state at last approval display
        approvalSnapshotScore: null,
        lastActivityTs: Date.now(),
        status: 'active',          // 'active' | 'completed' | 'blocked' | 'denied'
        completedAt: null,
      };
      this._sessions.set(sessionId, s);
      // Simple LRU eviction
      if (this._sessions.size > MAX_SESSIONS) {
        const oldest = this._sessions.keys().next().value;
        this._sessions.delete(oldest);
      }
    }
    return this._sessions.get(sessionId);
  }

  has(sessionId) { return this._sessions.has(sessionId); }

  all() { return [...this._sessions.values()]; }

  delete(sessionId) { return this._sessions.delete(sessionId); }

  clear() { this._sessions.clear(); }

  /** Record a request event and return updated session */
  recordRequest(sessionId, method, path) {
    const s = this.get(sessionId);
    const now = Date.now();
    s.lastActivityTs = now;
    if (s.status === 'completed' && method !== 'GET' && !path.includes('/session/complete')) {
      s.status = 'active';
    }
    s.requestLog.push({ ts: now, method, path });
    // Prune old entries outside window
    const cutoff = now - WINDOW_MS;
    s.requestLog = s.requestLog.filter(r => r.ts >= cutoff);
    return s;
  }
}

const store = new SessionStore();
module.exports = store;
