'use strict';
/**
 * Contract wrappers for the built modules. Each one sees only bus events —
 * no imports of another module's internals — so it can be replayed alone.
 */

const { defineModule } = require('../contract');

const histogram = (st, prefix, score) => {
  const bucket = Math.min(9, Math.floor(score * 10));
  st.inc(`${prefix}_${(bucket / 10).toFixed(1)}`);
};

// 1. ingress — request acceptance, rejects, rate limits, latency (fed by server middleware)
const ingress = defineModule({
  name: 'ingress',
  subscribes: ['ingress.accepted', 'ingress.rejected'],
  onEvent(e, st) {
    if (e.type === 'latency') { st.latency(e.latency_ms); return; } // direct call from server middleware
    if (e.type === 'ingress.accepted') st.inc('requests');
    else {
      st.inc('rejected');
      if (e.payload.reason === 'rate_limited') st.inc('rate_limited');
    }
    if (typeof e.payload.latency_ms === 'number') st.latency(e.payload.latency_ms);
  },
});

// 2. session-tracker
const seen = new Set();
const sessionTracker = defineModule({
  name: 'session-tracker',
  subscribes: ['session.updated'],
  onEvent(e, st) {
    st.inc('session_events');
    seen.add(e.session_id);
    st.set('active_sessions', e.payload.active_sessions);
    st.set('sessions_seen', seen.size);
  },
});

// 3. signal-collector — fields captured and missing-field rate
const TRACKED = ['ua', 'accept', 'accept_language', 'referrer', 'sec_fetch', 'beacon'];
const signalCollector = defineModule({
  name: 'signal-collector',
  subscribes: ['signals.extracted'],
  onEvent(e, st) {
    st.inc('extractions');
    const present = e.payload.present || {};
    for (const f of TRACKED) st.inc(present[f] ? `captured_${f}` : `missing_${f}`);
    st.inc(`ua_${e.payload.signals.ua_class}`);
    st.inc(`shape_${e.payload.signals.sequence_shape}`);
    const cv = e.payload.signals.timing.cv;
    if (cv !== null && cv < 0.15) st.inc('regular_timing');
  },
  custom: () => {
    const s = signalCollector.rawCounters();
    const total = TRACKED.reduce((n, f) => n + (s[`captured_${f}`] || 0) + (s[`missing_${f}`] || 0), 0);
    const missing = TRACKED.reduce((n, f) => n + (s[`missing_${f}`] || 0), 0);
    return { missing_field_rate: total ? +(missing / total).toFixed(3) : null, fields_tracked: TRACKED.length };
  },
});

// 4. identity-classifier — tiers 2–5 (tier 1 signature lands later)
const identity = require('../identity');
const identityClassifier = defineModule({
  name: 'identity-classifier',
  subscribes: ['signals.extracted'],
  onEvent(e, st, ctx) {
    const sig = e.payload.signals;
    const result = identity.classifySignals(sig);
    st.inc(`tier_${result.tier === null ? 'human' : result.tier}`);
    if (result.tier === null) st.inc('unknown');
    if (sig.signature_present) st.inc('signature_present');
    if (ctx.bus) ctx.bus.publish('identity.classified', e.session_id, { ...result, verified: false }, e.trace_id);

    // Known bot on a public IP: verify by reverse DNS, then upgrade to tier 2 asynchronously.
    const bot = identity.knownBot(sig.ua);
    if (bot && ctx.bus) {
      st.inc('rdns_attempts');
      identity.verifyReverseDns(sig.ip, bot).then((r) => {
        if (r.verified) {
          st.inc('rdns_hits');
          st.inc('tier_2');
          ctx.bus.publish('identity.classified', e.session_id, {
            tier: 2, label: 'network_verified', confidence: 0.9, bot: bot.name,
            evidence: [`ua_known_bot:${bot.name}`, `rdns:${r.hostname}`], verified: true,
          }, e.trace_id);
        } else {
          st.inc(`rdns_fail_${r.reason}`);
        }
      }).catch((err) => st.error(err));
    }
  },
  custom: () => {
    const c = identityClassifier.rawCounters();
    const total = Object.keys(c).filter(k => k.startsWith('tier_') && k !== 'tier_2').reduce((n, k) => n + c[k], 0);
    return {
      unknown_rate: total ? +((c.unknown || 0) / total).toFixed(3) : null,
      rdns_hit_rate: c.rdns_attempts ? +((c.rdns_hits || 0) / c.rdns_attempts).toFixed(3) : null,
      signature_pass: 0, // set when tier 1 verification lands
      signature_fail: 0,
    };
  },
});

