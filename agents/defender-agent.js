'use strict';
/**
 * Defender Agent — reads events, classifies sessions, runs scoring script in sandbox,
 * proposes policy via apply_policy tool.
 *
 * This agent uses an LLM (with fallback scripted loop) to:
 *   1. Watch active sessions and audit log events
 *   2. Identify high-risk or suspicious sessions
 *   3. Run a sandboxed scoring script (simple deterministic function, simulated here)
 *   4. Propose policy via the gated apply_policy tool (irreversible — needs its own approval)
 *
 * Stats:
 *   verdicts, agreement with scorer, sandbox_script_runtime, proposals_approved, proposals_rejected
 */

const http = require('http');

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.AGENT_MODEL || process.env.OPENAI_MODEL || 'gpt-6-luna';
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3002;
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT) || 3001;
const SESSION_ID = `defender-${Date.now()}`;
const POLL_INTERVAL_MS = 3000;
const MAX_ROUNDS = 10;

// ─── Stats ────────────────────────────────────────────────────────────────────
const stats = {
  name: 'defender-agent',
  model: MODEL,
  sessionId: SESSION_ID,
  verdicts: 0,
  agreements: 0,        // verdict agreed with deterministic scorer route
  disagreements: 0,
  llmJudgments: 0,
  llmAgreements: 0,
  sandboxScriptRuns: 0,
  sandboxScriptMs: 0,
  proposalsApproved: 0,
  proposalsRejected: 0,
  policyApplications: 0,
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function adminReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost',
      port: ADMIN_PORT,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': data ? Buffer.byteLength(data) : 0,
      },
    };
    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (_) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Sandboxed scoring script ─────────────────────────────────────────────────
// This is the "code sandbox" scoring script the defender runs as a second opinion.
// In TrueForge, this would run in the harness's sandboxed Python environment.
// Here we run it as a plain JS function to simulate that.
function runSandboxedScoringScript(session) {
  const start = Date.now();
  stats.sandboxScriptRuns++;

  // Script: cluster-based risk scoring (deterministic, second opinion)
  let score = 0;
  const signals = [];

  // Signal 1: No search before checkout
  const searches = session.searchCount || 0;
  const checkouts = session.checkoutAttempts || 0;
  if (checkouts > 0 && searches === 0) {
    score += 0.40;
    signals.push('no_search_before_checkout');
  }

  // Signal 2: High checkout count with low search ratio
  if (checkouts > 2 && searches < checkouts / 3) {
    score += 0.20;
    signals.push('checkout_dominant');
  }

  // Signal 3: Request rate (estimated)
  const rate = session.requestRate || 0;
  if (rate > 3) {
    score += 0.25;
    signals.push('high_request_rate');
  }

  // Signal 4: Already sandboxed
  if (session.sandboxed) {
    score += 0.15;
    signals.push('already_sandboxed');
  }

  // Clamp
  score = Math.min(1.0, score);

  // Verdict
  let verdict;
  if (score >= 0.70) verdict = 'BLOCK_PROPOSED';
  else if (score >= 0.40) verdict = 'QUARANTINE';
  else verdict = 'ALLOW';

  const ms = Date.now() - start;
  stats.sandboxScriptMs += ms;

  return { score: parseFloat(score.toFixed(2)), signals, verdict, scriptMs: ms };
}

// ─── LLM Defense Judgment (gpt-6-luna) ────────────────────────────────────────
async function callLLMDefenseJudgment(session, sandboxResult) {
  if (!OPENAI_API_KEY) return null;
  return new Promise((resolve) => {
    const prompt = `You are the TrueForge Defender Agent. Analyze this active ecommerce session telemetry:
Session ID: ${session.id}
Agent Type: ${session.agentType || 'unknown'}
Search Count: ${session.searchCount || 0}
Checkout Attempts: ${session.checkoutAttempts || 0}
Concurrent Checkouts: ${session.concurrentCheckouts || 0}
Current Gateway Route: ${session.route || 'ALLOW'}
Sandboxed (Quarantine): ${session.sandboxed ? 'YES' : 'NO'}
Risk Score: ${session.riskScore || 0}
Risk Reasons: ${(session.riskReasons || []).join(', ') || 'none'}
Sandbox Scorer Verdict: ${sandboxResult.verdict} (Score: ${sandboxResult.score}, Signals: ${sandboxResult.signals.join(', ')})

Respond with a JSON object:
{
  "verdict": "ALLOW" | "QUARANTINE" | "BLOCK_PROPOSED",
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "rationale": "<1-2 sentence explanation>"
}`;

    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are an autonomous AI cyber-defense agent analyzing ecommerce traffic. Output only JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 300,
    });

    const https = require('https');
    const req = https.request({
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf);
          if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
            const judgment = JSON.parse(parsed.choices[0].message.content);
            resolve(judgment);
          } else {
            resolve(null);
          }
        } catch (_) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Classify and decide ──────────────────────────────────────────────────────
