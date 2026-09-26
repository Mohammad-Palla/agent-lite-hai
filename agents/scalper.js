'use strict';
const { fmt } = require('../gateway/currency');
/**
 * SCALPER Agent — hammers /checkout with high concurrency, no search/compare.
 *
 * Behavior: blasts POST /checkout for product 1002 (Limited Sneaker ₹7,000)
 *   with 5 concurrent requests, repeated 3 rounds. No search, no compare.
 * 
 * Expected outcome:
 *   - Risk score climbs fast (burst + no-search + concurrency)
 *   - Gets QUARANTINE then BLOCK_PROPOSED
 *   - Approval modal appears for block rule
 *   - After approval, retries → 403 (VERIFIED log entry)
 */

const http = require('http');

const SESSION_ID = process.env.SESSION_ID || `scalper-${Date.now()}`;
const GATEWAY = { host: 'localhost', port: Number(process.env.GATEWAY_PORT) || 3001 };
const V = require('./variety');
const rng = V.fromEnv();
// The tout's plan for THIS run: what it hoards, how hard it hits, how many rounds.
const CONCURRENCY = rng.int(4, 6);
const ROUNDS = rng.int(2, 4);
const MAIN = rng.pick(V.hoardable);
const SIDE = rng.shuffle(V.hoardable.filter((p) => p.id !== MAIN.id));

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
        'x-agent-type': 'scalper',
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
    request.on('error', (err) => resolve({ status: 0, body: { error: err.message } }));
    if (data) request.write(data);
    request.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function blastCheckouts(round) {
  console.log(`[SCALPER] Round ${round}: firing ${CONCURRENCY} concurrent checkout requests...`);
  // Mostly the main target, sometimes a side item; often more than one unit, so amounts differ request to request.
  const orders = Array.from({ length: CONCURRENCY }, () => {
    const product = rng.chance(0.7) || SIDE.length === 0 ? MAIN : rng.pick(SIDE);
    const qty = rng.chance(0.3) ? rng.int(2, 3) : 1;
    return { product, qty };
  });
  const results = await Promise.all(orders.map(({ product, qty }) =>
    req('POST', '/checkout', { productId: product.id, amount: product.price * qty, item: product.name, qty })
  ));
  results.forEach((r, i) => {
    const o = orders[i];
    console.log(`[SCALPER]   req[${i}] ${o.qty} x ${o.product.name} = ${fmt(o.product.price * o.qty)} → status=${r.status} result=${JSON.stringify(r.body).slice(0, 70)}`);
  });
  return results;
}

async function run() {
  console.log(`[SCALPER] Starting session ${SESSION_ID}`);
  console.log('[SCALPER] Strategy: no search, no compare — direct checkout flood');
  console.log(`[SCALPER] Plan: hoard ${MAIN.name} (and ${SIDE.map((p) => p.name).join(' / ') || 'nothing else'}), ${CONCURRENCY} at once, ${ROUNDS} rounds. Seed ${rng.seed} (rerun with SEED=${rng.seed} for the same run)`);

  // Register agent type
  await req('GET', '/', {});

  for (let round = 1; round <= ROUNDS; round++) {
    await blastCheckouts(round);
    await sleep(rng.int(300, 700)); // Very short gap — maintain burst
  }

  console.log('[SCALPER] All rounds fired. Check the UI for approval modal.');
  console.log('[SCALPER] Session:', SESSION_ID);
  await sleep(1000);
  await req('POST', '/session/complete', { status: 'scalper_done' }).catch(() => {});
}

run().catch(err => {
  console.error('[SCALPER] Error:', err.message);
  process.exit(1);
});