// 5. behaviour-scorer — score histogram and how often each signal fires
const behaviourScorer = defineModule({
  name: 'behaviour-scorer',
  subscribes: ['risk.scored'],
  onEvent(e, st) {
    if (e.payload.source === 'judgment') return; // judgment scorer has its own module
    st.inc('scored');
    histogram(st, 'score', e.payload.deterministic ?? e.payload.score ?? 0);
    for (const r of e.payload.det_reasons || e.payload.reasons || []) st.inc(`signal_${String(r).split(':')[0]}`);
  },
});

// 5b. llm-behaviour-scorer — raise-only judgment; 800ms budget; falls back to deterministic alone
const judgment = require('../judgment');
// Each provider has its own key: jev → TYPESAFE_API_KEY, openai → OPENAI_API_KEY, classifier → CLASSIFIER_KEY
const judgeKey = (provider) => ({ jev: process.env.TYPESAFE_API_KEY, openai: process.env.OPENAI_API_KEY, classifier: process.env.CLASSIFIER_KEY }[provider]) || undefined;
const judgeDeps = { fetchImpl: undefined, provider: null, fallback: null, key: null, timeoutMs: null, minGapMs: 2000, maxInflight: 3 };
// Primary + optional fallback (JUDGE_PROVIDER, JUDGE_FALLBACK). A fallback is only used when its key exists.
const primaryName = () => judgeDeps.provider || process.env.JUDGE_PROVIDER || 'classifier';
const fallbackName = () => {
  const f = judgeDeps.fallback ?? process.env.JUDGE_FALLBACK;
  return f && f !== primaryName() && f !== 'none' && (judgeDeps.key || judgeKey(f)) ? f : null;
};
// Circuit breaker: after 3 consecutive primary failures skip it for 30s so a dead primary costs no latency.
const breaker = { fails: 0, openUntil: 0 };
const BREAKER_FAILS = 3, BREAKER_MS = 30_000;
function buildChain() {
  const chain = [];
  const p = primaryName(), f = fallbackName();
  const primaryOpen = Date.now() < breaker.openUntil;
  if (!(primaryOpen && f)) chain.push({ provider: p, key: judgeDeps.key || judgeKey(p) });
  if (f) chain.push({ provider: f, key: judgeDeps.key || judgeKey(f) });
  return chain;
}
const judgeState = new Map();   // sessionId → collected facts + throttle state
const judgeLatency = [];
let inflight = 0;
const pctl = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };

function judgeFacts(s) {
  return { ...s.signals, ...s.checkout, reasons: s.reasons, window_requests: s.window_requests, justification: s.justification };
}


function runJudgment(id, s, traceId, ctx, st) {
  s.busy = true; s.pending = false; s.last = Date.now(); inflight++;
  const chain = buildChain();
  const t0 = Date.now();
  st.inc('calls');
  judgment.judgeChain(judgeFacts(s), chain, { fetchImpl: judgeDeps.fetchImpl, timeoutMs: judgeDeps.timeoutMs || undefined })
    .then((r) => {
      judgeLatency.push(Date.now() - t0); if (judgeLatency.length > 200) judgeLatency.shift();
      st.inc(`served_by_${r.provider}`);
      const primaryFailed = r.attempts[0] && r.attempts[0].provider === primaryName() && !r.attempts[0].ok;
      if (r.fallback) st.inc('provider_fallbacks');
      if (primaryFailed) { st.inc('primary_failures'); if (++breaker.fails >= BREAKER_FAILS) { breaker.openUntil = Date.now() + BREAKER_MS; st.inc('breaker_opened'); breaker.fails = 0; } }
      else if (r.provider === primaryName()) breaker.fails = 0;
      const c = judgment.combine(s.det, r);
      if (c.raised) st.inc('raised_risk');
      if (r.injection) st.inc('injections_flagged');
      st.inc((r.score >= 0.4) === (s.det >= 0.4) ? 'agree' : 'disagree');
      ctx.bus.publish('risk.scored', id, {
        source: 'judgment', provider: r.provider, fallback: r.fallback, score: r.score, answers: r.answers,
        injection: r.injection, deterministic: s.det, final: c.final, flags: c.flags,
      }, traceId);
    })
    .catch((err) => {
      // Every provider failed. Never fail open: deterministic score stands, wallet limits unchanged.
      if (err.timeout) st.inc('timeouts');
      st.inc('fallbacks'); // = fell back to the deterministic score alone
      if (err.attempts && err.attempts[0] && err.attempts[0].provider === primaryName()) {
        st.inc('primary_failures');
        if (++breaker.fails >= BREAKER_FAILS) { breaker.openUntil = Date.now() + BREAKER_MS; st.inc('breaker_opened'); breaker.fails = 0; }
      }
      st.error(err);
    })
    .finally(() => {
      s.busy = false; inflight--;
      if (s.pending) runJudgment(id, s, traceId, ctx, st); // justification arrived mid-call
    });
}