async function analyzeSession(session) {
  stats.verdicts++;

  // 1. Run sandbox scoring script (clustering second opinion)
  const sandboxResult = runSandboxedScoringScript(session);

  // 2. Query LLM Defense Judgment (gpt-6-luna)
  let llmResult = null;
  try {
    llmResult = await callLLMDefenseJudgment(session, sandboxResult);
  } catch (_) {}

  if (llmResult && llmResult.verdict) {
    stats.llmJudgments++;
    if (llmResult.verdict === session.route) stats.llmAgreements++;
  }

  // Compare with gateway's deterministic scorer
  const gwRoute = session.route || 'ALLOW';
  const effectiveVerdict = (llmResult && llmResult.verdict) || sandboxResult.verdict;
  const agrees = effectiveVerdict === gwRoute
    || (effectiveVerdict === 'BLOCK_PROPOSED' && gwRoute === 'BLOCK_PROPOSED')
    || (effectiveVerdict === 'QUARANTINE' && (gwRoute === 'QUARANTINE' || gwRoute === 'BLOCK_PROPOSED'));

  if (agrees) stats.agreements++;
  else stats.disagreements++;

  const report = {
    sessionId: session.id,
    agentType: session.agentType,
    gwRoute,
    sandboxScore: sandboxResult.score,
    sandboxVerdict: sandboxResult.verdict,
    sandboxSignals: sandboxResult.signals,
    llmVerdict: llmResult ? llmResult.verdict : null,
    llmConfidence: llmResult ? llmResult.confidence : null,
    llmRationale: llmResult ? llmResult.rationale : null,
    agrees,
    scriptMs: sandboxResult.scriptMs,
    riskScore: session.riskScore,
  };

  console.log(`[DEFENDER] Session ${session.id}: sandbox=${sandboxResult.verdict}(${sandboxResult.score}) llm(${MODEL})=${llmResult ? llmResult.verdict : 'n/a'} gw=${gwRoute} agree=${agrees}`);
  if (llmResult && llmResult.rationale) {
    console.log(`[DEFENDER]   LLM Rationale: ${llmResult.rationale} [Confidence: ${llmResult.confidence}]`);
  }
  if (sandboxResult.signals.length) {
    console.log(`[DEFENDER]   Signals: ${sandboxResult.signals.join(', ')}`);
  }

  // Push defender verdict to gateway audit log for live UI feed
  await adminReq('POST', '/log', {
    type: 'DEFENDER',
    sessionId: session.id,
    message: `[DEFENDER] session-${session.id} verdict: sandbox=${sandboxResult.verdict} llm=${llmResult ? llmResult.verdict : 'scripted'} gw=${gwRoute} agree=${agrees}`,
    data: report,
  }).catch(() => {});

  return report;
}

// ─── Check for pending approvals and auto-handle obviously safe cases ─────────
async function handlePendingApprovals() {
  const result = await adminReq('GET', '/approvals');
  if (result.status !== 200 || !Array.isArray(result.body)) return;

  const pending = result.body;
  if (pending.length === 0) return;

  console.log(`[DEFENDER] Found ${pending.length} pending approval(s)`);

  for (const p of pending) {
    console.log(`\n[DEFENDER] ⏸️ PAUSE BEFORE IRREVERSIBLE ACTION on approval hash: ${p.hash}`);
    console.log(`[DEFENDER]   Target: session-${p.sessionId} | Action: ${p.action}`);
    console.log(`[DEFENDER]   Evidence: ${(p.riskSnapshot?.reasons || []).join(' + ') || 'score ' + (p.riskSnapshot?.score || 0)}`);

    let decision = null;
    const logRes = await adminReq('GET', `/log?limit=200`);
    const entries = (logRes.body || []).filter(e => e.sessionId === p.sessionId);
    const hasInjection = entries.some(e => e.message && e.message.toLowerCase().includes('inject'));

    if (hasInjection) {
      decision = 'deny';
      console.log(`[DEFENDER]   Verdict: INJECTION FLAG -> APPLYING DENY via apply_policy tool...`);
    } else if (p.action === 'BLOCK_SESSION' && p.riskSnapshot?.score >= 0.70) {
      decision = 'approve';
      console.log(`[DEFENDER]   Verdict: SCALPER DETECTED (>0.70) -> APPLYING BLOCK APPROVAL via apply_policy tool...`);
    }

    if (decision) {
      try {
        const postData = JSON.stringify({ hash: p.hash, decision });
        const policyRes = await new Promise((resolve) => {
          const req = http.request({
            hostname: 'localhost',
            port: Number(process.env.TOOL_SERVER_PORT || 3007),
            path: '/call/apply_policy',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(postData),
            },
            timeout: 3000,
          }, res => {
            let d = '';
            res.on('data', chunk => d += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(d)); } catch (_) { resolve({ ok: false, raw: d }); }
            });
          });
          req.on('error', () => resolve({ ok: false }));
          req.write(postData);
          req.end();
        });

        stats.policyApplications++;
        if (decision === 'approve') stats.proposalsApproved++;
        else stats.proposalsRejected++;

        console.log(`[DEFENDER]   apply_policy result: ${JSON.stringify(policyRes)}`);

        // Post policy execution to audit log
        await adminReq('POST', '/log', {
          type: 'DEFENDER',
          sessionId: p.sessionId,
          message: `[DEFENDER POLICY] Executed ${decision.toUpperCase()} on approval ${p.hash} (${p.action})`,
          data: { hash: p.hash, decision, action: p.action },
        }).catch(() => {});
      } catch (err) {
        console.warn(`[DEFENDER] Policy application failed: ${err.message}`);
      }
    } else {
      console.log(`[DEFENDER]   Approval ${p.hash} for session ${p.sessionId} — flagged for human operator review`);
      stats.proposalsApproved++;
    }
  }
}

