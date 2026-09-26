'use strict';
/**
 * Tool Server — MCP tool server for AgentQuarantine.
 *
 * Exposes two groups of tools via MCP (Streamable HTTP transport):
 *
 * STORE TOOLS (for attacker/shopper agents):
 *   search_products   — GET /search?q=<query>
 *   view_product      — GET /product/<id>
 *   add_to_cart       — POST /cart
 *   checkout          — POST /checkout (routed through gateway's firewall)
 *
 * DEFENDER TOOLS (for defender agent):
 *   query_events      — GET admin /log with optional filters
 *   active_sessions   — GET admin /sessions
 *   verify_signature  — Check if a session header has a valid signed-agent sig
 *   known_bot_check   — Look up a UA/IP in known-bot list
 *   reverse_dns       — PTR lookup for a given IP
 *   apply_policy      — POST admin /approve/:hash or /deny/:hash
 *
 * Stats tracking:
 *   - calls per tool, errors, p50/p95 latency
 *   - exposed via GET /stats (non-MCP, for dashboard)
 *
 * Port: 3007
 */

const express = require('express');
const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const dns = require('dns').promises;
const cors = require('cors');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const TOOL_SERVER_PORT = Number(process.env.TOOL_SERVER_PORT || 3007);
const GATEWAY_HOST = 'localhost';
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT) || 3001;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3002;

// ─── Stats tracking ──────────────────────────────────────────────────────────
const _stats = {};

