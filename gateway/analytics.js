'use strict';
/**
 * Analytics: turns the audit log (the Case Book) into the numbers on the Scoreboard.
 * Pure: entries in, summary out. Works on the live in-memory log or on rows read back from Neon.
 *
 * Words used here (and on the Scoreboard):
 *   visitor   a distinct session that made at least one request
 *   caught    a visitor that, at any point, was worse than "cleared": held for questioning, arrest proposed, or blocked
 *   verdict   the WORST route a visitor reached: ALLOW < QUARANTINE < BLOCK_PROPOSED < BLOCKED
 * Money is in rupees (plain numbers).
 */

const RANK = { ALLOW: 0, QUARANTINE: 1, BLOCK_PROPOSED: 2, BLOCKED: 3 };
const VERDICTS = ['ALLOW', 'QUARANTINE', 'BLOCK_PROPOSED', 'BLOCKED'];

/** Who a session is, from its id (mirrors the dashboard's names). */
function whoIs(id) {
  const s = String(id || '');
  const w = (name) => new RegExp(`(^|[-_])${name}([-_]|$)`);   // the word anywhere in the id: "scalper-123", "e2e-scalper", "tout-demo-42"
  const rules = [[w('legit|regular|human'), 'The Regular'], [w('scalper|tout|chk'), 'The Ticket Tout'], [w('ambiguous|talker'), 'The Smooth Talker'], [w('headless|stealth'), 'The Robot Browser'],
    [w('signed'), 'The Badge-Holder'], [/inject/, 'The Smooth Talker (AI)'], [/(llm|tf)-attacker/, 'Undercover Crook'], [w('defender'), 'Good Cop']];
  for (const [re, name] of rules) if (re.test(s)) return name;
  return 'Other callers';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Pick a bucket width so the timeline has at most ~40 bars. */
function bucketMs(spanMs) {
  for (const w of [10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000, 6 * 3_600_000, 24 * 3_600_000]) if (spanMs / w <= 40) return w;
  return 24 * 3_600_000;
}

/**
 * @param {Array<{ts:string,type:string,sessionId:string,message?:string,meta?:object}>} entries oldest first
 * @param {{ recent?: number }} [opts]
 */
function summarize(entries, { recent = 25 } = {}) {
  const sessions = new Map();     // id → { id, who, worst, score, first, last, executed, held, refused, amounts... }
  const approvalsByHash = new Map();
  const money = { executed: { count: 0, amount: 0 }, heldForJudge: { count: 0, amount: 0 }, refusedOutright: { count: 0, amount: 0 },
    judgeApproved: { count: 0, amount: 0 }, judgeRefused: { count: 0, amount: 0 }, closedByPolicy: { count: 0, amount: 0 } };
  const judge = { pending: 0, approved: 0, refused: 0, closedByPolicy: 0, secondClicksIgnored: 0, cancelledStale: 0, decisionMsTotal: 0, decisionsTimed: 0 };
  const events = { total: entries.length, requests: 0, sweetTalkIgnored: 0, arrestsSigned: 0, doorsConfirmedShut: 0, heldForQuestioning: 0, arrestsProposed: 0 };
  let firstTs = null, lastTs = null;

  const sess = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, { id, who: whoIs(id), worst: 'ALLOW', score: 0, firstTs: null, lastTs: null, requests: 0,
        executed: 0, executedAmount: 0, heldAmount: 0, refusedAmount: 0, held: 0, refused: 0 });
    }
    return sessions.get(id);
  };
  const escalate = (s, route) => { if ((RANK[route] ?? -1) > RANK[s.worst]) s.worst = route; };

  const timeline = [];
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t)) { if (firstTs === null || t < firstTs) firstTs = t; if (lastTs === null || t > lastTs) lastTs = t; }
    const m = e.meta || {};
    const id = e.sessionId;
    const isSession = id && id !== 'gateway' && id !== 'invalid';
    const s = isSession ? sess(id) : null;
    if (s) { s.firstTs = s.firstTs ?? t; s.lastTs = t; }

    switch (e.type) {
      case 'TOOL_CALL': events.requests++; if (s) s.requests++; break;
      case 'RISK': if (s) { escalate(s, m.route); s.score = Math.max(s.score, num(m.score)); } break;
      case 'SANDBOX': events.heldForQuestioning++; if (s) escalate(s, 'QUARANTINE'); timeline.push({ t, k: 'caught' }); break;
      case 'BLOCK_PROPOSED': events.arrestsProposed++; if (s) escalate(s, 'BLOCK_PROPOSED'); timeline.push({ t, k: 'caught' }); break;
      case 'BLOCK_APPLIED': events.arrestsSigned++; if (s) escalate(s, 'BLOCKED'); break;
      case 'VERIFIED': events.doorsConfirmedShut++; break;
      case 'UNTRUSTED_INPUT_IGNORED': events.sweetTalkIgnored++; break;
      case 'CHECKOUT_EXECUTED': {
        const a = num(m.amount); money.executed.count++; money.executed.amount += a;
        if (s) { s.executed++; s.executedAmount += a; }
        timeline.push({ t, k: 'cleared' }); break;
      }
      case 'WALLET_APPROVAL_REQUIRED': {
        const a = num(m.amount); money.heldForJudge.count++; money.heldForJudge.amount += a;
        if (s) { s.held++; s.heldAmount += a; }
        timeline.push({ t, k: 'held' }); break;
      }
      case 'WALLET_AUTO_DENIED': {
        const a = num(m.amount); money.refusedOutright.count++; money.refusedOutright.amount += a;
        if (s) { s.refused++; s.refusedAmount += a; }
        timeline.push({ t, k: 'refused' }); break;
      }
      case 'APPROVAL_PENDING':
        approvalsByHash.set(m.hash, { action: m.action, amount: num(m.actionData && m.actionData.amount), ts: t });
        judge.pending++; break;
      case 'APPROVED': {
        judge.approved++;
        const p = approvalsByHash.get(m.hash);
        if (p) { judge.decisionMsTotal += t - p.ts; judge.decisionsTimed++; }
        if (m.action === 'WALLET_CHECKOUT' || (p && p.action === 'WALLET_CHECKOUT')) {
          money.judgeApproved.count++; money.judgeApproved.amount += num(m.actionData && m.actionData.amount) || (p ? p.amount : 0);
        }
        break;
      }
      case 'DENIED': {
        const p = approvalsByHash.get(m.hash);
        const byPolicy = /by policy/.test(e.message || '');
        if (byPolicy) { judge.closedByPolicy++; if (p && p.action === 'WALLET_CHECKOUT') { money.closedByPolicy.count++; money.closedByPolicy.amount += p.amount; } }
        else {
          judge.refused++;
          if (p) { judge.decisionMsTotal += t - p.ts; judge.decisionsTimed++; }
          if (p && p.action === 'WALLET_CHECKOUT') { money.judgeRefused.count++; money.judgeRefused.amount += p.amount; }
        }
        break;
      }
      case 'IDEMPOTENCY_GUARD': judge.secondClicksIgnored++; break;
      case 'REVALIDATION_REQUIRED': judge.cancelledStale++; break;
      default: break;
    }
  }

  // ─ per-visitor verdicts ─
  const all = [...sessions.values()];
  const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const byWho = new Map();
  for (const s of all) {
    if (s.requests === 0 && s.executed === 0 && s.held === 0 && s.refused === 0) continue; // never made a request (e.g. only referenced by the gateway)
    byVerdict[s.worst]++;
    const w = byWho.get(s.who) || { who: s.who, visitors: 0, caught: 0, cleared: 0, spent: 0, refused: 0 };
    w.visitors++; if (s.worst === 'ALLOW') w.cleared++; else w.caught++;
    w.spent += s.executedAmount; w.refused += s.refusedAmount;
    byWho.set(s.who, w);
  }
  const visitors = Object.values(byVerdict).reduce((a, b) => a + b, 0);
  const caught = visitors - byVerdict.ALLOW;

  // ─ timeline ─
  let buckets = [];
  let width = 0;
  if (timeline.length && firstTs !== null) {
    width = bucketMs(Math.max(1, lastTs - firstTs));
    const start = Math.floor(firstTs / width) * width;
    const n = Math.floor((lastTs - start) / width) + 1;
    buckets = Array.from({ length: n }, (_, i) => ({ t: start + i * width, cleared: 0, held: 0, refused: 0, caught: 0 }));
    for (const ev of timeline) buckets[Math.floor((ev.t - start) / width)][ev.k]++;
  }

  const kept = money.refusedOutright.amount + money.judgeRefused.amount + money.closedByPolicy.amount;
  return {
    generatedAt: new Date().toISOString(),
    span: { from: firstTs ? new Date(firstTs).toISOString() : null, to: lastTs ? new Date(lastTs).toISOString() : null },
    headline: {
      visitors, caught, cleared: byVerdict.ALLOW,
      caughtPercent: visitors ? Math.round((caught / visitors) * 100) : 0,
      arrestsSigned: events.arrestsSigned, sweetTalkIgnored: events.sweetTalkIgnored,
      moneyExecuted: money.executed.amount, moneyKeptSafe: kept,
    },
    verdicts: byVerdict,
    money: { ...money, keptSafe: kept },
    judge: {
      ...judge,
      avgDecisionSeconds: judge.decisionsTimed ? +(judge.decisionMsTotal / judge.decisionsTimed / 1000).toFixed(1) : null,
    },
    events,
    byWho: [...byWho.values()].sort((a, b) => b.visitors - a.visitors),
    timeline: { bucketMs: width, buckets },
    recent: all
      .filter((s) => s.requests || s.executed || s.held || s.refused)
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .slice(0, recent)
      .map((s) => ({ id: s.id, who: s.who, verdict: s.worst, threat: Math.round(s.score * 100), requests: s.requests,
        executed: s.executed, executedAmount: s.executedAmount, held: s.held, heldAmount: s.heldAmount, refused: s.refused, refusedAmount: s.refusedAmount,
        last: s.lastTs ? new Date(s.lastTs).toISOString() : null })),
  };
}

module.exports = { summarize, whoIs, bucketMs, VERDICTS };