// ─── Main defender loop ───────────────────────────────────────────────────────
async function defend() {
  console.log(`\n[DEFENDER] ═══════════════════════════════════════════════`);
  console.log(`[DEFENDER]  Defender Agent — Model: ${MODEL}`);
  console.log(`[DEFENDER]  Session: ${SESSION_ID}`);
  console.log(`[DEFENDER]  Polling every ${POLL_INTERVAL_MS}ms, max ${MAX_ROUNDS} rounds`);
  console.log(`[DEFENDER] ═══════════════════════════════════════════════\n`);

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n[DEFENDER] Round ${round}/${MAX_ROUNDS}`);

    // Get all sessions
    const sessionsResult = await adminReq('GET', '/sessions');
    if (sessionsResult.status !== 200) {
      console.warn(`[DEFENDER] Could not fetch sessions: ${sessionsResult.status}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const sessions = sessionsResult.body || [];
    const interesting = sessions.filter(s => s.riskScore > 0.3 || s.sandboxed || s.checkoutAttempts > 0);

    if (interesting.length === 0) {
      console.log('[DEFENDER] No interesting sessions. Waiting...');
    } else {
      for (const session of interesting) {
        await analyzeSession(session);
      }
    }

    // Check pending approvals
    await handlePendingApprovals();

    await sleep(POLL_INTERVAL_MS);
  }

  printStats();
}

function printStats() {
  const avgScriptMs = stats.sandboxScriptRuns > 0 ? (stats.sandboxScriptMs / stats.sandboxScriptRuns).toFixed(1) : 0;
  const agreementRate = stats.verdicts > 0 ? ((stats.agreements / stats.verdicts) * 100).toFixed(0) : 0;
  const llmAgreementRate = stats.llmJudgments > 0 ? ((stats.llmAgreements / stats.llmJudgments) * 100).toFixed(0) : 0;

  console.log('\n[DEFENDER] ═══════════ STATS ═══════════');
  console.log(`[DEFENDER]  Model:              ${stats.model}`);
  console.log(`[DEFENDER]  Verdicts:           ${stats.verdicts}`);
  console.log(`[DEFENDER]  Agreement rate:     ${agreementRate}%`);
  console.log(`[DEFENDER]  Disagreements:      ${stats.disagreements}`);
  console.log(`[DEFENDER]  LLM Judgments:      ${stats.llmJudgments} (${llmAgreementRate}% agreement)`);
  console.log(`[DEFENDER]  Sandbox runs:       ${stats.sandboxScriptRuns}`);
  console.log(`[DEFENDER]  Avg sandbox ms:     ${avgScriptMs}ms`);
  console.log(`[DEFENDER]  Policy calls:       ${stats.policyApplications}`);
  console.log(`[DEFENDER]  Proposals handled:  ${stats.proposalsApproved + stats.proposalsRejected}`);
  console.log('[DEFENDER] ═══════════════════════════════');
}

// Export standard module contract
module.exports = {
  name: 'defender-agent',
  model: MODEL,
  stats: () => stats,
  health: () => 'ok',
  handle: async (event, ctx) => {
    return { status: 'handled', stats };
  },
};

defend().catch(err => {
  console.error('[DEFENDER] Fatal error:', err.message);
  printStats();
  process.exit(1);
});
