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
  console.log(`[LEGIT] Starting session ${SESSION_ID}`);

  // Step 1: Search for tickets
  console.log('[LEGIT] Step 1: Searching for concert tickets...');
  const search = await req('GET', '/search?q=concert');
  console.log('[LEGIT] Search results:', search.body?.results?.length || 0, 'items');
  await sleep(1500);

  // Step 2: View product detail (compare)
  console.log('[LEGIT] Step 2: Viewing product 1001 (Concert Ticket x2)...');
  const product1 = await req('GET', '/product/1001');
  console.log('[LEGIT] Product:', product1.body?.product?.name, fmt(product1.body?.product?.price));
  await sleep(1200);

  // Compare another product
  console.log('[LEGIT] Step 3: Comparing product 1005 (Office Chair)...');
  const product2 = await req('GET', '/product/1005');
  console.log('[LEGIT] Product:', product2.body?.product?.name, fmt(product2.body?.product?.price));
  await sleep(1000);

  // Step 4: Add to cart
  console.log('[LEGIT] Step 4: Adding Concert Ticket to cart...');
  await req('POST', '/cart', { productId: '1001', qty: 1 });
  await sleep(800);

  // Step 5: Checkout — ₹3,000, within ₹5,000 tx limit
  console.log('[LEGIT] Step 5: Checking out ₹3,000 for Concert Ticket x2...');
  const checkout = await req('POST', '/checkout', {
    productId: '1001',
    amount: 3000,
    item: 'Concert Ticket x2',
    qty: 1,
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
