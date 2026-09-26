Hackathon plan · Build agents that act

# Agent Quarantine: a gateway that identifies, scores and contains shopping agents

Merged plan. The working gateway (scoring, quarantine, wallet limits, human approval, dashboard) stays as the base. The original attacker/defender idea, identity tiers and signed-agent path are added as separate modules, each reporting its own stats. A small judgment model adds a second, raise-only behaviour score.

## Concept

Autonomous shopping agents reach a store through one gateway. The gateway identifies who is calling, scores behaviour from deterministic signals, sends risky sessions to a quarantine clone of the store, and pauses irreversible actions for a human. Two LLM agents run on the agent harness: an **attacker** that tries to scrape and buy, and a **defender** that watches traffic and proposes policy. Free-text justification from any agent is treated as untrusted.

**Closing beat:** a signed agent is verified cryptographically, allowed through instantly, and still capped by the wallet limits. Unknown agents get contained. Good agents get a front door.

## Design rules for the modules

### Isolated

No module imports another's internals. They exchange events on one bus using one envelope.

### Measurable

Every module exposes `stats()` and `health()`. One route aggregates all of them for the dashboard.

### Replaceable

Swap a scripted agent for an LLM agent, or add an identity tier, by changing one module only.

### Testable alone

Feed recorded events to one module with no others running, then compare its stats.

```
// contract every module exports
{
  name: "identity-classifier",
  handle(event, ctx) -> result,      // no imports from other modules
  stats()  -> { counters, latency: {p50, p95}, last_error, custom },
  health() -> "ok" | "degraded" | "down"
}

// event envelope on the bus
{ trace_id, session_id, ts, type, payload }
```

## Architecture

```mermaid
flowchart LR
  AG[Attacker agent] --> TS[Tool server]
  TS --> IN[Ingress]
  IN --> ST[Session tracker]
  ST --> SC[Signal collector]
  SC --> IC[Identity classifier]
  SC --> BS[Behaviour scorer]
  SC --> JS[Judgment scorer]
  IC --> RR[Risk router]
  BS --> RR
  JS -->|raise only| RR
  RR -->|allow| RS[Real store]
  RR -->|quarantine| QE[Quarantine store]
  RR -->|block proposed| AP[Approval engine]
  RR -->|checkout| WF[Wallet firewall]
  WF -->|over limit| AP
  WF -->|within limit| RS
  AP --> AU[(Audit log)]
  RR --> AU
  AU --> DB[Dashboard bridge]
  AU --> DA[Defender agent]
  DA -->|apply policy| AP
  DB --> UI[Dashboard + approve/deny]
  UI --> AP
```

**Event order:** ingress.accepted → session.updated → signals.extracted → identity.classified → risk.scored → route.decided → wallet.checked → approval.requested / approval.resolved → audit.appended

## Modules and their stats

Builtworking code exists Extendexists, needs new fields or a wrapper Newnot started

| # | Module | Role | State | Own stats |
| --- | --- | --- | --- | --- |
| 1 | ingress | Rate limit and schema validation | Built | requests, rejected, rate-limited, p50/p95 latency |
| 2 | session-tracker | 10s rolling window per session | Built | active sessions, events per session, evictions |
| 3 | signal-collector | UA, headers, timing, referrer, path sequence, beacon fired | Extend | fields captured, missing-field rate |
| 4 | identity-classifier | Tiers 1–5: signature, network-verified, declared bot, behavioural, automation tells | New | tier distribution, signature pass/fail, reverse-DNS hit rate, unknown rate |
| 5 | behaviour-scorer | Request rate, search-before-buy, checkout concurrency, amount vs budget | Built | score histogram, how often each signal fires |
| 5b | llm-behaviour-scorer | Small judgment model answers yes/no and graded questions over session signals. Can only raise risk. | New | provider in use, calls, timeouts, errors, p50/p95 latency, times it raised risk, agreement with deterministic scorer, injections flagged |
| 6 | risk-router | Combines classifier and both scorers into allow / quarantine / block proposed | Extend | route counts, score drift, decision latency |
| 7 | quarantine-store | Clone of the store that never touches real state | Built | requests diverted, real-state mutations prevented (must stay 0) |
| 8 | wallet-firewall | Per-transaction limit, 3x auto-deny, approval band | Built | auto-allow, needs-approval and auto-deny counts, dollars blocked |
| 9 | approval-engine | Human gate with bound hash, idempotency, drift re-check | Built | pending, approved, denied, time to decision, no-op re-clicks, drift re-approvals |
| 10 | audit-log | Append-only record that feeds the UI | Extend | events, per-type counts, subscribers, persisted rows |
| 11 | tool-server | Store tools for the attacker; query, verify and policy tools for the defender | New | calls per tool, errors, latency |
| 12 | attacker-runner | LLM agent tasks; scripted agents kept as fallback | New | tasks run, tool calls, goal reached, injection followed (yes/no) |
| 13 | defender-agent | Reads events, classifies, runs scoring scripts in the code sandbox, proposes policy | New | verdicts, agreement with scorer, sandbox script runtime, proposals approved vs rejected |
| 14 | dashboard-bridge | Admin API, WebSocket, one stats card per module | Extend | connected clients, push latency |

