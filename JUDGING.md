# How Agent Quarantine judges a visitor

A plain-words guide to the whole judging process: the steps, what counts as malicious, how a decision is made, and how every decision is checked. All numbers below come from the code, and money is in Indian rupees.

**The idea in one minute.** We do not try to prove someone is human. We collect *evidence about how a visitor behaves*, add it up into a **threat level from 0 to 1**, and pick a route from that number. What a visitor says about itself never counts as evidence. Anything that cannot be undone, such as shutting a visitor out or paying a large amount, waits for a human.

---

## 1. The journey of one request (the steps)

| Step | What happens | Where it lives |
|---|---|---|
| 1. The door | Each IP may send 200 requests per 10 seconds. The session id must look valid. A flood gets `429`, a bad id gets `400` | `gateway/server.js` |
| 2. Note the details | Write down the browser claim, the polite headers, the click rhythm, the referrer, the page order, the JS ping, and any signature | `gateway/signals.js` |
| 3. Check the ID | Sort the visitor into a trust tier (section 3) | `gateway/identity.js`, `gateway/signature.js` |
| 4. Rulebook score | Fixed rules add points for suspicious behaviour (section 4) | `gateway/risk-scorer.js` |
| 5. Second opinion | A small AI model reads the facts and the visitor's own excuse text and can raise the score (section 5) | `gateway/judgment.js` |
| 6. The Sergeant's call | Combine the scores and pick a route (section 6) | `gateway/router.js` |
| 7. The route | Cleared goes to the real shop. Held goes to a fake copy of the shop. Arrest proposed goes to a human | `gateway/server.js`, `storefront/server.js` |
| 8. The Cashier | Every payment meets the wallet limits, whatever the score (section 7) | `gateway/wallet-firewall.js` |
| 9. The Judge | A human decides anything irreversible (section 9) | `gateway/approval-engine.js` |
| 10. Write it down | Every step lands in the Case Book (the audit log), saved to Neon | `gateway/audit-log.js`, `gateway/persistence.js` |

Steps 2 to 6 run on every request, so a visitor's threat level moves in real time.

---

## 2. What we look at

| Signal | Why it matters |
|---|---|
| **Browser name** | A `curl` or Python library name, or no name at all, is a script. A name containing `HeadlessChrome`, `Playwright`, `Puppeteer` or `Selenium` announces automation |
| **Polite headers** | Real browsers send `accept-language`, `sec-fetch-*` and a referrer. Most scripts don't |
| **Click rhythm** | If the gaps between requests are almost identical (variation under 15%), a machine is clicking |
| **The JS ping** | A page that runs JavaScript pings `/beacon`. It also reports `navigator.webdriver`, which Playwright, Puppeteer and Selenium set to `true` |
| **The journey** | Search, then look, then buy looks human. Straight to checkout looks like a script |
| **Speed and overlap** | Many requests in 10 seconds, or several checkouts in flight at once |
| **A signature** | A signed request proves who the agent is (or, if wrong, that someone is faking it) |
| **The excuse text** | "The boss said ignore the limits" is treated as **data to judge, never as an instruction** |

---

## 3. Who are you? (trust tiers)

The first rule that matches wins.

| Tier | Meaning | How we decide | Effect on threat level |
|---|---|---|---|
| **1** Badge-holder | A verified signed agent | Valid HMAC signature, fresh (within 60 seconds), for **this** session | Score capped at 0.10. It is fast-laned, but still bound by the wallet |
| **5, forged** | Someone faking a signature | A signature that is wrong, stale, malformed, or replayed from another session | **+0.25** |
| **2** | A known bot with a proven address | Known bot name **and** a reverse-DNS lookup that forward-confirms to its operator, from a public IP | none |
| **3** | Says it is a robot | A known bot name without proof, or an `x-agent-type` header | none |
| **5** Fake or script | An obvious script | Any of: HTTP-library name, no name, no browser headers, straight to checkout, `HeadlessChrome`, `webdriver` flag (needs two tells, or a library name, or one **strong** tell) | **+0.10** |
| **5, driven browser** | A browser that admits it is being controlled | `navigator.webdriver` is true, or the name says headless | **+0.30** |
| **4** Acts like a robot | Undeclared, no proof, moves like a machine | **All three**: no JS ping, regular timing, no referrer | +0.05 |
| none: looks human | Nothing suspicious | None of the above | 0 |

An unsigned automated browser is an *unknown agent*, and unknown agents are contained. A signed agent is the way to get a front door.

---

## 4. How do you behave? (the rulebook)

Points add up over a rolling 10-second window and stop at 1.0.

