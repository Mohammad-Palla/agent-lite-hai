'use strict';
/**
 * Shared contract (owned by Dev A — changes need Dev B's OK after the 0:30 freeze).
 *
 * Event envelope:  { trace_id, session_id, ts, type, payload }
 * Module shape:    { name, subscribes[], handle(event, ctx), stats(), health() }
 * Stats shape:     { counters, latency: {p50, p95}, last_error, custom }
 */

const { randomUUID } = require('crypto');

// Canonical event order:
// ingress.accepted → session.updated → signals.extracted → identity.classified →
// risk.scored → route.decided → wallet.checked → approval.requested / approval.resolved → audit.appended
const EVENT_TYPES = Object.freeze([
  'ingress.accepted',
  'ingress.rejected',
  'session.updated',
  'signals.extracted',
  'identity.classified',
  'risk.scored',
  'route.decided',
  'wallet.checked',
  'approval.requested',
  'approval.resolved',
  'audit.appended',
]);

function makeEvent(type, sessionId, payload = {}, traceId) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type: ${type}`);
  return {
    trace_id: traceId || randomUUID(),
    session_id: sessionId || 'unknown',
    ts: Date.now(),
    type,
    payload,
  };
}

/** Stats helper each module owns: counters, bounded latency samples, last error, custom values. */
function createStats() {
  const counters = {};
  const samples = [];
  const MAX_SAMPLES = 500;
  let lastError = null;
  const custom = {};

  return {
    inc(name, n = 1) { counters[name] = (counters[name] || 0) + n; },
    set(name, value) { custom[name] = value; },
    latency(ms) { samples.push(ms); if (samples.length > MAX_SAMPLES) samples.shift(); },
    error(err) { lastError = { message: String(err && err.message || err), ts: Date.now() }; this.inc('errors'); },
    snapshot() {
      const sorted = [...samples].sort((a, b) => a - b);
      const pct = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3) : null;
      return { counters: { ...counters }, latency: { p50: pct(0.5), p95: pct(0.95) }, last_error: lastError, custom: { ...custom } };
    },
    lastErrorTs() { return lastError ? lastError.ts : 0; },
    reset() { for (const k of Object.keys(counters)) delete counters[k]; for (const k of Object.keys(custom)) delete custom[k]; samples.length = 0; lastError = null; },
  };
}

const DEGRADED_WINDOW_MS = 30_000;

/**
 * Build a contract-compliant module. `onEvent(event, stats, ctx)` does the work.
 * The module never imports another module; it only sees events.
 */
function defineModule({ name, subscribes = [], onEvent, custom, healthCheck }) {
  const st = createStats();
  let down = false; // fault switch (wired to the dashboard later)
  return {
    name,
    subscribes,
    handle(event, ctx = {}) {
      if (down) { st.inc('dropped_faulted'); return null; }
      const t0 = process.hrtime.bigint();
      try {
        return onEvent ? onEvent(event, st, ctx) : null;
      } catch (err) {
        st.error(err);
        return null;
      } finally {
        st.latency(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    },
    stats() {
      const snap = st.snapshot();
      if (custom) Object.assign(snap.custom, custom());
      return snap;
    },
    health() {
      if (down) return 'down';
      if (healthCheck && healthCheck() === 'degraded') return 'degraded'; // module-specific signal (e.g. persistence backlog)
      return Date.now() - st.lastErrorTs() < DEGRADED_WINDOW_MS ? 'degraded' : 'ok';
    },
    rawCounters() { return st.snapshot().counters; }, // for custom() derived values (avoids stats() recursion)
    setFault(v) { down = !!v; },
    reset() { st.reset(); },
  };
}

function validateModule(m) {
  for (const k of ['name', 'handle', 'stats', 'health']) {
    if (!m || !(k in m)) throw new Error(`module missing "${k}"`);
  }
  if (typeof m.handle !== 'function' || typeof m.stats !== 'function' || typeof m.health !== 'function') {
    throw new Error(`module "${m.name}" violates contract`);
  }
  return m;
}

module.exports = { EVENT_TYPES, makeEvent, createStats, defineModule, validateModule };
