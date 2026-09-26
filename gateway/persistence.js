'use strict';
/**
 * Audit-log persistence (Neon Postgres). Write-behind and best-effort:
 * the in-memory log stays the source of truth for the live UI; a slow or dead
 * database can never block or fail a gateway request.
 *
 * Rows are keyed (run_id, seq) because seq restarts on every gateway boot.
 * Approval records are the APPROVAL_PENDING / APPROVED / DENIED / IDEMPOTENCY_GUARD /
 * REVALIDATION_REQUIRED rows of this same table (see approvals()).
 */

const { randomUUID } = require('crypto');

const FLUSH_MS = 300;
const BATCH_MAX = 100;
const QUEUE_MAX = 5000;
const CONNECT_TIMEOUT_MS = 8000;

const APPROVAL_TYPES = ['APPROVAL_PENDING', 'APPROVED', 'DENIED', 'IDEMPOTENCY_GUARD', 'REVALIDATION_REQUIRED', 'ACTION_FAILED'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  run_id     text        NOT NULL,
  seq        integer     NOT NULL,
  ts         timestamptz NOT NULL,
  type       text        NOT NULL,
  session_id text,
  message    text,
  meta       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS audit_log_session_idx ON audit_log (session_id, ts);
CREATE INDEX IF NOT EXISTS audit_log_type_idx    ON audit_log (type, ts);
`;

const state = {
  enabled: false,
  ready: false,
  runId: randomUUID(),
  queue: [],
  persisted: 0,
  failures: 0,
  dropped: 0,
  lastError: null,
  lastFlushMs: null,
};

let pool = null;
let timer = null;
let flushing = false;

function connectionUrl() {
  // Node's pg treats sslmode=require as verify-full; say so explicitly to keep behaviour stable.
  const u = process.env.DATABASE_URL;
  return u ? u.replace('sslmode=require', 'sslmode=verify-full') : null;
}

function fail(err) {
  state.failures++;
  state.lastError = { message: String(err && err.message || err).replace(process.env.DATABASE_URL || '§', '<url>'), ts: Date.now() };
}

/** Start persistence for an AuditLog emitter. No-op without DATABASE_URL or with PERSIST_AUDIT=off. */
async function start(auditLog, { poolFactory } = {}) {
  const url = connectionUrl();
  if (!url || process.env.PERSIST_AUDIT === 'off') return { enabled: false };

  state.enabled = true;
  try {
    const { Pool } = require('pg');
    pool = poolFactory ? poolFactory() : new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, idleTimeoutMillis: 30_000 });
    pool.on('error', fail); // idle-client errors must not crash the process
    await pool.query(SCHEMA);
    state.ready = true;
  } catch (err) {
    fail(err); // stay enabled: flush() keeps retrying schema/connection on later ticks
  }

  auditLog.on('entry', enqueue);
  // Entries written before start() (e.g. the boot message) are queued too.
  for (const e of auditLog.all()) enqueue(e);

  timer = setInterval(() => { flush().catch(fail); }, FLUSH_MS);
  timer.unref();
  return { enabled: true, ready: state.ready, runId: state.runId };
}

function enqueue(entry) {
  if (!state.enabled) return;
  if (state.queue.length >= QUEUE_MAX) { state.queue.shift(); state.dropped++; }
  state.queue.push(entry);
}

async function flush() {
  if (!state.enabled || !pool || flushing || !state.queue.length) return;
  flushing = true;
  const t0 = Date.now();
  try {
    if (!state.ready) { await pool.query(SCHEMA); state.ready = true; }
    while (state.queue.length) {
      const batch = state.queue.slice(0, BATCH_MAX);
      const params = [];
      const values = batch.map((e, i) => {
        const o = i * 7;
        params.push(state.runId, e.seq, e.ts, e.type, e.sessionId == null ? null : String(e.sessionId), e.message == null ? null : String(e.message), JSON.stringify(e.meta || {}));
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7}::jsonb)`;
      });
      await pool.query(`INSERT INTO audit_log (run_id,seq,ts,type,session_id,message,meta) VALUES ${values.join(',')} ON CONFLICT (run_id,seq) DO NOTHING`, params);
      state.queue.splice(0, batch.length); // only drop from the queue after the insert succeeded
      state.persisted += batch.length;
    }
    state.lastFlushMs = Date.now() - t0;
  } catch (err) {
    fail(err); // rows stay queued and retry on the next tick
  } finally {
    flushing = false;
  }
}

/** Best-effort drain on shutdown. */
async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  try { await flush(); } catch (_) { /* already counted */ }
  if (pool) { try { await pool.end(); } catch (_) { /* ignore */ } }
  pool = null;
}

async function query({ sessionId, type, types, runId, limit = 100 } = {}) {
  if (!pool || !state.ready) throw new Error('persistence_unavailable');
  const where = [];
  const p = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (sessionId) add('session_id = ?', sessionId);
  if (type) add('type = ?', type);
  if (types && types.length) add('type = ANY(?)', types);
  if (runId) add('run_id = ?', runId);
  p.push(Math.min(Math.max(1, limit), 500));
  const sql = `SELECT run_id, seq, ts, type, session_id AS "sessionId", message, meta FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, seq DESC LIMIT $${p.length}`;
  const r = await pool.query(sql, p);
  return r.rows;
}

const approvals = (opts = {}) => query({ ...opts, types: APPROVAL_TYPES });

function stats() {
  return {
    enabled: state.enabled,
    ready: state.ready,
    run_id: state.runId,
    persisted_rows: state.persisted,
    queue_depth: state.queue.length,
    failures: state.failures,
    dropped: state.dropped,
    last_flush_ms: state.lastFlushMs,
    last_error: state.lastError,
  };
}

module.exports = { start, stop, flush, query, approvals, stats, APPROVAL_TYPES };
