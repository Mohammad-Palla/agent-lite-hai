'use strict';
/**
 * Signed-agent verification (tier 1). Pure: headers in, verdict out.
 * Originally written inline in server.js by Dev B; extracted so the identity classifier owns the tier decision.
 *
 *   x-agent-signature: t=<unix_ms>,s=<hmac-sha256-hex>
 *   x-agent-pubkey-id: <key id>
 *   payload signed:    "<sessionId>:<pubkeyId>:<timestamp>"
 *
 * LIMITATION: this is a shared-secret HMAC, so anyone holding AGENT_SIGNING_KEY can sign as any agent.
 * The default key below is a demo value checked into source; set AGENT_SIGNING_KEY in .env.
 * A real deployment would use asymmetric signatures (e.g. Web Bot Auth / RFC 9421).
 */

const crypto = require('crypto');

const DEMO_KEY = 'demo-private-key-for-hackathon-2026';
const FRESHNESS_MS = 60_000; // replay/freshness window

const signingKey = () => process.env.AGENT_SIGNING_KEY || DEMO_KEY;
const usingDemoKey = () => !process.env.AGENT_SIGNING_KEY;

/** @returns null when no signature header, else { valid, reason?, pubkeyId?, timestamp? } */
function verify(headers, sessionId, now = Date.now()) {
  const header = headers['x-agent-signature'];
  const pubkeyId = headers['x-agent-pubkey-id'] || 'agent-quarantine-attacker-v1';
  if (!header) return null;

  const m = String(header).match(/^t=(\d+),s=([a-f0-9]{64})$/);
  if (!m) return { valid: false, reason: 'malformed_signature_format' };

  const timestamp = parseInt(m[1], 10);
  if (Math.abs(now - timestamp) > FRESHNESS_MS) return { valid: false, reason: 'timestamp_expired_or_drift' };

  const expected = crypto.createHmac('sha256', signingKey()).update(`${sessionId}:${pubkeyId}:${timestamp}`).digest();
  const given = Buffer.from(m[2], 'hex');
  // Constant-time comparison (the original used ===)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
    ? { valid: true, pubkeyId, timestamp }
    : { valid: false, reason: 'hmac_mismatch' };
}

module.exports = { verify, usingDemoKey, FRESHNESS_MS };
