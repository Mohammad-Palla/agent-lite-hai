'use strict';
/**
 * Gateway Server — main entry point.
 * 
 * Responsibilities:
 *  a. Score each session's behavior live
 *  b. Route by score: ALLOW / QUARANTINE (sandbox) / BLOCK_PROPOSED
 *  c. Wallet firewall on every /checkout
 *  d. Approval gating for irreversible actions
 *  e. Verify block rule by re-sending request as that session
 *  f. Fail closed on errors
 *  g. Rate limit its own endpoints
 *  h. Input validation
 *
 * Architecture:
 *   :3001  Gateway API (proxies or blocks storefront requests)
 *   :3002  Admin API (approve/deny, status, log feed)
 *   WS     Live log streaming to UI
 */

require('./env').loadEnv(); // .env before anything reads process.env

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { fork } = require('child_process');
const { WebSocketServer } = require('ws');

const log = require('./audit-log');
const sessions = require('./session-store');
const { scoreSession, routeFromScore, THRESHOLDS } = require('./risk-scorer');
const approval = require('./approval-engine');
const wallet = require('./wallet-firewall');
const bus = require('./bus');
const registry = require('./registry');
const auditBridge = require('./audit-bridge');
const signals = require('./signals');
const signature = require('./signature');
const { WALLET_TX_LIMIT, WALLET_DAILY_LIMIT, CODE: CURRENCY_CODE } = require('./currency');
const router = require('./router');
const persistence = require('./persistence');
const moduleSet = require('./modules');

// The UI reads session.identityTier / identityLabel; the identity classifier is the single source of truth.
bus.subscribe('identity.classified', (e) => {
  if (!sessions.has(e.session_id)) return;
  const sess = sessions.get(e.session_id);
  if (e.payload.verified || !sess.identityVerified) {
    sess.identityTier = e.payload.tier ?? 4; // "human_like" has no tier; the UI shows it with the behavioural default
    sess.identityLabel = e.payload.label;
    sess.identityVerified = !!e.payload.verified;
    sess.signatureValid = e.payload.tier === 1 ? true : (e.payload.label === 'spoofed_signature' ? false : sess.signatureValid);
  }
});

// Register contract modules and start translating audit entries into bus events
for (const [mod, state] of moduleSet.all) registry.register(mod, { state });
auditBridge.start();

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT) || 3001;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3002;
const STOREFRONT_HOST = 'localhost';
const STOREFRONT_REAL_PORT = 3003;
const STOREFRONT_SANDBOX_PORT = 3004;

// ─── Rate limiting (per IP, for gateway's own endpoints) ────────────────────
const _rateLimits = new Map(); // ip → { count, windowStart }
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_REQ = 200; // per 10 seconds per IP

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  let rl = _rateLimits.get(ip) || { count: 0, windowStart: now };
  if (now - rl.windowStart > RATE_WINDOW_MS) {
    rl = { count: 0, windowStart: now };
  }
  rl.count++;
  _rateLimits.set(ip, rl);
  if (rl.count > RATE_MAX_REQ) {
    bus.publish('ingress.rejected', req.headers['x-session-id'] || 'anon', { reason: 'rate_limited', ip });
    return res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: RATE_WINDOW_MS / 1000 });
  }
  next();
}

// ─── Input validation ────────────────────────────────────────────────────────
function validateSessionId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

