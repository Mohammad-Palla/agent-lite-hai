'use strict';
/**
 * Audit Log — immutable, append-only, queryable.
 * All scoring events, quarantine decisions, approvals, and actions write here.
 * The UI terminal panel reads from this, NOT a separate mocked feed.
 */

const { EventEmitter } = require('events');

class AuditLog extends EventEmitter {
  constructor() {
    super();
    this._entries = [];
    this._seq = 0;
  }

  /**
   * Append an entry and emit it for live subscribers.
   * @param {string} type  e.g. 'TOOL_CALL', 'RISK', 'SANDBOX', 'APPROVAL_PENDING', etc.
   * @param {string} sessionId
   * @param {string} message  Human-readable log line
   * @param {object} [meta]   Extra structured data
   * @returns {object} The log entry
   */
  append(type, sessionId, message, meta = {}) {
    const entry = {
      seq: ++this._seq,
      ts: new Date().toISOString(),
      type,
      sessionId,
      message,
      meta,
    };
    this._entries.push(entry);
    this.emit('entry', entry);
    return entry;
  }

  /** Query entries, optionally filtered by sessionId and/or type array */
  query({ sessionId, types, since, limit } = {}) {
    let result = this._entries;
    if (sessionId) result = result.filter(e => e.sessionId === sessionId);
    if (types && types.length) result = result.filter(e => types.includes(e.type));
    if (since) result = result.filter(e => e.seq > since);
    if (limit) result = result.slice(-limit);
    return result;
  }

  all() { return [...this._entries]; }

  last(n = 50) { return this._entries.slice(-n); }
}

// Singleton
const log = new AuditLog();
module.exports = log;