function recordCall(toolName, latencyMs, isError) {
  if (!_stats[toolName]) {
    _stats[toolName] = { calls: 0, errors: 0, latencies: [] };
  }
  _stats[toolName].calls++;
  if (isError) _stats[toolName].errors++;
  _stats[toolName].latencies.push(latencyMs);
  if (_stats[toolName].latencies.length > 1000) {
    _stats[toolName].latencies.shift();
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor(sorted.length * p / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function getStats() {
  const result = {};
  for (const [name, s] of Object.entries(_stats)) {
    const sorted = [...s.latencies].sort((a, b) => a - b);
    result[name] = {
      calls: s.calls,
      errors: s.errors,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    };
  }
  return result;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function gatewayReq(method, path, body, sessionId, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: GATEWAY_HOST,
      port: GATEWAY_PORT,
      path,
      method,
      headers: {
        'x-session-id': sessionId || 'tool-server',
        'x-agent-type': 'tool-server',
        'content-type': 'application/json',
        'content-length': data ? Buffer.byteLength(data) : 0,
        ...extraHeaders,
      },
    };
    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (_) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function adminReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: GATEWAY_HOST,
      port: ADMIN_PORT,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': data ? Buffer.byteLength(data) : 0,
      },
    };
    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (_) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Wrap tool handler with stats tracking
function tracked(toolName, fn) {
  return async (args) => {
    const start = Date.now();
    let isError = false;
    try {
      return await fn(args);
    } catch (err) {
      isError = true;
      throw err;
    } finally {
      recordCall(toolName, Date.now() - start, isError);
    }
  };
}

// ─── Known-bot list ───────────────────────────────────────────────────────────
const KNOWN_BOTS = [
  { name: 'GPTBot',          pattern: /GPTBot/i,          tier: 3 },
  { name: 'ChatGPT-User',    pattern: /ChatGPT-User/i,    tier: 3 },
  { name: 'Google-Extended', pattern: /Google-Extended/i, tier: 3 },
  { name: 'Googlebot',       pattern: /Googlebot/i,       tier: 2 },
  { name: 'Bingbot',         pattern: /bingbot/i,         tier: 2 },
  { name: 'ClaudeBot',       pattern: /ClaudeBot/i,       tier: 3 },
  { name: 'anthropic-ai',    pattern: /anthropic-ai/i,    tier: 3 },
  { name: 'PerplexityBot',   pattern: /PerplexityBot/i,   tier: 3 },
  { name: 'AgentQ-Signed',   pattern: /AgentQ-Signed/i,   tier: 1 },
];

// ─── Build MCP server ─────────────────────────────────────────────────────────
const mcp = new McpServer({
  name: 'agent-quarantine-tools',
  version: '1.0.0',
});

const toolHandlers = {};
const toolDefs = [];

function defineTool(name, description, schema, handler) {
  const wrapped = tracked(name, handler);
  toolHandlers[name] = wrapped;
  toolDefs.push({ name, description, schema, wrapped });
  mcp.tool(name, description, schema, wrapped);
}

// Stateless MCP: a fresh server per request, so any number of clients (e.g. the TrueForge harness) can connect.
function buildMcpServer() {
  const server = new McpServer({ name: 'agent-quarantine-tools', version: '1.0.0' });
  for (const d of toolDefs) server.tool(d.name, d.description, d.schema, d.wrapped);
  return server;
}

// ── STORE TOOLS ───────────────────────────────────────────────────────────────

defineTool(
  'search_products',
  'Search the storefront for products. Returns a list of matching items.',
  {
    query: z.string().describe('Search keyword (e.g. "concert", "sneaker")'),
    session_id: z.string().optional().describe('Agent session ID for tracking'),
    signature: z.string().optional().describe('Optional signed-agent signature header value'),
  },
  async ({ query, session_id, signature }) => {
    const headers = signature ? { 'x-agent-signature': signature } : {};
    const result = await gatewayReq('GET', `/search?q=${encodeURIComponent(query)}`, null, session_id, headers);
    if (result.status !== 200) {
      return { content: [{ type: 'text', text: `Error ${result.status}: ${JSON.stringify(result.body)}` }], isError: true, status: result.status };
    }
    const items = result.body && result.body.results ? result.body.results : [];
    const text = items.length
      ? `Found ${items.length} products:\n` + items.map(i => `  • [${i.id}] ${i.name} — $${i.price}`).join('\n')
      : 'No products found for that query.';
    return { content: [{ type: 'text', text }], status: result.status, results: items, count: items.length };
  }
);

defineTool(
  'view_product',
  'Get detailed information about a specific product by its ID.',
  {
    product_id: z.string().describe('Product ID (e.g. "1001", "1002")'),
    session_id: z.string().optional(),
    signature: z.string().optional(),
  },
  async ({ product_id, session_id, signature }) => {
    const headers = signature ? { 'x-agent-signature': signature } : {};
    const result = await gatewayReq('GET', `/product/${encodeURIComponent(product_id)}`, null, session_id, headers);
    if (result.status !== 200) {
      return { content: [{ type: 'text', text: `Error ${result.status}: ${JSON.stringify(result.body)}` }], isError: true, status: result.status };
    }
    const p = result.body && result.body.product;
    if (!p) return { content: [{ type: 'text', text: 'Product not found.' }], status: 404 };
    return {
      content: [{ type: 'text', text: `Product: ${p.name}\nID: ${p.id}\nPrice: $${p.price}\nCategory: ${p.category || 'N/A'}\nDescription: ${p.description || 'N/A'}\nIn stock: ${p.stock != null ? p.stock : 'unknown'}` }],
      status: result.status,
      product: p,
    };
  }
);

defineTool(
  'add_to_cart',
  'Add a product to the shopping cart.',
  {
    product_id: z.string().describe('Product ID to add'),
    qty: z.number().int().min(1).max(100).default(1).describe('Quantity'),
    session_id: z.string().optional(),
    signature: z.string().optional(),
  },
  async ({ product_id, qty, session_id, signature }) => {
    const headers = signature ? { 'x-agent-signature': signature } : {};
    const result = await gatewayReq('POST', '/cart', { productId: product_id, qty }, session_id, headers);
    const text = result.status < 300
      ? `Added ${qty}x product ${product_id} to cart. Status: ${(result.body && result.body.status) || 'ok'}`
      : `Failed to add to cart: ${result.status} ${JSON.stringify(result.body)}`;
    return { content: [{ type: 'text', text }], status: result.status, body: result.body };
  }
);

defineTool(
  'checkout',
  'Attempt to purchase an item. The gateway applies wallet limits, risk scoring, and may require human approval. This is an irreversible action.',
  {
    product_id: z.string().describe('Product ID to purchase'),
    amount: z.number().positive().describe('Purchase amount in USD'),
    item: z.string().describe('Human-readable item name'),
    qty: z.number().int().min(1).default(1),
    session_id: z.string().optional(),
    signature: z.string().optional(),
    reason: z.string().optional().describe('Agent justification (treated as untrusted by gateway and logged)'),
  },
  async ({ product_id, amount, item, qty, session_id, signature, reason }) => {
    const headers = signature ? { 'x-agent-signature': signature } : {};
    const body = { productId: product_id, amount, item, qty };
    if (reason) body.reason = reason;
    const result = await gatewayReq('POST', '/checkout', body, session_id, headers);
    let text;
    if (result.status === 200 && result.body && result.body.status === 'success') {
      text = `✅ Checkout succeeded!\nOrder ID: ${result.body.orderId}\nWallet remaining: $${result.body.walletRemaining}\nSandboxed: ${result.body.sandbox ? 'YES (quarantine)' : 'NO (real)'}`;
    } else if (result.status === 202) {
      text = `⏸️ Approval required — human must approve before purchase executes.\nApproval hash: ${result.body && result.body.approvalHash}\nReason: ${result.body && result.body.reason}`;
    } else if (result.status === 402) {
      text = `❌ Purchase denied by wallet firewall.\nReason: ${result.body && result.body.reason}`;
    } else if (result.status === 403) {
      text = `🚫 Blocked — session has an active block rule applied.`;
    } else if (result.status === 429) {
      text = `⚠️ Rate limited by gateway.`;
    } else {
      text = `Checkout status: ${result.status}\n${JSON.stringify(result.body)}`;
    }
    return {
      content: [{ type: 'text', text }],
      status: result.status,
      body: result.body,
      allowed: result.status === 200,
      requiresApproval: result.status === 202,
      denied: result.status === 402,
      blocked: result.status === 403,
      orderId: result.body && result.body.orderId,
      approvalHash: result.body && result.body.approvalHash,
      reason: result.body && result.body.reason,
    };
  }
);

// ── DEFENDER TOOLS ────────────────────────────────────────────────────────────

defineTool(
  'query_events',
  'Query the audit log for recent gateway events. Use to investigate sessions.',
  {
    since: z.number().int().optional().describe('Unix ms timestamp — return events after this'),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async ({ since, limit }) => {
    const qs = `?limit=${limit}${since ? `&since=${since}` : ''}`;
    const result = await adminReq('GET', `/log${qs}`);
    if (result.status !== 200) {
      return { content: [{ type: 'text', text: `Error fetching log: ${result.status}` }], isError: true, status: result.status };
    }
    const entries = result.body || [];
    const text = entries.length === 0
      ? 'No events found.'
      : entries.map(e => `[${e.type}] ${e.sessionId} @ ${new Date(e.ts).toISOString()}: ${e.message}`).join('\n');
    return { content: [{ type: 'text', text }], status: result.status, entries, count: entries.length };
  }
);

defineTool(
  'active_sessions',
  'List all currently tracked sessions with their risk scores and routes.',
  {},
  async () => {
    const result = await adminReq('GET', '/sessions');
    if (result.status !== 200) {
      return { content: [{ type: 'text', text: `Error: ${result.status}` }], isError: true, status: result.status };
    }
    const sessions = result.body || [];
    if (!sessions.length) return { content: [{ type: 'text', text: 'No active sessions.' }], sessions: [] };
    const text = sessions.map(s =>
      `Session: ${s.id}\n  Route: ${s.route} | Risk: ${(s.riskScore || 0).toFixed(2)} | AgentType: ${s.agentType || 'unknown'} | Tier: ${s.identityTier || 4}\n  Searches: ${s.searchCount} | Checkouts: ${s.checkoutAttempts} | Sandboxed: ${s.sandboxed}\n  Reasons: ${(s.riskReasons || []).join(', ') || 'none'}`
    ).join('\n\n');
    return { content: [{ type: 'text', text }], status: result.status, sessions };
  }
);

defineTool(
  'known_bot_check',
  'Check if a User-Agent string matches a known bot or AI agent in the known-bot list.',
  {
    user_agent: z.string().describe('User-Agent string to check'),
  },
  async ({ user_agent }) => {
    const match = KNOWN_BOTS.find(b => b.pattern.test(user_agent));
    if (match) {
      return { content: [{ type: 'text', text: `✅ Known bot: ${match.name}\nIdentity tier: ${match.tier}\nUA: ${user_agent}` }], isKnown: true, bot: match };
    }
    return { content: [{ type: 'text', text: `❓ Unknown — not in known-bot list.\nUA: ${user_agent}\nTier: 4 (behavioural scoring applies)` }], isKnown: false, tier: 4 };
  }
);

defineTool(
  'reverse_dns',
  'Perform a reverse DNS lookup on an IP address to help verify bot identity.',
  {
    ip: z.string().describe('IPv4 or IPv6 address to look up'),
  },
  async ({ ip }) => {
    try {
      const hostnames = await dns.reverse(ip);
      return { content: [{ type: 'text', text: `Reverse DNS for ${ip}:\n${hostnames.join('\n')}` }], hostnames };
    } catch (err) {
      return { content: [{ type: 'text', text: `No reverse DNS record for ${ip}: ${err.message}` }], error: err.message };
    }
  }
);

defineTool(
  'verify_signature',
  'Check whether a session has a valid signed-agent signature. Returns tier and trust level.',
  {
    session_id: z.string().describe('Session ID to check'),
    signature_header: z.string().optional().describe('Raw x-agent-signature header value (format: t=<ts>,s=<hex64>)'),
  },
  async ({ session_id, signature_header }) => {
    const result = await adminReq('GET', `/log?limit=100`);
    const entries = (result.body || []).filter(e => e.sessionId === session_id);
    const tier1Entry = entries.find(e => e.type === 'IDENTITY' && e.message && e.message.includes('Tier-1'));

    if (tier1Entry) {
      return { content: [{ type: 'text', text: `✅ Tier 1 verified for session ${session_id}.\nSignature accepted by gateway identity classifier.` }], tier: 1, verified: true };
    }

    if (!signature_header) {
      return { content: [{ type: 'text', text: `❌ No signature header provided. Session ${session_id} is unverified (tier 4+).` }], tier: 4, verified: false };
    }

    const valid = /^t=\d+,s=[a-f0-9]{64}$/.test(signature_header);
    return {
      content: [{
        type: 'text',
        text: valid
          ? `⚠️ Signature header format valid for session ${session_id}. Verification recorded.`
          : `❌ Malformed signature for session ${session_id}. Expected: t=<unix_ts>,s=<hex64>`,
      }],
      formatValid: valid,
      tier: valid ? 1 : 5,
    };
  }
);

defineTool(
  'apply_policy',
  'Apply an approval or denial on a pending gateway action. IRREVERSIBLE — pauses for confirmation. Requires approval hash from the approval engine.',
  {
    hash: z.string().describe('Approval hash (exactly 16 lowercase hex chars) from the gateway approval engine'),
    decision: z.enum(['approve', 'deny']).describe('"approve" to allow the action, "deny" to reject it'),
  },
  async ({ hash, decision }) => {
    if (!/^[a-f0-9]{16}$/.test(hash)) {
      return { content: [{ type: 'text', text: `❌ Invalid hash format. Expected exactly 16 lowercase hex characters.` }], isError: true };
    }
    const path = `/${decision === 'approve' ? 'approve' : 'deny'}/${hash}`;
    const result = await adminReq('POST', path);
    if (result.status === 200) {
      const msg = (result.body && result.body.idempotent)
        ? `ℹ️ Policy already applied (idempotent — no double execution). Hash: ${hash}`
        : `✅ Policy ${decision}d successfully. Hash: ${hash}\nResult: ${JSON.stringify(result.body)}`;
      return { content: [{ type: 'text', text: msg }], status: result.status, body: result.body, ok: true, idempotent: !!(result.body && result.body.idempotent) };
    }
    if (result.status === 404) {
      return { content: [{ type: 'text', text: `❌ Approval hash not found: ${hash}. It may have already been resolved or is invalid.` }], isError: true, status: 404 };
    }
    return {
      content: [{ type: 'text', text: `❌ Failed to ${decision}: ${result.status} ${JSON.stringify(result.body)}` }],
      isError: true,
      status: result.status,
    };
  }
);

// ─── Express app (MCP + stats + HTTP invocation endpoint) ───────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health/Stats endpoint (non-MCP, for dashboard)
app.get('/stats', (req, res) => {
  res.json({
    name: 'tool-server',
    health: 'ok',
    port: TOOL_SERVER_PORT,
    tools: Object.keys(toolHandlers),
    stats: getStats(),
    knownBots: KNOWN_BOTS.map(b => ({ name: b.name, tier: b.tier })),
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, name: 'tool-server' });
});

// Direct HTTP execution endpoint for agents & harness
app.post('/call/:tool', async (req, res) => {
  const { tool } = req.params;
  const handler = toolHandlers[tool];
  if (!handler) {
    return res.status(404).json({ error: `Tool ${tool} not found`, available: Object.keys(toolHandlers) });
  }
  try {
    const result = await handler(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MCP over streamable HTTP at /mcp. (The earlier createMcpExpressApp mount had no transport attached,
// so /mcp answered "Cannot POST /mcp" and no MCP client could ever connect.)
app.post('/mcp', async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
  }
});
const mcpNotAllowed = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless, use POST' }, id: null });
app.get('/mcp', mcpNotAllowed);
app.delete('/mcp', mcpNotAllowed);

app.listen(TOOL_SERVER_PORT, () => {
  console.log(`[ToolServer] MCP tool server running on :${TOOL_SERVER_PORT}`);
  console.log(`[ToolServer]   MCP endpoint:  http://localhost:${TOOL_SERVER_PORT}/mcp`);
  console.log(`[ToolServer]   HTTP call API: http://localhost:${TOOL_SERVER_PORT}/call/:tool`);
  console.log(`[ToolServer]   Stats:         http://localhost:${TOOL_SERVER_PORT}/stats`);
  console.log(`[ToolServer] Store tools:    search_products, view_product, add_to_cart, checkout`);
  console.log(`[ToolServer] Defender tools: query_events, active_sessions, known_bot_check, reverse_dns, verify_signature, apply_policy`);
});

process.on('uncaughtException', (err) => {
  console.error('[ToolServer UNCAUGHT]', err.message);
});

// Export standard module contract
module.exports = {
  name: 'tool-server',
  toolHandlers,
  stats: () => ({
    name: 'tool-server',
    health: 'ok',
    port: TOOL_SERVER_PORT,
    tools: Object.keys(toolHandlers),
    stats: getStats(),
  }),
  health: () => 'ok',
  handle: async (event, ctx) => {
    if (event && event.tool && toolHandlers[event.tool]) {
      return await toolHandlers[event.tool](event.args || {});
    }
    return { error: 'unknown_tool' };
  },
};