// ─── Proxy helper ────────────────────────────────────────────────────────────
function proxyRequest(targetPort, req, res, sessionId) {
  const options = {
    hostname: STOREFRONT_HOST,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, 'x-session-id': sessionId, host: `localhost:${targetPort}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    log.append('PROXY_ERROR', sessionId, `[ERROR] proxy to :${targetPort} failed: ${err.message}`);
    // Fail closed — don't silently fall through
    if (!res.headersSent) res.status(503).json({ error: 'gateway_error', fail: 'closed' });
  });

  req.pipe(proxyReq, { end: true });
}

// ─── Score and update session ────────────────────────────────────────────────
function updateScore(session) {
  const det = scoreSession(session);
  // Router combines deterministic + judgment + identity (raise-only)
  const t0 = process.hrtime.bigint();
  const decision = router.decide(session.id, det.score, det.reasons);
  moduleSet.riskRouter.handle({ type: 'decision', latency_ms: Number(process.hrtime.bigint() - t0) / 1e6, raisedBy: decision.raisedBy });
  const { score, reasons } = decision;
  const prevRoute = session.route;
  const newRoute = decision.route;

  session.riskScore = score;
  session.riskReasons = reasons;

  if (newRoute !== prevRoute) {
    session.route = newRoute;

    if (newRoute === 'QUARANTINE' && !session.sandboxed) {
      session.sandboxed = true;
      log.append('SANDBOX', session.id,
        `[SANDBOX] session-${session.id} routed to quarantine clone`,
        { score, reasons }
      );
    } else if (newRoute === 'BLOCK_PROPOSED' && !session.blockRuleHash) {
      // Create approval for block rule
      const { hash } = approval.createApproval(
        session.id,
        'BLOCK_SESSION',
        { sessionId: session.id, path: '/checkout', durationMin: 15 },
        { score, reasons, route: newRoute }
      );
      session.blockRuleHash = hash;
      log.append('BLOCK_PROPOSED', session.id,
        `[BLOCK PROPOSED] session-${session.id} score=${score.toFixed(2)} (${reasons.join('+')}) — awaiting approval hash=${hash}`,
        { score, reasons, hash }
      );
    }
  }

  log.append('RISK', session.id,
    `[RISK] session-${session.id} score ${score.toFixed(2)} (${reasons.join('+') || 'normal'}) route=${newRoute}`,
    { score, reasons, route: newRoute, deterministic: det.score, detReasons: det.reasons, components: decision.components, raisedBy: decision.raisedBy }
  );

  return session;
}

// ─── Gateway App ─────────────────────────────────────────────────────────────
const gatewayApp = express();
gatewayApp.use(cors());
gatewayApp.use(rateLimit);
gatewayApp.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    moduleSet.ingress.handle({ type: 'latency', latency_ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  });
  next();
});

// All storefront routes go through the gateway
gatewayApp.use((req, res) => {
  const sessionId = req.headers['x-session-id'] || 'anon';

  if (!validateSessionId(sessionId)) {
    bus.publish('ingress.rejected', 'invalid', { reason: 'invalid_session_id' });
    return res.status(400).json({ error: 'invalid_session_id' });
  }

  // Beacon: a JS-capable client pings this; never proxied, never scored as shopping traffic
  if (req.url.startsWith('/beacon')) {
    signals.recordBeacon(sessionId);
    return res.status(204).end();
  }

  // Agent completion signal: immediately marks session completed
  if (req.url.startsWith('/session/complete')) {
    const s = sessions.get(sessionId);
    if (s) {
      s.status = 'completed';
      s.completedAt = Date.now();
      s.lastActivityTs = Date.now();
      log.append('SESSION_COMPLETE', sessionId, `[COMPLETED] session-${sessionId} marked complete`);
    }
    return res.json({ ok: true, status: 'completed', sessionId });
  }

  const session = sessions.recordRequest(sessionId, req.method, req.url);
  // Signed-agent proof (tier 1) is verified here and handed to the classifier as a signal
  const sigCheck = signature.verify(req.headers, sessionId);
  const { signals: sig, present } = signals.extract(sessionId, req, { signature: sigCheck });
  bus.publish('signals.extracted', sessionId, { signals: sig, present });
  if (req.headers['x-agent-type']) {
    session.agentType = req.headers['x-agent-type'];
  }

  // Track path-specific counters
  if (req.url.includes('/search')) session.searchCount++;
  if (req.url.includes('/product/')) session.compareCount++;

  // Log tool call
  log.append('TOOL_CALL', sessionId,
    `[TOOL CALL] session-${sessionId} → ${req.method} ${req.url}`,
    { method: req.method, path: req.url }
  );

  // Handle checkout specially — wallet firewall + concurrency tracking
  if (req.url.startsWith('/checkout') && req.method === 'POST') {
    session.concurrentCheckouts++;
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}

      const amount = Number(parsed.amount) || 0;
      const item = String(parsed.item || '').slice(0, 200);
      const injectedReason = parsed.reason ? String(parsed.reason) : null;

      // Score before wallet check
      updateScore(session);
      session.concurrentCheckouts = Math.max(0, session.concurrentCheckouts - 1);

      // Block rule applied → 403
      if (session.blockRuleApplied) {
        log.append('BLOCKED', sessionId,
          `[BLOCKED] session-${sessionId} hit block rule → 403`,
          { path: req.url }
        );
        return res.status(403).json({ error: 'blocked', reason: 'block_rule_active' });
      }

      // Wallet firewall
      const walletResult = wallet.attemptCheckout(sessionId, amount, item, injectedReason);

      if (walletResult.allowed) {
        // Route to real or sandbox storefront
        const targetPort = session.sandboxed ? STOREFRONT_SANDBOX_PORT : STOREFRONT_REAL_PORT;
        proxyCheckoutResult(res, walletResult, session, targetPort);
      } else if (walletResult.requiresApproval) {
        res.status(202).json({
          status: 'approval_required',
          approvalHash: walletResult.approvalHash,
          reason: walletResult.reason,
          amount,
          item,
        });
      } else {
        res.status(402).json({
          status: 'denied',
          reason: walletResult.reason,
          denied: true,
        });
      }
    });
    return;
  }

  // Score session on every request
  updateScore(session);

  // Block rule applied → 403
  if (session.blockRuleApplied) {
    log.append('BLOCKED', sessionId,
      `[BLOCKED] session-${sessionId} hit block rule → 403`,
      { path: req.url }
    );
    return res.status(403).json({ error: 'blocked', reason: 'block_rule_active' });
  }

  // Route to real storefront or sandbox
  const targetPort = session.sandboxed ? STOREFRONT_SANDBOX_PORT : STOREFRONT_REAL_PORT;
  proxyRequest(targetPort, req, res, sessionId);
});

function proxyCheckoutResult(res, walletResult, session, targetPort) {
  res.json({
    status: 'success',
    orderId: walletResult.orderId,
    walletRemaining: walletResult.walletRemaining,
    sandbox: session.sandboxed,
  });
}

// ─── Admin App ────────────────────────────────────────────────────────────────
const adminApp = express();
adminApp.use(cors());
adminApp.use(express.json({ limit: '10kb' }));
adminApp.use(rateLimit);

// Aggregated stats for every module (one card per module on the dashboard)
/**
 * Real per-module stats (`modules`, `overall`) plus the flat keys the dashboard cards read
 * (ingress, session, signal, identity, ...), now filled from real module stats instead of the earlier mock.
 */
function statsWithDashboardKeys() {
  const all = registry.statsAll();
  const m = all.modules;
  const cnt = (name, k) => (m[name] && m[name].counters[k]) || 0;
  const cus = (name) => (m[name] && m[name].custom) || {};
  const h = (name) => (m[name] ? m[name].health : 'down');
  const live = sessions.all();
  const tiers = { tier1: cnt('identity-classifier', 'tier_1'), tier2: cnt('identity-classifier', 'tier_2'), tier3: cnt('identity-classifier', 'tier_3'), tier4: cnt('identity-classifier', 'tier_4'), tier5: cnt('identity-classifier', 'tier_5'), human: cnt('identity-classifier', 'tier_human') };
  const quarantined = live.filter(s => s.sandboxed || s.route === 'QUARANTINE').length;
  const avg = live.length ? live.reduce((a, s) => a + (s.riskScore || 0), 0) / live.length : 0;
  const pend = approval.getAllPending();
  return {
    ...all,
    ingress:    { health: h('ingress'), requests: cnt('ingress', 'requests'), rejected: cnt('ingress', 'rejected'), rateLimited: cnt('ingress', 'rate_limited'), rateLimitActive: true },
    session:    { health: h('session-tracker'), activeSessions: live.length, sessionsSeen: cus('session-tracker').sessions_seen || 0, windowMs: 10000 },
    signal:     { health: h('signal-collector'), extractions: cnt('signal-collector', 'extractions'), signalsTracked: cnt('signal-collector', 'extractions'), missingFieldRate: cus('signal-collector').missing_field_rate },
    identity:   { health: h('identity-classifier'), tiers, signedAgents: tiers.tier1, signaturePass: cnt('identity-classifier', 'signature_pass'), signatureFail: cnt('identity-classifier', 'signature_fail') },
    behaviour:  { health: h('behaviour-scorer'), avgRiskScore: +avg.toFixed(2), scoredSessions: cnt('behaviour-scorer', 'scored') },
    judgment:   { health: h('llm-behaviour-scorer'), provider: cus('llm-behaviour-scorer').primary, fallback: cus('llm-behaviour-scorer').fallback, mode: 'raise_only', calls: cnt('llm-behaviour-scorer', 'calls'), fallbacks: cnt('llm-behaviour-scorer', 'fallbacks'), providerFallbacks: cnt('llm-behaviour-scorer', 'provider_fallbacks'), injectionsFlagged: cnt('llm-behaviour-scorer', 'injections_flagged') },
    router:     { health: h('risk-router'), routes: { allow: live.filter(s => s.route === 'ALLOW').length, quarantine: quarantined, block_proposed: live.filter(s => s.route === 'BLOCK_PROPOSED').length }, decisions: cnt('risk-router', 'scored_final') },
    quarantine: { health: h('quarantine-store'), clonedPort: STOREFRONT_SANDBOX_PORT, sessionsQuarantined: quarantined, requestsDiverted: cnt('quarantine-store', 'requests_diverted'), realStateMutations: cnt('quarantine-store', 'real_state_mutations') },
    wallet:     { health: h('wallet-firewall'), txLimit: WALLET_TX_LIMIT, dailyLimit: WALLET_DAILY_LIMIT, currency: CURRENCY_CODE, totalUsed: live.reduce((a, s) => a + (s.walletDailyUsed || 0), 0), autoDeny: cnt('wallet-firewall', 'auto_deny'), needsApproval: cnt('wallet-firewall', 'needs_approval') },
    approval:   { health: h('approval-engine'), pending: pend.length, hashesBound: pend.map(p => p.hash) },
    audit:      { health: h('audit-log'), totalEntries: cnt('audit-log', 'events'), persistedRows: (cus('audit-log').persistence || {}).persisted_rows || 0 },
    dashboard:  { health: h('dashboard-bridge'), wsClients: wss ? wss.clients.size : 0 },
  };
}
adminApp.get('/stats/all', (req, res) => res.json(statsWithDashboardKeys()));

adminApp.get('/stats/:name', (req, res) => {
  const all = registry.statsAll();
  const m = all.modules[req.params.name];
  if (!m) return res.status(404).json({ error: 'unknown_module', modules: registry.names() });
  res.json({ name: req.params.name, ...m });
});

// Fault switch: { "down": true|false } — module drops events, system must fail closed
adminApp.post('/fault/:name', (req, res) => {
  const ok = registry.setFault(req.params.name, !!(req.body && req.body.down));
  if (!ok) return res.status(404).json({ error: 'unknown_module', modules: registry.names() });
  log.append('SYSTEM', 'gateway', `[FAULT] module ${req.params.name} down=${!!(req.body && req.body.down)}`);
  res.json({ ok: true, module: req.params.name, down: !!(req.body && req.body.down) });
});

// Recent bus events (for the defender agent and debugging)
adminApp.get('/events', (req, res) => {
  res.json(bus.history({ type: req.query.type, sessionId: req.query.session, limit: Math.min(parseInt(req.query.limit) || 100, 500) }));
});

// List sessions
adminApp.get('/sessions', (req, res) => {
  res.json(sessions.all().map(s => ({
    id: s.id,
    route: s.route,
    riskScore: s.riskScore,
    riskReasons: s.riskReasons,
    searchCount: s.searchCount,
    compareCount: s.compareCount,
    checkoutAttempts: s.checkoutAttempts,
    walletDailyUsed: s.walletDailyUsed,
    walletDailyLimit: s.walletDailyLimit,
    walletTxLimit: s.walletTxLimit,
    sandboxed: s.sandboxed,
    blockRuleApplied: s.blockRuleApplied,
    agentType: s.agentType,
    identityTier: s.identityTier || 4,
    signatureValid: !!s.signatureValid,
    requestRate: (s.requestLog?.length || 0) / 10,
  })));
});

// One approval by hash: pending, approved, denied, or unknown (never existed, or expired because the risk changed).
// Lets agents follow what the Judge decided instead of guessing.
adminApp.get('/approvals/:hash([a-f0-9]{16})', (req, res) => {
  const { hash } = req.params;
  const pending = approval.getPending(hash);
  if (pending) {
    return res.json({ status: 'pending', hash, action: pending.action, sessionId: pending.sessionId, actionData: pending.actionData, since: pending.ts });
  }
  if (approval.isApplied(hash)) {
    const done = approval.getApplied(hash);
    if (done.result === 'denied') return res.json({ status: 'denied', hash, action: done.action, sessionId: done.sessionId });
    return res.json({ status: 'approved', hash, action: done.action, sessionId: done.sessionId, result: done.result });
  }
  res.status(404).json({ status: 'unknown', hash, message: 'no such approval, or it expired because the session risk changed and needs a fresh one' });
});

// Get pending approvals
adminApp.get('/approvals', (req, res) => {
  res.json(approval.getAllPending());
});

// Approve an action
adminApp.post('/approve/:hash', (req, res) => {
  const { hash } = req.params;
  if (!hash || !/^[a-f0-9]{16}$/.test(hash)) {
    return res.status(400).json({ error: 'invalid_hash' });
  }

  const pending = approval.getPending(hash);
  if (!pending) {
    // Check if already applied (idempotency)
    if (approval.isApplied(hash)) {
      // A denied request is final: say so instead of reporting it as applied.
      if (approval.getApplied(hash).result === 'denied') {
        return res.status(409).json({ ok: false, reason: 'already_denied', message: 'this approval was denied and cannot be applied' });
      }
      return res.json({ ok: true, idempotent: true, message: 'already applied' });
    }
    return res.status(404).json({ error: 'approval_not_found' });
  }

  const result = approval.applyApproval(hash, (p) => {
    if (p.action === 'BLOCK_SESSION') {
      return applyBlockRule(p);
    } else if (p.action === 'WALLET_CHECKOUT') {
      return wallet.executeCheckout(p.sessionId, p.actionData.amount, p.actionData.item);
    }
    throw new Error(`unknown action: ${p.action}`);
  });

  res.json(result);
});

// Deny an action
adminApp.post('/deny/:hash', (req, res) => {
  const { hash } = req.params;
  if (!hash || !/^[a-f0-9]{16}$/.test(hash)) {
    return res.status(400).json({ error: 'invalid_hash' });
  }
  res.json(approval.denyApproval(hash));
});

// Get audit log entries
adminApp.get('/log', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json(log.query({ since, limit }));
});

// Persisted (Neon) history — survives restarts. ?session=&type=&run=&limit=
adminApp.get('/log/persisted', async (req, res) => {
  try {
    res.json(await persistence.query({ sessionId: req.query.session, type: req.query.type, runId: req.query.run, limit: parseInt(req.query.limit) || 100 }));
  } catch (err) {
    res.status(503).json({ error: 'persistence_unavailable', detail: err.message });
  }
});

// Persisted approval records (pending / approved / denied / no-op re-clicks / re-approvals)
adminApp.get('/approvals/history', async (req, res) => {
  try {
    res.json(await persistence.approvals({ sessionId: req.query.session, runId: req.query.run, limit: parseInt(req.query.limit) || 100 }));
  } catch (err) {
    res.status(503).json({ error: 'persistence_unavailable', detail: err.message });
  }
});

// Append audit log entry (used by defender agent and test harness)
adminApp.post('/log', (req, res) => {
  const { type, sessionId, message, data } = req.body || {};
  if (!type || !sessionId || !message) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const entry = log.append(type, sessionId, message, data || {});
  res.json({ ok: true, entry });
});

// Get all log entries
adminApp.get('/log/all', (req, res) => {
  res.json(log.all());
});

// Mark session completed
adminApp.post('/session/:id/complete', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) {
    s.status = 'completed';
    s.completedAt = Date.now();
    s.lastActivityTs = Date.now();
    log.append('SESSION_COMPLETE', req.params.id, `[COMPLETED] session-${req.params.id} marked complete`);
  }
  res.json({ ok: true, status: 'completed' });
});

// Run agent scenario from UI
adminApp.post('/run-agent/:type', (req, res) => {
  const { type } = req.params;
  const scriptMap = {
    legit:           'legitimate.js',
    scalper:         'scalper.js',
    ambiguous:       'ambiguous.js',
    'llm-attacker':  'llm-attacker.js',
    'llm-inject':    'llm-attacker.js',
    signed:          'signed-agent.js',
    defender:        'defender-agent.js',
  };
  const scriptName = scriptMap[type];
  if (!scriptName) {
    return res.status(400).json({ error: 'unknown_agent_type', allowed: Object.keys(scriptMap) });
  }

  const scriptPath = path.join(__dirname, '..', 'agents', scriptName);
  log.append('SYSTEM', 'gateway', `[LAUNCH] Spawning ${type} agent script: ${scriptName}`);

  const sessionId = `${type}-${Date.now()}`;
  const env = { ...process.env, SESSION_ID: sessionId };
  if (type === 'llm-inject') env.ATTACKER_MODE = 'inject';
  if (type === 'llm-attacker') env.ATTACKER_MODE = 'normal';

  const child = fork(scriptPath, [], { stdio: 'inherit', env });
  child.on('error', (err) => {
    log.append('SYSTEM', 'gateway', `[ERROR] Failed to run ${type} agent: ${err.message}`);
  });
  child.on('exit', (code) => {
    log.append('SYSTEM', 'gateway', `[COMPLETE] Agent ${type} run finished (code: ${code})`);
    const s = sessions.get(sessionId);
    if (s) {
      s.status = 'completed';
      s.completedAt = Date.now();
      s.lastActivityTs = Date.now();
    }
  });

  res.json({ ok: true, agent: type, script: scriptName, pid: child.pid, sessionId });
});

/**
 * Apply a block rule to the session store and verify it by replaying a request.
 * Hardening rule #5: verify the outcome after applying.
 */
function applyBlockRule(pending) {
  const { sessionId } = pending;
  const session = sessions.get(sessionId);
  session.blockRuleApplied = true;
  session.route = 'BLOCKED';

  log.append('BLOCK_APPLIED', sessionId,
    `[BLOCK APPLIED] session-${sessionId} → /checkout blocked for ${pending.actionData.durationMin}min`,
    { sessionId, durationMin: pending.actionData.durationMin }
  );

  // The door is shut, so the suspect's other held payments are moot: close them instead of leaving a pile for the Judge.
  const moot = approval.getAllPending().filter((a) => a.sessionId === sessionId && a.action === 'WALLET_CHECKOUT');
  for (const a of moot) approval.denyApproval(a.hash, 'policy', 'session blocked');
  if (moot.length) log.append('SYSTEM', sessionId, `[POLICY] session-${sessionId} blocked: ${moot.length} other held payment(s) closed automatically`, { closed: moot.map((a) => a.hash) });

  // Verify: simulate a request from that session and confirm 403
  setImmediate(() => verifyBlock(sessionId));

  return { blocked: true, sessionId };
}

function verifyBlock(sessionId) {
  const options = {
    hostname: 'localhost',
    port: GATEWAY_PORT,
    path: '/checkout',
    method: 'POST',
    headers: {
      'x-session-id': sessionId,
      'content-type': 'application/json',
    },
  };

  const verifyReq = http.request(options, (verifyRes) => {
    if (verifyRes.statusCode === 403) {
      log.append('VERIFIED', sessionId,
        `[VERIFIED] session-${sessionId} retry → 403 confirmed`,
        { statusCode: 403 }
      );
    } else {
      log.append('VERIFY_FAILED', sessionId,
        `[VERIFY FAILED] session-${sessionId} retry → ${verifyRes.statusCode} (expected 403!)`,
        { statusCode: verifyRes.statusCode }
      );
    }
  });

  verifyReq.on('error', (err) => {
    log.append('VERIFY_ERROR', sessionId,
      `[VERIFY ERROR] could not verify block: ${err.message}`, {}
    );
  });

  verifyReq.write(JSON.stringify({ amount: 1, item: 'verify-probe' }));
  verifyReq.end();
}

// ─── WebSocket log streaming ──────────────────────────────────────────────────
const adminServer = http.createServer(adminApp);
const wss = new WebSocketServer({ server: adminServer });

wss.on('connection', (ws) => {
  moduleSet.dashboardBridge.handle({ type: 'ws.connected' });
  ws.on('close', () => moduleSet.dashboardBridge.handle({ type: 'ws.closed' }));

  // Send last 100 log entries on connect
  const recent = log.last(100);
  ws.send(JSON.stringify({ type: 'bulk', entries: recent }));

  // Subscribe to new entries
  const handler = (entry) => {
    if (ws.readyState === ws.OPEN) {
      const t0 = process.hrtime.bigint();
      ws.send(JSON.stringify({ type: 'entry', entry }));
      moduleSet.dashboardBridge.handle({ type: 'ws.push', latency_ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    }
  };
  log.on('entry', handler);

  // Send session state every 500ms. Inactive sessions idle for >15s are marked
  // 'completed' (fallback GC); explicit completion is handled via /session/complete.
  const SESSION_IDLE_MS    = Number(process.env.SESSION_IDLE_MS) || 15_000;   // mark completed after 15s idle fallback
  const SESSION_PURGE_MS   = Number(process.env.SESSION_PURGE_MS) || 25_000;  // delete from store after 25s idle

  const sessionInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    const now = Date.now();
    const all = sessions.all();
    const visible = [];
    // A session with a human decision still waiting must stay in memory: approving re-checks its risk, and a purged
    // session would make every pending approval fail as "state changed". It becomes purgeable once decided.
    const awaitingJudge = new Set(approval.getAllPending().map((p) => p.sessionId));

    for (const s of all) {
      const idle = now - (s.lastActivityTs || s.createdAt);
      if (awaitingJudge.has(s.id)) {
        s.lastActivityTs = now; // the wait is not idleness
        if (s.status === 'completed') { s.status = 'active'; s.completedAt = null; }
      }

      // Purge sessions that have been idle for >25s
      if (idle > SESSION_PURGE_MS) {
        sessions.delete(s.id);
        continue;
      }

      // Purge completed sessions after 3.5s so they stop broadcasting
      if (s.status === 'completed' && s.completedAt && (now - s.completedAt > 3_500)) {
        sessions.delete(s.id);
        continue;
      }

      // Mark idle sessions as completed (sprite fades out in the UI)
      if (idle > SESSION_IDLE_MS && s.status === 'active') {
        s.status = 'completed';
        s.completedAt = now;
      }

      visible.push({
        id: s.id,
        route: s.route,
        riskScore: s.riskScore,
        riskReasons: s.riskReasons,
        searchCount: s.searchCount,
        compareCount: s.compareCount,
        checkoutAttempts: s.checkoutAttempts,
        walletDailyUsed: s.walletDailyUsed,
        walletDailyLimit: s.walletDailyLimit,
        walletTxLimit: s.walletTxLimit,
        sandboxed: s.sandboxed,
        blockRuleApplied: s.blockRuleApplied,
        agentType: s.agentType,
        identityTier: s.identityTier || 4,
        signatureValid: !!s.signatureValid,
        requestRate: (s.requestLog?.length || 0) / 10,
        status: s.status || 'active',
        completedAt: s.completedAt || null,
        lastActivityTs: s.lastActivityTs || s.createdAt,
      });
    }

    ws.send(JSON.stringify({ type: 'sessions', sessions: visible }));
  }, 500);

  ws.on('close', () => {
    log.removeListener('entry', handler);
    clearInterval(sessionInterval);
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
const gatewayServer = http.createServer(gatewayApp);
gatewayServer.listen(GATEWAY_PORT, () => {
  console.log(`[Gateway] listening on :${GATEWAY_PORT}`);
  log.append('SYSTEM', 'gateway', `[SYSTEM] Gateway started on :${GATEWAY_PORT}`);
});

adminServer.listen(ADMIN_PORT, () => {
  console.log(`[Admin]   listening on :${ADMIN_PORT} (WebSocket + REST)`);
  log.append('SYSTEM', 'gateway', `[SYSTEM] Admin API started on :${ADMIN_PORT}`);
});

moduleSet.warmupJudge();

persistence.start(log).then((r) => {
  console.log(`[Persist] ${r.enabled ? `audit log → Neon (run ${r.runId}, ${r.ready ? 'ready' : 'connecting, will retry'})` : 'disabled (no DATABASE_URL or PERSIST_AUDIT=off)'}`);
}).catch((err) => console.error('[Persist] start failed:', err.message));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { persistence.stop().finally(() => process.exit(0)); });
}

process.on('uncaughtException', (err) => {
  console.error('[GATEWAY UNCAUGHT]', err);
  log.append('SYSTEM_ERROR', 'gateway', `[ERROR] Uncaught exception: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[GATEWAY UNHANDLED REJECTION]', reason);
});

module.exports = { gatewayApp, adminApp };