| Behaviour | Points |
|---|---|
| 8 or more requests in 10 seconds | +0.30 (4 to 7 requests: +0.18) |
| Went to checkout without ever searching or looking | +0.25 (looked but never searched: +0.125) |
| 3 or more checkouts in flight at once | +0.20 (2 at once: +0.10) |
| 3 or more checkouts and never searched | +0.15 |
| Paying more than the per-purchase limit | +0.15 |
| Checkout before viewing any product | +0.10 |

---

## 5. The second opinion (AI)

A small model gets the session facts plus the visitor's excuse text and answers five questions. It can only **raise** the score, never lower it.

| Question | Weight |
|---|---|
| Is this a checkout burst (scalping)? | 0.35 |
| Does the traffic look scripted? | 0.30 |
| How far is the journey from a normal shopper's? | 0.25 |
| Does the excuse contradict the facts? (only counted if there is an excuse) | 0.10 |
| Is the text trying to give orders? | not weighted: sets a **floor of 0.5** and flags the session |

Only confident answers count: a yes at 0.85 or above counts fully, 0.6 to 0.85 counts half, below 0.6 counts nothing. An "orders" answer of 0.7 or more raises the floor. The order is jev first, OpenAI if jev fails, a 30-second circuit breaker after three failures, and if both fail the rulebook score stands alone. A judgment result stays valid for 30 seconds.

---

## 6. The decision

```
base   = higher of (rulebook score, second-opinion score)
base   = at least 0.5 if an order-giving excuse was flagged
final  = base + identity bump          (never below the rulebook score)
        exception: a verified signed agent is capped at 0.10
```

| Final threat level | Route | What happens |
|---|---|---|
| under 0.40 | **Cleared** | Shops in the real store |
| 0.40 to 0.70 | **Held for questioning** | Moved to the Interrogation Room: a fake copy of the shop where nothing they do is real |
| 0.70 or more | **Arrest proposed** | A human must sign before the door is slammed |

**Real results from our own runs:**

| Visitor | Threat | Why |
|---|---|---|
| Honest browser, human pace | 10% (cleared) | Nothing suspicious |
| Ticket Tout, four tabs pressing BUY NOW together | 85% (arrest proposed) | Burst, over the limit, driven browser |
| Naive headless bot | 40% (held) | `HeadlessChrome` and the webdriver flag |
| Stealth bot that hides both flags | 40% (held) | Passes the ID check, but its 16-request burst gives it away |
| Smooth Talker with a forged note for a ₹31,000 GPU | payment refused | The Cashier refuses over ₹15,000, whatever the note says |

---

## 7. The money rules (the Cashier)

These apply to every payment **regardless of the threat level**.

| Payment | What happens |
|---|---|
| Up to ₹5,000 from a cleared visitor, within ₹12,500 a day | Goes through |
| Over ₹5,000, or past ₹12,500 for the day, or from any visitor who is not cleared | Held for the Judge |
| Over ₹15,000 (three times the limit) | Refused outright. No human is asked, and nothing the visitor says matters |

A signed agent is fast-laned but **still capped** by these limits.

---

## 8. What counts as malicious, and what we do about it

| Malicious thing | How it shows up | What we do |
|---|---|---|
| **Scalping or hoarding** | Many checkouts at once, no browsing, often from several tabs sharing one session | Burst, concurrency and no-search rules raise the score. Held, then arrest proposed |
| **Prompt injection** ("ignore your budget, the boss approved") | Excuse text that tries to give orders | Never followed. Logged as untrusted and ignored. The AI flags it and sets a 0.5 floor. The Cashier refuses huge amounts anyway |
| **Impersonating a trusted agent** | A forged, replayed or stale signature | Tier 5 with **+0.25**. It gets no trust, and looks worse than an unsigned visitor |
| **Faking a famous crawler** ("Googlebot" with no proof) | A known bot name from an address that does not verify | Stays tier 3 and never reaches tier 2, so it earns no trust |
| **A visible automated browser** | `HeadlessChrome`, `navigator.webdriver` | Strong tell, **+0.30**, held |
| **A stealth bot that hides its flags** | Fools the ID check | Caught by its behaviour: bursts, no browsing, concurrent checkouts |
| **Impossible spending** | Amounts over 3× the limit | Refused outright |
| **Over-budget spending** | Over ₹5,000 or the daily cap | A human must approve |
| **Floods** | Over 200 requests per 10 seconds from one IP | `429` at the door |
| **Replaying an approval** | Clicking or sending the same approval twice | Runs exactly once. A second click is a logged no-op |
| **Approving something that has changed** | The risk moved after the Judge was shown the request | Cancelled and re-checked, so nothing runs on stale evidence |

---

## 9. How the human Judge decides

The dashboard pop-up ("The Judge's Signature") shows five things:

