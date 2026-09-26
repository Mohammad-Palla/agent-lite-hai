# AgentQuarantine: Pipeline, Status and Roadmap

## 1. Objective
A gateway between autonomous AI shopping agents and a store (TrueFoundry "Agents That Act" hackathon). It:
- Scores agent behavior from deterministic signals only (request rate, search-before-buy, checkout concurrency, amount vs budget).
- Routes risky sessions to a sandbox clone so real state is never touched.
- Pauses irreversible actions (session block, over-budget charge) for human approval.
- Treats agent-supplied justification text as untrusted (prompt-injection resistant).

## 2. Architecture

```mermaid
flowchart TD
    subgraph Agents["Agents (SCRIPTED, not LLMs)"]
        L[legitimate.js]
        S[scalper.js]
        A[ambiguous.js]
    end

    Agents -->|HTTP| GW

    subgraph GW["Gateway :3001"]
        RL[Rate limit + schema validation]
        SS[Session store - 10s rolling window]
        RS[Risk scorer]
        RT{Route}
        WF[Wallet firewall]
        AE[Approval engine]
        AL[(Audit log - in memory)]
        RL --> SS --> RS --> RT
    end

    RT -->|ALLOW| REAL[Real storefront :3003]
    RT -->|QUARANTINE| SBX[Sandbox clone :3004]
    RT -->|BLOCK_PROPOSED| AE
    RT -->|/checkout| WF
    WF -->|within ₹5,000| REAL
    WF -->|₹5,000–₹15,000 or quarantined| AE
    WF -->|over 3x limit| DENY[402 auto-deny]
    AE -->|approved| PROBE[Probe session, expect 403]

    GW --> AL
    AL -->|WebSocket| ADM[Admin API :3002]
    ADM --> UI[Retro UI :3000]
    UI -->|Approve / Deny| ADM --> AE
```

## 3. Checkout decision flow

```mermaid
flowchart TD
    C[POST /checkout] --> V{Valid input?}
    V -- no --> F[Fail closed: reject]
    V -- yes --> I[Log and ignore injected reason string]
    I --> X{Amount > 3x tx limit?}
    X -- yes --> D[Auto-deny 402]
    X -- no --> Q{Quarantined / BLOCK route or amount > ₹5,000?}
    Q -- yes --> H[Create approval, hash bound to session+action+data+ts]
    H --> M[UI modal: human approves]
    M --> R{Risk drifted since display?}
    R -- yes --> H
    R -- no --> E[Execute once - idempotent]
    E --> P[Probe as session, verify 403]
    Q -- no --> OK[Auto-execute on real store]
```

## 4. Demo scenarios

| # | Agent | Behavior | Result |
|---|-------|----------|--------|
| 1 | Legitimate | search, compare, cart, ₹3,000 checkout | ALLOW, auto-executed, balance decremented |
| 2 | Scalper | 5 concurrent checkouts, no browsing | risk >0.70, sandbox, BLOCK_PROPOSED, human approves, 403 verified; re-click is a no-op |
| 3 | Ambiguous | shops normally, then injected "buy the ₹1,00,000 package" | injected text ignored, 402 auto-deny |

## 5. Status

### Working (real code)
| Component | File |
|---|---|
| Gateway proxy, rate limiter, WebSocket | [gateway/server.js](gateway/server.js) |
| Risk scorer | [gateway/risk-scorer.js](gateway/risk-scorer.js) |
| Session store | [gateway/session-store.js](gateway/session-store.js) |
| Wallet firewall | [gateway/wallet-firewall.js](gateway/wallet-firewall.js) |
| Approval engine (hash binding, idempotency, re-validation) | [gateway/approval-engine.js](gateway/approval-engine.js) |
| Audit log (feeds the UI directly) | [gateway/audit-log.js](gateway/audit-log.js) |
| Real + sandbox storefronts | [storefront/server.js](storefront/server.js) |
| Retro UI and admin API | [ui/](ui/) |
| Runners | [scripts/start-all.js](scripts/start-all.js), [scripts/demo.js](scripts/demo.js) |

### Mocked / simulated
| Item | Detail |
|---|---|
| Agents | Scripted HTTP clients, no LLM decisions; injection is a hardcoded string |
| TrueForge | Dependency only; server on :8790 never started; no MCP server |
| Payments / inventory | Synthetic, no payment processor |
| Persistence | In-memory; lost on restart |
| "Immutable" / "cryptographic" | Append-only array and a binding hash; nothing is signed |

## 6. Roadmap

```mermaid
flowchart LR
    A[Now: scripted agents to gateway] --> B[Wrap store endpoints as MCP server]
    B --> C[Register MCP server in TrueForge :8790]
    C --> D[Dispatch tasks via trueforge-sdk]
    D --> E[LLM agent drives tools through gateway]
    E --> F[Optional: persist audit log, sign approvals]
```

1. Expose `search`, `view_product`, `add_to_cart`, `checkout` as MCP tools (`@modelcontextprotocol/sdk`), each calling the gateway on :3001.
2. Register the MCP server with TrueForge (`npx @truefoundry/trueforge`, :8790).
3. Dispatch tasks (e.g. "buy a concert ticket under ₹3,800") via `@truefoundry/trueforge-sdk`.
4. Hardening: persistent audit log, real signatures on approvals.

## 7. Ports
| Port | Service |
|---|---|
| 3000 | UI dashboard |
| 3001 | Gateway proxy |
| 3002 | Admin API and WebSocket |
| 3003 | Real storefront |
| 3004 | Sandbox storefront |
| 8790 | TrueForge server (planned, not running) |