const llmBehaviourScorer = defineModule({
  name: 'llm-behaviour-scorer',
  subscribes: ['signals.extracted', 'session.updated', 'risk.scored', 'wallet.checked'],
  onEvent(e, st, ctx) {
    const id = e.session_id;
    let s = judgeState.get(id);
    if (!s) { s = { signals: {}, checkout: {}, reasons: [], window_requests: 0, justification: null, det: 0, last: 0, busy: false }; judgeState.set(id, s); }
    if (judgeState.size > 2000) judgeState.delete(judgeState.keys().next().value);

    let trigger = false;
    let urgent = false; // new justification text must always be judged: it bypasses the throttle
    if (e.type === 'signals.extracted') s.signals = e.payload.signals;
    else if (e.type === 'session.updated') s.window_requests = e.payload.window_requests;
    else if (e.type === 'wallet.checked') {
      if (e.payload.amount != null) s.checkout = { amount: e.payload.amount, item: e.payload.item };
      if (e.payload.justification) { s.justification = e.payload.justification; trigger = urgent = true; }
    } else if (e.type === 'risk.scored') {
      if (e.payload.source === 'judgment') return;
      s.det = e.payload.deterministic ?? e.payload.score; // deterministic only, so agreement stays meaningful
      s.reasons = e.payload.det_reasons || e.payload.reasons || [];
      trigger = s.window_requests >= 3 || s.det >= 0.3;
    }
    if (!trigger || !ctx.bus) return;
    if (s.busy) { if (urgent) s.pending = true; return; } // rerun with the newest facts once the call returns
    if (!urgent && (inflight >= judgeDeps.maxInflight || Date.now() - s.last < judgeDeps.minGapMs)) return;
    runJudgment(id, s, e.trace_id, ctx, st);
  },
  custom: () => {
    const c = llmBehaviourScorer.rawCounters();
    const paired = (c.agree || 0) + (c.disagree || 0);
    return {
      primary: primaryName(),
      fallback: fallbackName(),
      keyed: !!(judgeDeps.key || judgeKey(primaryName())),
      breaker_open: Date.now() < breaker.openUntil,
      call_latency_ms: { p50: pctl(judgeLatency, 0.5), p95: pctl(judgeLatency, 0.95) },
      agreement_rate: paired ? +((c.agree || 0) / paired).toFixed(3) : null,
      budget_ms: judgeDeps.timeoutMs || judgment.budgetFor(primaryName()),
    };
  },
});

// 6. risk-router — combines deterministic + judgment + identity (raise-only); logic in ../router
const router = require('../router');
const lastScore = new Map();
const riskRouter = defineModule({
  name: 'risk-router',
  subscribes: ['route.decided', 'risk.scored', 'identity.classified'],
  onEvent(e, st) {
    if (e.type === 'identity.classified') { router.observe(e); return; }
    if (e.type === 'route.decided') {
      st.inc(`route_${String(e.payload.to).toLowerCase()}`);
      st.inc('decisions');
    } else if (e.type === 'risk.scored') {
      if (e.payload.source === 'judgment') { router.observe(e); return; }
      const prev = lastScore.get(e.session_id);
      if (prev !== undefined) st.inc('score_drift_total_x100', Math.round(Math.abs(e.payload.score - prev) * 100));
      lastScore.set(e.session_id, e.payload.score);
    } else if (e.type === 'decision') { // direct call from server.updateScore
      st.latency(e.latency_ms);
      st.inc('scored_final');
      for (const r of e.raisedBy) st.inc(`raised_by_${r}`);
    }
  },
});