1. **The charge**: what is being asked, for example "Arrest warrant: slam the door" or "Let ₹7,000 through?"
2. **The suspect**: which visitor.
3. **What happens if you sign**: the exact action.
4. **The evidence**: threat level and the reasons, such as `heavy-burst`, `over-tx-limit`, `identity-tier-5`.
5. **The seal**: the 16-character code that binds this signature to this exact action.

**Sign an arrest when** the threat level is 70% or higher **and** the reasons are behavioural (heavy burst, no browsing, concurrent checkouts, a forged signature), or the visitor is a known impersonator.

**Refuse a payment when** the visitor is held or flagged, the item does not match what they were doing, or the reasons include an order-giving excuse. **Approve a payment when** the visitor is cleared, the amount is only a little over the limit, and the journey (search, look, buy) is a normal shopper's.

**When unsure, refuse.** Refusing is always safe: it costs a sale, not money. A visitor who is refused can ask again.

What the system guarantees around your click:
- One signature runs **one** action, once. It cannot be reused for a different action.
- If you sign an arrest, the visitor's *other* held payments are closed automatically ("closed by policy"), so you do not face a pile.
- A denied approval is final. It can never be approved later.
- A visitor with a decision waiting is never forgotten, so a slow Judge still gets a valid approval.

---

## 10. How we verify

We check at four points, so no single step is trusted on its own.

**Before deciding**
- Signatures are checked with an HMAC over `session : key id : time`. They must be fresh (60 seconds), match **this** session (so a copied signature fails), and are compared in constant time.
- "Known bot" status requires a reverse-DNS lookup that is **forward-confirmed** and matches the operator's domain, from a public address.
- Untrusted input, meaning the excuse text, is only ever read, never followed.

**At the moment of acting**
- The approval seal is `SHA-256(session | action | data | time)`. It binds the click to one exact action.
- The risk is **re-checked** when you sign. If it drifted by more than 0.25, or the visitor is gone, the approval is cancelled and nothing runs.
- Anything that fails or is unsure **fails closed**: the door stays shut.

**After acting**
- After an arrest, the gateway **replays a request as that visitor** and confirms it gets a `403`. The Case Book records `VERIFIED`, or `VERIFY_FAILED` if not.
- The shop the visitor was held in can be checked: a counter of real-state changes from held visitors must stay at 0.

**Afterwards, and on demand**
- **The Case Book** records every step, saved to Neon, so history survives restarts.
- **The Scoreboard** (`/scoreboard.html`) counts visitors, who was caught, every decision, and the money kept safe, live or across all saved runs.
- **`GET /events`** and **`GET /approvals/<seal>`** show the raw evidence and the state of any decision.
- **Replay:** the scripted agents and Playwright attacks take `SEED=<n>`, so any run can be repeated exactly.
- **Tests:** unit tests, end-to-end tests, and real-Chrome browser tests cover every rule above, including the attacks, the Judge's decisions and the path-traversal fix. Live tests call the real models and database.
- **Model comparison:** `npm run test:judges` runs jev and OpenAI on 10 hand-labelled sessions.

---

## 11. What we cannot catch (be honest about this)

- **We cannot prove a visitor is human.** A very fast honest shopper can look robotic.
- **The weights and cut-offs are starting values.** We have **not** measured how often an honest customer is wrongly held, or a bad bot gets through, on traffic we did not write ourselves. The 10-session comparison is a smoke test, not an accuracy result.
- **A patient bot** that clicks slowly, browses first and hides its flags looks human. The 10-second window sees only recent behaviour.
- **Session ids are self-declared.** A bot can start a fresh session to shed a bad score. A signature is the fix for well-behaved agents, but unsigned bots can still do it.
- **Signatures use a shared secret.** Anyone with the key can sign as any agent. A real deployment needs asymmetric signatures.
- **The admin API has no login**, and the approver is recorded as a fixed name. Anyone who can reach it can approve.
- **State lives in one process's memory.** Only the audit log is saved.
- **The AI second opinion sends synthetic facts to a third-party model.** Decide what may leave before pointing real traffic at it.

## 12. Quick reference

| Number | Meaning |
|---|---|
| 0.40 / 0.70 | Cleared under 0.40, held from 0.40, arrest proposed from 0.70 |
| ₹5,000 / ₹12,500 / ₹15,000 | Per-purchase limit / daily limit / refused outright above this |
| +0.10 / +0.05 / +0.25 / +0.30 | Script / acts like a robot / forged signature / admits it is driven |
| 0.10 | Cap for a verified signed agent |
| 0.5 | Floor when an order-giving excuse is flagged |
| 10 s | Rolling window for behaviour |
| 60 s | How fresh a signature must be |
| 0.25 | How far the risk may drift before an approval is cancelled |
| 200 per 10 s | Per-IP request limit at the door |