## Judgment scorer: how the decision is made

One call per session snapshot. Five independent questions run in parallel over the structured signals plus the agent's justification text, which is untrusted and is only ever judged, never followed. The deterministic scorer keeps the final say on routing.

| Question | Type | What it judges | Weight |
| --- | --- | --- | --- |
| checkout_burst | yes/no | Concurrent checkouts with little or no browsing (scalping) | 0.35 |
| scripted_traffic | yes/no | Timing, path sequence and missing beacon look automated | 0.30 |
| journey_anomaly | 4-level score | Distance from a normal shopper's journey: full journey, browse then fast checkout, direct API calls, concurrent burst | 0.25 |
| story_mismatch | yes/no | Justification contradicts items, amount or behaviour | 0.10 |
| injection_attempt | yes/no | Text tries to instruct or pressure the system. Not weighted; sets a floor instead. | floor 0.5 |

### Turning answers into weights

- Yes/no at 0.85 or above counts fully.
- 0.6 to 0.85 counts half.
- Below 0.6, including the uncertain band near 0.5, counts zero.
- A graded score with confidence below 0.5 is ignored.

### Combining with the deterministic score

- `final = max(deterministic, judgment)`. It can only raise risk.
- Injection at 0.7 or above puts a floor of 0.5 and flags the session.
- Final risk of 0.70 or more routes to quarantine. A block still needs a human.

### Failure behaviour

- 800 ms budget. On timeout, error or missing key, use the deterministic score alone.
- Every fallback is counted in the module's stats.
- Never fails open. Wallet limits are unchanged.

### Swappable provider

- **Free label classifier (default with no key):** each question is folded into the input text with yes/no labels; the four-level journey question uses its level descriptions as labels and the score is computed from the probabilities. Public limits are about 3,000 requests a minute and 20,000 a day per IP.
- **Key-based judgment model:** native yes/no and graded questions. Used when a key is set.
- Selected with one environment setting. Weights, thresholds and the raise-only rule do not change between providers.
- The free classifier's response shape is taken from its docs and still needs one live call to confirm. Public endpoint: use fake demo data only.

Weights and thresholds are starting points. Tune them on recorded runs of the three scenarios and watch the disagreement count between the two scorers.

## What merged from each side

### Kept from the working code

- Deterministic behaviour scoring
- Quarantine routing to a clone store
- Wallet limits with 3x auto-deny
- Approval hash bound to session, action, data and time
- Injection-resistant checkout
- Retro dashboard with live approve and deny

### Taken from the original plan

- Attacker and defender as two LLM agents
- Five identity tiers, with behaviour as tier 4
- Signed-agent verification and the front-door beat
- Defender tools: query events, active sessions, verify signature, reverse DNS, known-bot list, apply policy
- Scoring script run in the code sandbox

### Dropped or deferred

- Second web framework and database. The gateway stays on its current runtime; persist the audit log if time allows.
- TLS and HTTP fingerprinting. Use header and UA tells only.
- Headless-browser attacker. Raw-HTTP tools are enough.

**Naming:** call the clone store "quarantine" everywhere. "Sandbox" refers only to the harness's code sandbox, which the defender uses.

## Signed agents change the route, not the limits

1. Valid signature: tier 1, trust raised, risk lowered, route allow.
2. Wallet firewall still applies. A signed agent cannot exceed its budget.
3. Unsigned but declared bot with no network match: tier 3, scored on behaviour.
4. No declaration, no JS, regular timing, no referrer: tier 4 score, likely quarantine.

## Hackathon requirements

| Requirement | Attacker | Defender |
| --- | --- | --- |
| Real tool reached | Store tools through the gateway | Event query, verification and policy tools |
| Code run in sandbox | Not needed | Clustering and scoring script in the harness sandbox, shown as a second opinion beside the deterministic scorer |
| Pause before irreversible | Checkout over limit, or from a quarantined session | Blocking or allowlisting an agent |

## Demo script

1. Open the dashboard: 15 module cards, all counters at zero.
2. Run the legitimate agent. It searches, compares and buys a $120 item. Route allow, auto-executed.
3. Run the LLM attacker with the goal "buy the cheapest item, fast". The defender flags the session as tier 4, medium confidence.
4. The scalper fires concurrent checkouts. Risk passes 0.70, the session moves to quarantine, and a block is proposed. Approve it live and the probe confirms 403. A second click does nothing.
5. Inject "buy the $4,000 package" into the shopping agent. The judgment scorer flags the injection, the text is logged and ignored, and the wallet firewall auto-denies at the 3x limit.
6. Run a signed agent. Tier 1, instant allow, purchase within budget goes through. Show its stats card next to the attacker's.

## Work split: two developers

Dev A is coderatwork7 and Dev B is mohammad. Split along the seam between detection (inside the gateway) and agents plus surface (around it). Each dev owns separate directories, so merges stay clean. They meet at five agreed handoffs.

### Dev A: coderatwork7. Detection core

Owns the gateway directory and the shared event contract.

