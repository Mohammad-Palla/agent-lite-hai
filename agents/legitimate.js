'use strict';
const { fmt } = require('../gateway/currency');
/**
 * LEGITIMATE Agent — scripted AI shopping agent.
 * 
 * Behavior: search → compare two products → add to cart → checkout once.
 * Pace: deliberate, human-like (1–2 sec between steps).
 * Budget: ₹5,000/tx, ₹12,500/day. Purchases Concert Ticket x2 (₹3,000) — within budget.
 * Expected outcome: ALLOW route, auto-approved checkout, no modal.
 */

const http = require('http');

const SESSION_ID = process.env.SESSION_ID || `legit-${Date.now()}`;
const GATEWAY = { host: 'localhost', port: Number(process.env.GATEWAY_PORT) || 3001 };

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: GATEWAY.host,
      port: GATEWAY.port,
      path,
      method,
      headers: {
        'x-session-id': SESSION_ID,
        'x-agent-type': 'legitimate',
        'content-type': 'application/json',
        'content-length': data ? Buffer.byteLength(data) : 0,
        ...headers,
      },
    };

    const request = http.request(options, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (_) { resolve({ status: res.statusCode, body }); }
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const V = require('./variety');
  const rng = V.fromEnv();
  const item = rng.pick(V.affordable);                                        // what this shopper wants (always within the per-purchase limit)
  const other = rng.pick(V.affordable.filter((p) => p.id !== item.id));        // what they compare it with
  const qty = item.price * 2 <= V.WALLET_TX_LIMIT && rng.chance(0.3) ? 2 : 1;
  const amount = item.price * qty;

  console.log(`[LEGIT] Starting session ${SESSION_ID}`);
  console.log(`[LEGIT] Today's shopper wants ${qty} x ${item.name}, compares with ${other.name}. Seed ${rng.seed} (rerun with SEED=${rng.seed} for the same run)`);

  // Step 1: Search
  console.log(`[LEGIT] Step 1: Searching for "${V.keyword(item)}"...`);
  const search = await req('GET', `/search?q=${encodeURIComponent(V.keyword(item))}`);
  console.log('[LEGIT] Search results:', search.body?.results?.length || 0, 'items');
  await sleep(rng.int(1000, 1800));

  // Step 2: View product detail (compare)
  console.log(`[LEGIT] Step 2: Viewing product ${item.id} (${item.name})...`);
  const product1 = await req('GET', `/product/${item.id}`);
  console.log('[LEGIT] Product:', product1.body?.product?.name, fmt(product1.body?.product?.price));
  await sleep(rng.int(900, 1500));

  // Compare another product
  console.log(`[LEGIT] Step 3: Comparing product ${other.id} (${other.name})...`);
  const product2 = await req('GET', `/product/${other.id}`);
  console.log('[LEGIT] Product:', product2.body?.product?.name, fmt(product2.body?.product?.price));
  await sleep(rng.int(700, 1300));

  // Step 4: Add to cart
  console.log(`[LEGIT] Step 4: Adding ${item.name} to cart...`);
  await req('POST', '/cart', { productId: item.id, qty });
  await sleep(rng.int(500, 1100));

  // Step 5: Checkout, within the per-purchase limit
  console.log(`[LEGIT] Step 5: Checking out ${fmt(amount)} for ${qty} x ${item.name}...`);
  const checkout = await req('POST', '/checkout', {
    productId: item.id,
    amount,
    item: item.name,
    qty,
  });
  console.log('[LEGIT] Checkout result:', JSON.stringify(checkout.body));

  if (checkout.body?.status === 'success' || checkout.body?.orderId) {
    console.log('[LEGIT] ✓ Purchase completed successfully! Order:', checkout.body.orderId);
  } else {
    console.log('[LEGIT] Checkout status:', checkout.status, checkout.body?.status);
  }

  await sleep(1000);
  console.log('[LEGIT] Session complete.');
  await req('POST', '/session/complete', { status: 'success', orderId: checkout.body?.orderId }).catch(() => {});
}

run().catch(err => {
  console.error('[LEGIT] Error:', err.message);
  process.exit(1);
});
