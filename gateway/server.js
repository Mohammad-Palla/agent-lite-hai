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
const router = require('./router');
const persistence = require('./persistence');
const moduleSet = require('./modules');

// Register contract modules and start translating audit entries into bus events
for (const [mod, state] of moduleSet.all) registry.register(mod, { state });
auditBridge.start();

const GATEWAY_PORT = 3001;
const ADMIN_PORT = 3002;
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

  const session = sessions.recordRequest(sessionId, req.method, req.url);
  const { signals: sig, present } = signals.extract(sessionId, req);
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
adminApp.get('/stats/all', (req, res) => res.json(registry.statsAll()));

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
    checkoutAttempts: s.checkoutAttempts,
    walletDailyUsed: s.walletDailyUsed,
    walletDailyLimit: s.walletDailyLimit,
    sandboxed: s.sandboxed,
    blockRuleApplied: s.blockRuleApplied,
    agentType: s.agentType,
  })));
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

// Get all log entries
adminApp.get('/log/all', (req, res) => {
  res.json(log.all());
});

// Run agent scenario from UI
adminApp.post('/run-agent/:type', (req, res) => {
  const { type } = req.params;
  const scriptMap = {
    legit: 'legitimate.js',
    scalper: 'scalper.js',
    ambiguous: 'ambiguous.js',
  };
  const scriptName = scriptMap[type];
  if (!scriptName) {
    return res.status(400).json({ error: 'unknown_agent_type', allowed: Object.keys(scriptMap) });
  }

  const scriptPath = path.join(__dirname, '..', 'agents', scriptName);
  log.append('SYSTEM', 'gateway', `[LAUNCH] Spawning ${type} agent script: ${scriptName}`);

  const child = fork(scriptPath, [], { stdio: 'inherit' });
  child.on('error', (err) => {
    log.append('SYSTEM', 'gateway', `[ERROR] Failed to run ${type} agent: ${err.message}`);
  });

  res.json({ ok: true, agent: type, script: scriptName, pid: child.pid });
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

  // Send session state every 500ms
  const sessionInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'sessions', sessions: sessions.all().map(s => ({
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
        requestRate: s.requestLog.length / 10,
      })) }));
    }
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
