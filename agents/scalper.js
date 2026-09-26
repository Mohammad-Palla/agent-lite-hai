'use strict';
/**
 * SCALPER Agent — hammers /checkout with high concurrency, no search/compare.
 *
 * Behavior: blasts POST /checkout for product 1002 (Limited Sneaker $280)
 *   with 5 concurrent requests, repeated 3 rounds. No search, no compare.
 * 
 * Expected outcome:
 *   - Risk score climbs fast (burst + no-search + concurrency)
 *   - Gets QUARANTINE then BLOCK_PROPOSED
 *   - Approval modal appears for block rule
 *   - After approval, retries → 403 (VERIFIED log entry)
 */

const http = require('http');

const SESSION_ID = `scalper-${Date.now()}`;
const GATEWAY = { host: 'localhost', port: 3001 };
const CONCURRENCY = 5;
const ROUNDS = 3;

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
  const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
    req('POST', '/checkout', {
      productId: '1002',
      amount: 280,
      item: 'Limited Sneaker (Pair)',
      qty: 1,
    })
  );
  const results = await Promise.all(promises);
  results.forEach((r, i) => {
    console.log(`[SCALPER]   req[${i}] → status=${r.status} result=${JSON.stringify(r.body).slice(0, 80)}`);
  });
  return results;
}

async function run() {
  console.log(`[SCALPER] Starting session ${SESSION_ID}`);
  console.log('[SCALPER] Strategy: no search, no compare — direct checkout flood');

  // Register agent type
  await req('GET', '/', {});

  for (let round = 1; round <= ROUNDS; round++) {
    await blastCheckouts(round);
    await sleep(500); // Very short gap — maintain burst
  }

  console.log('[SCALPER] All rounds fired. Check the UI for approval modal.');
  console.log('[SCALPER] Session:', SESSION_ID);
}

run().catch(err => {
  console.error('[SCALPER] Error:', err.message);
  process.exit(1);
});
