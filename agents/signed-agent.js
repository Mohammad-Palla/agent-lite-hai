'use strict';
const { fmt } = require('../gateway/currency');
/**
 * Signed Agent — tier-1 identity shopping agent with HMAC request signing.
 *
 * This agent signs every request with:
 *   Header: x-agent-signature: t=<unix_ms>,s=<hmac-sha256-hex>
 *   Header: x-agent-pubkey-id: <key-id>
 *
 * The gateway identity-classifier reads these headers and (when Dev A's
 * tier-1 verification is wired in) grants tier-1 trust: instant ALLOW,
 * skips quarantine check, but wallet firewall still applies.
 *
 * Demo flow: search → compare → buy a ₹3,000 concert ticket.
 * Expected: ALLOW route, tier-1 in logs, purchase executes.
 */

const http = require('http');
const { createHmac } = require('crypto');

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const SESSION_ID = process.env.SESSION_ID || `signed-${Date.now()}`;
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT) || 3001;

// ─── Signing key (in real use, loaded from secure key store) ──────────────────
const AGENT_SIGNING_KEY = process.env.AGENT_SIGNING_KEY || 'demo-private-key-for-hackathon-2026';
const AGENT_PUBKEY_ID = 'agent-quarantine-attacker-v1';

function signRequest(sessionId, timestamp) {
  // Signature scheme: HMAC-SHA256 over "<sessionId>:<pubkeyId>:<timestamp>"
  const payload = `${sessionId}:${AGENT_PUBKEY_ID}:${timestamp}`;
  const sig = createHmac('sha256', AGENT_SIGNING_KEY).update(payload).digest('hex');
  return `t=${timestamp},s=${sig}`;
}

// ─── HTTP request helper with signing ────────────────────────────────────────
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const timestamp = Date.now();
    const signature = signRequest(SESSION_ID, timestamp);

    const options = {
      hostname: 'localhost',
      port: GATEWAY_PORT,
      path,
      method,
      headers: {
        'x-session-id': SESSION_ID,
        'x-agent-type': 'signed',
        'x-agent-pubkey-id': AGENT_PUBKEY_ID,
        'x-agent-signature': signature,
        'content-type': 'application/json',
        'content-length': data ? Buffer.byteLength(data) : 0,
      },
    };

    const request = http.request(options, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (_) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log(`\n[SIGNED] ═══════════════════════════════════════════════`);
  console.log(`[SIGNED]  Signed Agent — Tier 1 Identity`);
  console.log(`[SIGNED]  Session: ${SESSION_ID}`);
  console.log(`[SIGNED]  Key ID:  ${AGENT_PUBKEY_ID}`);
  console.log(`[SIGNED]  Signing key: ${AGENT_SIGNING_KEY.slice(0, 8)}...`);
  console.log(`[SIGNED] ═══════════════════════════════════════════════\n`);

  // Step 1: Search
  console.log('[SIGNED] Step 1: Searching for concert tickets...');
  const search = await req('GET', '/search?q=concert');
  const items = (search.body && search.body.results) || [];
  console.log(`[SIGNED]   Found ${items.length} items. Signature sent with request.`);
  await sleep(1000);

  // Step 2: View product (compare)
  console.log('[SIGNED] Step 2: Viewing Concert Ticket (1001)...');
  const product = await req('GET', '/product/1001');
  const p = product.body && product.body.product;
  if (p) console.log(`[SIGNED]   ${p.name} — ${fmt(p.price)}`);
  await sleep(800);

  // Step 3: Add to cart
  console.log('[SIGNED] Step 3: Adding to cart...');
  await req('POST', '/cart', { productId: '1001', qty: 1 });
  await sleep(600);

  // Step 4: Checkout (within wallet limit — ₹3,000 < ₹5,000 tx limit)
  console.log('[SIGNED] Step 4: Checkout — ₹3,000 Concert Ticket...');
  const checkout = await req('POST', '/checkout', {
    productId: '1001',
    amount: 3000,
    item: 'Concert Ticket x2',
    qty: 1,
  });

  console.log(`[SIGNED] Checkout result: status=${checkout.status}`, JSON.stringify(checkout.body));

  if (checkout.body && (checkout.body.status === 'success' || checkout.body.orderId)) {
    console.log(`\n[SIGNED] ✅ Purchase completed!`);
    console.log(`[SIGNED]   Order ID: ${checkout.body.orderId}`);
    console.log(`[SIGNED]   Sandbox:  ${checkout.body.sandbox ? 'YES (quarantined)' : 'NO (real store)'}`);
    console.log(`[SIGNED]   Wallet remaining: ${fmt(checkout.body.walletRemaining)}`);
    console.log(`[SIGNED] Expected: tier-1 ALLOW route in logs (check gateway identity classifier)`);
  } else if (checkout.status === 202) {
    console.log(`[SIGNED] ⏸️ Approval required (wallet firewall): ${checkout.body && checkout.body.reason}`);
  } else {
    console.log(`[SIGNED] Unexpected result: ${checkout.status}`);
  }

  console.log(`\n[SIGNED] Demo closing beat:`);
  console.log(`[SIGNED]   → Signed agent: tier 1, instant allow, purchase within budget executed`);
  console.log(`[SIGNED]   → Unsigned agents: tier 4, scored on behaviour, may be quarantined`);
  console.log(`[SIGNED]   → Good agents get a front door. Unknown agents get contained.`);
  await new Promise(r => setTimeout(r, 1000));
  await req('POST', '/session/complete', { status: 'signed_done' }).catch(() => {});
}

run().catch(err => {
  console.error('[SIGNED] Error:', err.message);
  process.exit(1);
});