// 7. quarantine-store — traffic diverted; real mutations from quarantined sessions must stay 0
const quarantineStore = defineModule({
  name: 'quarantine-store',
  subscribes: ['ingress.accepted', 'wallet.checked'],
  onEvent(e, st) {
    if (e.type === 'ingress.accepted' && e.payload.sandboxed) st.inc('requests_diverted');
    if (e.type === 'wallet.checked' && e.payload.decision === 'auto_allow' && e.payload.sandboxed) {
      st.inc('real_state_mutations'); // invariant: must stay 0
    }
    if (e.type === 'wallet.checked' && e.payload.decision === 'sandbox_blocked') st.inc('real_mutations_prevented');
  },
});

// 8. wallet-firewall
const walletFirewall = defineModule({
  name: 'wallet-firewall',
  subscribes: ['wallet.checked'],
  onEvent(e, st) {
    const { decision, amount } = e.payload;
    st.inc(decision);
    if (decision === 'auto_deny' || decision === 'sandbox_blocked') st.inc('dollars_blocked', Number(amount) || 0);
    if (decision === 'auto_allow') st.inc('dollars_allowed', Number(amount) || 0);
  },
});

// 9. approval-engine
const requestedAt = new Map();
const approvalEngine = defineModule({
  name: 'approval-engine',
  subscribes: ['approval.requested', 'approval.resolved'],
  onEvent(e, st) {
    const { hash, outcome } = e.payload;
    if (e.type === 'approval.requested') {
      st.inc('requested');
      requestedAt.set(hash, e.ts);
    } else {
      st.inc(outcome);
      const t0 = requestedAt.get(hash);
      if (t0 && (outcome === 'approved' || outcome === 'denied')) {
        st.inc('decision_ms_total', e.ts - t0);
        st.inc('decisions_timed');
        requestedAt.delete(hash);
      }
    }
  },
  custom: () => ({ pending: requestedAt.size }),
});

// 10. audit-log
const persistence = require('../persistence');
const auditLog = defineModule({
  name: 'audit-log',
  subscribes: ['audit.appended'],
  onEvent(e, st) {
    st.inc('events');
    st.inc(`type_${e.payload.type}`);
    st.set('last_seq', e.payload.seq);
  },
  custom: () => ({ persistence: persistence.stats() }),
  // Degraded when the database is failing and rows are backing up; the in-memory log keeps serving the UI.
  healthCheck: () => {
    const p = persistence.stats();
    return p.enabled && (p.queue_depth > 500 || (p.last_error && Date.now() - p.last_error.ts < 30_000)) ? 'degraded' : 'ok';
  },
});

// 14. dashboard-bridge — stats fed by the admin server's WebSocket handler
let clients = 0;
const dashboardBridge = defineModule({
  name: 'dashboard-bridge',
  subscribes: [],
  onEvent(e, st) {
    // Called directly by the admin WebSocket handler (not via the bus).
    if (e.type === 'ws.connected') { st.inc('connections'); clients++; }
    else if (e.type === 'ws.closed') clients = Math.max(0, clients - 1);
    else if (e.type === 'ws.push') { st.inc('pushes'); if (typeof e.latency_ms === 'number') st.latency(e.latency_ms); }
    st.set('connected_clients', clients);
  },
});

const all = [
  [ingress, 'built'],
  [sessionTracker, 'built'],
  [signalCollector, 'extend'],
  [identityClassifier, 'new'],
  [behaviourScorer, 'built'],
  [llmBehaviourScorer, 'new'],
  [riskRouter, 'extend'],
  [quarantineStore, 'built'],
  [walletFirewall, 'built'],
  [approvalEngine, 'built'],
  [auditLog, 'extend'],
  [dashboardBridge, 'extend'],
];

/** One throwaway call at boot so the first real session doesn't pay the ~1.3s cold-start (synthetic data only). */
function warmupJudge() {
  const facts = { path_sequence: ['search'], sequence_shape: 'browsing', window_requests: 1, reasons: [], justification: 'warmup' };
  const names = [primaryName(), fallbackName()].filter(Boolean);
  return Promise.all(names.map((provider) => {
    const key = judgeDeps.key || judgeKey(provider);
    if (provider !== 'classifier' && !key) return null;
    return judgment.judge(facts, { provider, key, fetchImpl: judgeDeps.fetchImpl, timeoutMs: 5000 }).catch(() => {});
  }));
}

module.exports = { all, ingress, dashboardBridge, riskRouter, judgeDeps, llmBehaviourScorer, warmupJudge, breaker };
// NOTE: `all` is [module, state] pairs consumed by registry.register().