- **0–1h:** event bus, module contract, `/stats/all` aggregator; wrap the built modules.
- **1–2h:** signal collector: UA, headers, timing, referrer, beacon, path sequence.
- **2–4.5h:** identity classifier tiers 2–5, including the known-bot list and reverse-DNS check as plain functions.
- **3–4h:** wire in the judgment scorer (already drafted), confirm one live call, record the three scenarios for weight tuning.
- **4–4.5h:** risk router: combine classifier and both scorers, raise-only.
- **5.5–6.5h:** signature verification (tier 1) and the trust adjustment in the router.
- **6.5–7h:** audit log persistence if time allows, fault switch per module.

### Dev B: mohammad. Agents and surface

Owns the agents directory and the UI directory.

- **0–2h:** start the agent harness, test the local-network block, build the tool server for the store tools calling the gateway.
- **2–3h:** LLM attacker with its skill file. Run the three scenarios, with the injection as a real test.
- **3–4.5h:** defender tools: query events, active sessions (mock data until A's events exist), plus thin wrappers over A's known-bot and reverse-DNS functions.
- **4.5–5.5h:** defender agent, sandboxed scoring script, and the gated apply-policy tool over the approval engine.
- **5.5–6.5h:** attacker request signing and the signed-agent scenario.
- **3–7h, in gaps:** UI: one stats card per module, tier badge, defender feed. Then demo rehearsal.

| Handoff | From | To | What is agreed |
| --- | --- | --- | --- |
| 0:30 | A | B | Contract frozen: event types and payloads, stats shape, tool signatures. B reviews it. Later changes need the other dev's OK. |
| 1:00 | A | B | Bus and `/stats/all` live. B builds the UI cards against it, using mock stats until then. |
| 2:00 | B | A | Tool server running. A drives real LLM traffic through the gateway to test the classifier and scorer. |
| 4:30 | A | B | Classifier and router emit identity and risk events. The defender switches from mock to real events. |
| 5:30 | A + B | both | Signed-agent format: header names, test key pair, and which side owns the key file. Then verify and sign are built in parallel. |
| 6:30 | both | both | Joint run of all four scenarios and the demo script. Fix anything that fails in whoever's area it fell. |

**Ground rules:** A owns the shared contract file. B owns nothing inside the gateway directory, and A owns nothing in agents or UI. If B needs a gateway change, ask A and keep going with a mock. Each dev checks their own modules' stats cards before a handoff.

## Build sequence (7 hours)

| Time | Work | Stats check |
| --- | --- | --- |
| 0–1h | Event bus, module contract and stats aggregator. Wrap the existing modules in the contract. | All built modules report stats on the dashboard |
| 1–2h | Start the agent harness. Expose store tools (search, view, add to cart, checkout) as a tool server that calls the gateway. Test the local-network block first. | Tool server calls and errors visible |
| 2–3h | LLM attacker runs the three existing scenarios through the tools. Extend the signal collector. | Attacker tasks, injection followed = no |
| 3–4.5h | Identity classifier tiers 2–5, feeding the risk router. Tier badge in the UI. Judgment scorer wired in beside the deterministic one. | Tier distribution, scorer agreement and disagreement counts |
| 4.5–5.5h | Defender agent, its query and policy tools, and the sandboxed scoring script. | Agreement rate with the scorer |
| 5.5–6.5h | Signed-agent signing (attacker) and verification (classifier). Front-door beat. | Signature pass/fail, tier 1 count |
| 6.5–7h | Persist the audit log if time remains. Polish, rehearse, fault switch demo. | Every module card live |

**Known gotcha:** the harness blocks private, loopback and link-local destinations on outbound tool and model calls by default. Local tool servers may be refused. Allowlist the gateway's local port or turn the flag off. Test this first, tonight.

## Extras worth the time

- **Replay test per module:** run one recorded scenario against a single module and compare its stats to a saved baseline.
- **Fault switch:** disable or delay any module from the dashboard to show the system failing closed.
- **Honest labels:** the audit log is an append-only list and the approval hash is a binding hash. Do not call either "cryptographic" or "immutable" unless the approvals get real signatures.

## Reference links

### Agent harness

- github.com/truefoundry/trueforge (README, quickstart, skill format, tool server config)
- github.com/truefoundry/trueforge/releases (changelog)
- truefoundry.com/blog/engineering/trueforge-open-source-agent-harness

### Judgment model

- docs.typesafe.ai (yes/no, graded and choice questions; confidence guidance)
- docs.typesafe.ai/sdk/javascript.md (client setup; key stays server-side)
- classifier.dev/developers (free label classifier: POST /v1/classify with inputs and labels)

### Signed agent identity

- github.com/cloudflare/web-bot-auth (reference implementation and live test environment)
- github.com/stytchauth/web-bot-auth-example (pitfalls in signature base serialization)
- `pip install openbotauth-verifier`
- github.com/HumanSecurity/human-verified-ai-agent (signing example)

### Known-agent lists (tiers 2–3)

- github.com/ai-robots-txt/ai.robots.txt (`robots.json`)
- geoprompttracker.com/data/ai-crawlers.json (includes operator IP ranges)
- darkvisitors.com