'use strict';
/** Shared test helpers: spawn services on test ports, tiny HTTP client, request signing. */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PORTS = { gateway: 13001, admin: 13002, tool: 13007 };
const SIGNING_KEY = 'test-signing-key';
const PUBKEY_ID = 'agent-quarantine-attacker-v1';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function request(port, method, urlPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: 'localhost', port, path: urlPath, method,
      headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const gateway = (m, p, h, b) => request(PORTS.gateway, m, p, h, b);
const admin = (m, p, b) => request(PORTS.admin, m, p, {}, b);

async function waitFor(fn, { timeout = 15000, every = 150 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`waitFor timed out${last ? `: ${last.message}` : ''}`);
}

/** Start storefront + gateway with no external calls (no DB, no judgment provider keys). */
async function startStack(extraEnv = {}, { withToolServer = false } = {}) {
  const env = {
    ...process.env,
    GATEWAY_PORT: String(PORTS.gateway), ADMIN_PORT: String(PORTS.admin), TOOL_SERVER_PORT: String(PORTS.tool),
    PERSIST_AUDIT: 'off', DATABASE_URL: '',
    JUDGE_PROVIDER: 'jev', JUDGE_FALLBACK: 'none', TYPESAFE_API_KEY: '', // provider fails fast with no network
    AGENT_SIGNING_KEY: SIGNING_KEY,
    ...extraEnv,
  };
  const procs = [];
  const launch = (file) => {
    const p = spawn(process.execPath, [path.join(ROOT, file)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.out = '';
    p.stdout.on('data', (d) => { p.out += d; });
    p.stderr.on('data', (d) => { p.out += d; });
    procs.push(p);
    return p;
  };
  launch('storefront/server.js');
  launch('gateway/server.js');
  if (withToolServer) launch('agents/tool-server.js');
  await waitFor(async () => (await admin('GET', '/stats/all')).status === 200, { timeout: 20000 });
  return {
    env, procs,
    async stop() {
      for (const p of procs) p.kill('SIGTERM');
      await sleep(300);
      for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
    },
  };
}

function sign(sessionId, { timestamp = Date.now(), key = SIGNING_KEY, pubkeyId = PUBKEY_ID } = {}) {
  const s = crypto.createHmac('sha256', key).update(`${sessionId}:${pubkeyId}:${timestamp}`).digest('hex');
  return { 'x-agent-signature': `t=${timestamp},s=${s}`, 'x-agent-pubkey-id': pubkeyId };
}

const HUMAN_HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36',
  'accept-language': 'en-US', referer: 'http://shop.local/', 'sec-fetch-mode': 'navigate',
};

module.exports = { ROOT, PORTS, SIGNING_KEY, PUBKEY_ID, sleep, request, gateway, admin, waitFor, startStack, sign, HUMAN_HEADERS };
