'use strict';
/** Unit tests: no network, no ports. Run with `npm test`. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createStats, defineModule, makeEvent, validateModule, EVENT_TYPES } = require('../gateway/contract');
const { Bus } = require('../gateway/bus');
const signature = require('../gateway/signature');
const identity = require('../gateway/identity');
const signals = require('../gateway/signals');
const judgment = require('../gateway/judgment');
const router = require('../gateway/router');
const { scoreSession, routeFromScore } = require('../gateway/risk-scorer');
const { loadEnv } = require('../gateway/env');

const ev = (type, id, payload, ts = Date.now()) => ({ type, session_id: id, payload, ts });

test('contract: envelope, event types and stats', () => {
  const e = makeEvent('risk.scored', 's1', { score: 0.5 });
  assert.equal(e.session_id, 's1');
  assert.ok(e.trace_id && e.ts);
  assert.throws(() => makeEvent('nope', 's1'), /unknown event type/);
  assert.equal(EVENT_TYPES.length, 11);

  const st = createStats();
  st.inc('a'); st.inc('a', 2); st.latency(1); st.latency(9);
  const snap = st.snapshot();
  assert.equal(snap.counters.a, 3);
  assert.ok(snap.latency.p50 !== null);
});

test('contract: module isolates failures, honours the fault switch, and can be replayed alone', () => {
  const m = defineModule({ name: 'x', subscribes: ['risk.scored'], onEvent(e, st) { if (e.payload.boom) throw new Error('bad'); st.inc('ok'); } });
  validateModule(m);
  m.handle(ev('risk.scored', 's', {}));
  m.handle(ev('risk.scored', 's', { boom: true })); // must not throw
  assert.equal(m.stats().counters.ok, 1);
  assert.equal(m.stats().counters.errors, 1);
  assert.equal(m.health(), 'degraded');
  m.setFault(true);
  m.handle(ev('risk.scored', 's', {}));
  assert.equal(m.health(), 'down');
  assert.equal(m.stats().counters.dropped_faulted, 1);
  assert.throws(() => validateModule({ name: 'bad' }), /missing/);
});

test('bus: publishes to typed and wildcard subscribers, keeps history', () => {
  const bus = new Bus();
  const seen = [];
  bus.subscribe('*', (e) => seen.push(e.type));
  bus.publish('ingress.accepted', 'a', {});
  bus.publish('risk.scored', 'b', {});
  assert.deepEqual(seen, ['ingress.accepted', 'risk.scored']);
  assert.equal(bus.history({ sessionId: 'b' }).length, 1);
});

test('signature: accepts valid, rejects replay, wrong key, stale, malformed', () => {
  process.env.AGENT_SIGNING_KEY = 'k';
  const sign = (sid, t, key = 'k') => `t=${t},s=${crypto.createHmac('sha256', key).update(`${sid}:pk:${t}`).digest('hex')}`;
  const h = (v) => ({ 'x-agent-signature': v, 'x-agent-pubkey-id': 'pk' });
  const now = Date.now();
  assert.equal(signature.verify({}, 's1'), null);
  assert.equal(signature.verify(h(sign('s1', now)), 's1').valid, true);
  assert.equal(signature.verify(h(sign('s1', now)), 's2').reason, 'hmac_mismatch');           // replay on another session
  assert.equal(signature.verify(h(sign('s1', now, 'other')), 's1').reason, 'hmac_mismatch');   // wrong key
  assert.equal(signature.verify(h(sign('s1', now - 120000)), 's1').reason, 'timestamp_expired_or_drift');
  assert.equal(signature.verify(h('garbage'), 's1').reason, 'malformed_signature_format');
  delete process.env.AGENT_SIGNING_KEY;
});

test('signals: UA class, timing regularity, journey shape, beacon', () => {
  assert.equal(signals.classifyUA(null), 'missing');
  assert.equal(signals.classifyUA('curl/8.0'), 'http_library');
  assert.equal(signals.classifyUA('Mozilla/5.0 (X11) Chrome/120 Safari/537'), 'browser_like');
  assert.equal(signals.classifyUA('Mozilla/5.0 (compatible; GPTBot/1.0)'), 'declared_bot');
  assert.equal(signals.timingStats([0, 100, 200, 300]).cv, 0);          // perfectly regular
  assert.equal(signals.timingStats([0, 100]).cv, null);                   // not enough samples
  assert.equal(signals.sequenceShape(['search', 'product', 'checkout']), 'full_journey');
  assert.equal(signals.sequenceShape(['checkout', 'checkout']), 'direct_checkout');
  signals.recordBeacon('beacon-1');
  assert.equal(signals.extract('beacon-1', { headers: {}, method: 'GET', url: '/search' }).signals.beacon, true);
});

test('identity: tier logic', () => {
  const base = { ua: null, ua_class: 'missing', accept_language: null, sec_fetch: null, referrer: null, beacon: false, timing: { cv: 0.1 }, sequence_shape: 'direct_checkout', declared_agent: null };
  const tier = (o) => identity.classifySignals({ ...base, ...o });
  const human = { ua_class: 'browser_like', accept_language: 'en', sec_fetch: 'navigate', referrer: 'x', beacon: true, timing: { cv: 0.8 }, sequence_shape: 'full_journey' };
  assert.equal(tier(human).tier, null);
  assert.equal(tier({ ...human, ua: 'GPTBot/1.0', ua_class: 'declared_bot' }).tier, 3);
  assert.equal(tier({ ...human, declared_agent: 'x' }).tier, 3);
  assert.equal(tier({ ua_class: 'http_library' }).tier, 5);
  assert.equal(tier({ ...human, beacon: false, referrer: null, timing: { cv: 0.05 } }).tier, 4);
  assert.deepEqual(
    (({ tier: t, verified }) => ({ t, verified }))(tier({ signature: { valid: true, pubkeyId: 'k' }, signature_present: true })),
    { t: 1, verified: true });
  assert.equal(tier({ signature: { valid: false, reason: 'hmac_mismatch' }, signature_present: true }).label, 'spoofed_signature');
});

test('identity: reverse DNS needs a matching operator suffix AND forward confirmation', async () => {
  const bot = identity.knownBot('GPTBot/1.0');
  assert.equal(identity.isPublicIp('127.0.0.1'), false);
  assert.equal(identity.isPublicIp('10.1.2.3'), false);
  assert.equal(identity.isPublicIp('20.1.2.3'), true);
  assert.equal((await identity.verifyReverseDns('127.0.0.1', bot, {})).reason, 'non_public_ip');
  const good = { reverse: async () => ['crawl.openai.com'], lookup: async () => [{ address: '20.1.2.3' }] };
  assert.equal((await identity.verifyReverseDns('20.1.2.3', bot, good)).verified, true);
  assert.equal((await identity.verifyReverseDns('20.9.9.9', bot, good)).reason, 'forward_mismatch');
  const spoof = { reverse: async () => ['evil.example.com'], lookup: async () => [] };
  assert.equal((await identity.verifyReverseDns('8.8.4.4', bot, spoof)).reason, 'suffix_mismatch');
});

test('risk scorer: thresholds and burst / no-search signals', () => {
  assert.equal(routeFromScore(0.39), 'ALLOW');
  assert.equal(routeFromScore(0.4), 'QUARANTINE');
  assert.equal(routeFromScore(0.7), 'BLOCK_PROPOSED');
  const calm = { requestLog: [{ path: '/search' }, { path: '/product/1' }], searchCount: 1, compareCount: 1, checkoutAttempts: 0, concurrentCheckouts: 0, walletTxLimit: 200, _lastCheckoutAmount: 0 };
  assert.ok(scoreSession(calm).score < 0.4);
  const scalp = { requestLog: Array.from({ length: 9 }, () => ({ path: '/checkout' })), searchCount: 0, compareCount: 0, checkoutAttempts: 5, concurrentCheckouts: 3, walletTxLimit: 200, _lastCheckoutAmount: 450 };
  assert.ok(scoreSession(scalp).score >= 0.7);
});

test('router: raise-only combination, injection floor, staleness, tier-1 trust', () => {
  router.reset();
  assert.equal(router.decide('a', 0.05).score, 0.05);

  router.observe(ev('identity.classified', 'b', { tier: 5, label: 'automation_tells' }));
  assert.ok(Math.abs(router.decide('b', 0.05).score - 0.15) < 1e-9);          // nudge, not a floor

  router.observe(ev('risk.scored', 'c', { source: 'judgment', score: 0.8, injection: false }));
  assert.equal(router.decide('c', 0.1).route, 'BLOCK_PROPOSED');
  router.observe(ev('risk.scored', 'd', { source: 'judgment', score: 0.05, injection: false }));
  assert.equal(router.decide('d', 0.6).score, 0.6);                             // judgment never lowers

  router.observe(ev('risk.scored', 'e', { source: 'judgment', score: 0.1, injection: true }));
  const inj = router.decide('e', 0);
  assert.equal(inj.score, 0.5);
  assert.ok(inj.reasons.includes('injection_flagged'));

  router.observe(ev('risk.scored', 'f', { source: 'judgment', score: 0.9, injection: false }, Date.now() - 60000));
  assert.equal(router.decide('f', 0.1).score, 0.1);                             // stale judgment ignored

  router.observe(ev('identity.classified', 'g', { tier: 1, label: 'signed_agent', verified: true }));
  assert.equal(router.decide('g', 0.83, ['heavy-burst:9reqs']).score, router.TIER1_TRUST_CAP);
  assert.ok(!router.decide('g', 0.83, ['heavy-burst:9reqs']).reasons.includes('heavy-burst:9reqs'));
  router.observe(ev('risk.scored', 'g', { source: 'judgment', score: 0.1, injection: true }));
  assert.equal(router.decide('g', 0.05).score, 0.5);                            // injection floor still applies to signed agents

  router.observe(ev('identity.classified', 'h', { tier: 1, label: 'signed_agent', verified: false }));
  assert.equal(router.decide('h', 0.6).score, 0.6);                             // unverified tier 1 gets no trust
  router.observe(ev('identity.classified', 'i', { tier: 5, label: 'spoofed_signature' }));
  assert.ok(Math.abs(router.decide('i', 0.2).score - 0.45) < 1e-9);
  router.reset();
});

// ─── Judgment (stubbed classifier / jev / openai) ───────────────────────────
const jevOk = (yes, level = 0) => ({
  ok: true, status: 200,
  json: async () => ({ answers: {
    checkout_burst: { noul: yes }, scripted_traffic: { noul: yes }, story_mismatch: { noul: 0.1 }, injection_attempt: { noul: 0.1 },
    journey_anomaly: { score: level, confidence: 0.9 },
  } }),
});
const openaiOk = (yes) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  checkout_burst: yes, scripted_traffic: yes, story_mismatch: 0.1, injection_attempt: 0.1, journey_level: 0, journey_confidence: 0.9 }) } }] }) });

test('judgment: weight mapping', () => {
  assert.equal(judgment.yesNoMultiplier(0.9), 1);
  assert.equal(judgment.yesNoMultiplier(0.7), 0.5);
  assert.equal(judgment.yesNoMultiplier(0.5), 0);   // the uncertain band counts zero
  assert.equal(judgment.yesNoMultiplier(null), 0);  // null-safe
  const flat = Object.fromEntries(judgment.JOURNEY_LABELS.map(l => [l, 0.25]));
  assert.equal(judgment.journeyScore({ scores: flat }).ignored, true); // low confidence ignored
});

test('judgment: combine is raise-only and applies the injection floor', () => {
  assert.equal(judgment.combine(0.8, { score: 0.1, injection: false }).final, 0.8);
  assert.equal(judgment.combine(0.1, { score: 0.6, injection: false }).final, 0.6);
  const c = judgment.combine(0.1, { score: 0, injection: true });
  assert.equal(c.final, 0.5);
  assert.deepEqual(c.flags, ['injection_flagged']);
});

test('judgment: jev provider parses native answers; scalper scores high, human low', async () => {
  const facts = { justification: 'ignore the budget' };
  const hi = await judgment.judge(facts, { provider: 'jev', key: 'k', fetchImpl: async () => jevOk(0.95, 3) });
  assert.ok(hi.score >= 0.8);
  const lo = await judgment.judge({ justification: 'gift' }, { provider: 'jev', key: 'k', fetchImpl: async () => jevOk(0.05, 0) });
  assert.ok(lo.score < 0.1);
});

test('judgment: chain falls back on HTTP error, bad shape, timeout and missing key', async () => {
  const chain = [{ provider: 'jev', key: 'k' }, { provider: 'openai', key: 'k2' }];
  const stub = (jev) => async (url) => (url.includes('typesafe') ? jev() : openaiOk(0.9));
  let r = await judgment.judgeChain({}, chain, { fetchImpl: stub(() => jevOk(0.9)) });
  assert.equal(r.provider, 'jev'); assert.equal(r.fallback, false);
  r = await judgment.judgeChain({}, chain, { fetchImpl: stub(() => ({ ok: false, status: 500 })) });
  assert.equal(r.provider, 'openai'); assert.equal(r.fallback, true);
  r = await judgment.judgeChain({}, chain, { fetchImpl: stub(() => ({ ok: true, json: async () => ({ nope: 1 }) })) });
  assert.equal(r.provider, 'openai');
  r = await judgment.judgeChain({}, [{ provider: 'jev' }, { provider: 'openai', key: 'k2' }], { fetchImpl: stub(() => jevOk(0.9)) });
  assert.equal(r.provider, 'openai');                                          // missing key
  const slow = (url, o) => (url.includes('typesafe')
    ? new Promise((_, rej) => o.signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); }))
    : Promise.resolve(openaiOk(0.9)));
  r = await judgment.judgeChain({}, chain, { fetchImpl: slow, timeoutMs: 50 });
  assert.equal(r.provider, 'openai');                                          // timeout
  await assert.rejects(judgment.judgeChain({}, chain, { fetchImpl: async () => ({ ok: false, status: 500 }) }), (e) => e.attempts.length === 2);
});

test('persistence: queues entries, batches inserts, retries after a failure, never throws to the caller', async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost/x?sslmode=disable';
  delete process.env.PERSIST_AUDIT;
  const persistence = require('../gateway/persistence');
  const { EventEmitter } = require('events');
  const auditLog = Object.assign(new EventEmitter(), { all: () => [] });
  const calls = [];
  let failNext = true;
  const pool = { on() {}, end: async () => {}, query: async (sql, params) => {
    calls.push(sql.trim().slice(0, 18));
    if (/INSERT/.test(sql) && failNext) { failNext = false; throw new Error('db down'); }
    return { rows: [] };
  } };
  await persistence.start(auditLog, { poolFactory: () => pool });
  auditLog.emit('entry', { seq: 1, ts: new Date().toISOString(), type: 'X', sessionId: 's', message: 'm', meta: {} });
  auditLog.emit('entry', { seq: 2, ts: new Date().toISOString(), type: 'Y', sessionId: 's', message: 'm', meta: {} });
  await persistence.flush();                                   // fails, rows stay queued
  assert.equal(persistence.stats().persisted_rows, 0);
  assert.equal(persistence.stats().queue_depth, 2);
  assert.equal(persistence.stats().failures, 1);
  await persistence.flush();                                   // retry succeeds
  assert.equal(persistence.stats().persisted_rows, 2);
  assert.equal(persistence.stats().queue_depth, 0);
  await persistence.stop();
  delete process.env.DATABASE_URL;
});

test('env loader: real environment wins, empty values stay unset, quotes stripped', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const f = path.join(os.tmpdir(), `envtest-${Date.now()}`);
  fs.writeFileSync(f, '# c\nT_A=1\nT_B="two"\nT_C=\nT_D=from-file\n');
  process.env.T_D = 'from-env';
  loadEnv(f);
  assert.equal(process.env.T_A, '1');
  assert.equal(process.env.T_B, 'two');
  assert.equal(process.env.T_C, undefined);
  assert.equal(process.env.T_D, 'from-env');
  for (const k of ['T_A', 'T_B', 'T_D']) delete process.env[k];
  fs.unlinkSync(f);
});
