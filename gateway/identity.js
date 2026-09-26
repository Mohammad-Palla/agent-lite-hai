'use strict';
/**
 * Identity classifier logic — plain functions, no module imports.
 *
 * Tiers (lower = stronger identity evidence):
 *   1 signature         valid signed-agent proof (verification lands in the 5.5–6.5h task)
 *   2 network-verified  declared known bot AND reverse-DNS/forward-confirm matches its operator
 *   3 declared bot      declares itself (UA or x-agent-type) but no network match
 *   4 behavioural       undeclared, no JS beacon, machine-regular timing, no referrer
 *   5 automation tells  HTTP-library UA, missing browser headers, direct-to-checkout
 *   null human_like     nothing suspicious
 */

const dns = require('dns').promises;

// Known crawlers/agents: UA pattern → operator, plus hostname suffixes that confirm reverse DNS.
const KNOWN_BOTS = [
  { name: 'GPTBot',        re: /gptbot|chatgpt-user|oai-searchbot/i, operator: 'openai',     suffixes: ['.openai.com'] },
  { name: 'ClaudeBot',     re: /claudebot|claude-user|anthropic-ai/i, operator: 'anthropic',  suffixes: ['.anthropic.com'] },
  { name: 'PerplexityBot', re: /perplexity/i,                        operator: 'perplexity', suffixes: ['.perplexity.ai'] },
  { name: 'Googlebot',     re: /googlebot|google-extended/i,         operator: 'google',     suffixes: ['.googlebot.com', '.google.com'] },
  { name: 'Bingbot',       re: /bingbot/i,                           operator: 'microsoft',  suffixes: ['.search.msn.com'] },
];

function knownBot(ua) {
  if (!ua) return null;
  return KNOWN_BOTS.find(b => b.re.test(ua)) || null;
}

function isPublicIp(ip) {
  if (!ip) return false;
  const v = String(ip).replace(/^::ffff:/, '');
  if (v === '::1' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return false;
  if (/^(10\.|127\.|169\.254\.|192\.168\.|0\.)/.test(v)) return false;
  const m = v.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return false;
  return true;
}

const _rdnsCache = new Map(); // ip|operator → boolean
const RDNS_TIMEOUT_MS = 400;

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('rdns_timeout')), ms))]);
}

/**
 * Reverse-DNS + forward-confirm. Resolves { verified, hostname, reason }.
 * `resolver` is injectable for tests.
 */
async function verifyReverseDns(ip, bot, resolver = dns) {
  if (!isPublicIp(ip)) return { verified: false, reason: 'non_public_ip' };
  const key = `${ip}|${bot.operator}`;
  if (_rdnsCache.has(key)) return _rdnsCache.get(key);

  let result;
  try {
    const clean = String(ip).replace(/^::ffff:/, '');
    const hosts = await withTimeout(resolver.reverse(clean), RDNS_TIMEOUT_MS);
    const host = hosts.find(h => bot.suffixes.some(s => h.toLowerCase().endsWith(s)));
    if (!host) {
      result = { verified: false, reason: 'suffix_mismatch', hostname: hosts[0] };
    } else {
      const fwd = await withTimeout(resolver.lookup(host, { all: true }), RDNS_TIMEOUT_MS);
      const ok = fwd.some(a => a.address === clean);
      result = { verified: ok, hostname: host, reason: ok ? 'forward_confirmed' : 'forward_mismatch' };
    }
  } catch (err) {
    result = { verified: false, reason: err.message === 'rdns_timeout' ? 'timeout' : 'no_ptr' };
  }
  _rdnsCache.set(key, result);
  return result;
}

/**
 * Synchronous tier decision from collected signals. Tier 2 is upgraded later by
 * verifyReverseDns(); tier 1 by signature verification.
 * @returns { tier, label, confidence, evidence[], bot? }
 */
function classifySignals(sig) {
  const evidence = [];
  const bot = knownBot(sig.ua);

  if (sig.signature_present) evidence.push('signature_header_present_unverified');

  if (bot) {
    return { tier: 3, label: 'declared_bot', confidence: 0.6, evidence: [...evidence, `ua_known_bot:${bot.name}`], bot: bot.name };
  }
  if (sig.ua_class === 'declared_bot' || sig.declared_agent) {
    return { tier: 3, label: 'declared_bot', confidence: 0.5, evidence: [...evidence, sig.declared_agent ? `declared:${sig.declared_agent}` : 'ua_declares_bot'] };
  }

  // Automation tells (tier 5)
  const tells = [];
  if (sig.ua_class === 'http_library') tells.push('http_library_ua');
  if (sig.ua_class === 'missing') tells.push('missing_ua');
  if (!sig.accept_language && !sig.sec_fetch) tells.push('no_browser_headers');
  if (sig.sequence_shape === 'direct_checkout') tells.push('direct_checkout');
  if (tells.length >= 2 || sig.ua_class === 'http_library') {
    return { tier: 5, label: 'automation_tells', confidence: Math.min(0.95, 0.5 + tells.length * 0.15), evidence: [...evidence, ...tells] };
  }

  // Behavioural (tier 4): undeclared, no JS, machine timing, no referrer
  const beh = [];
  if (!sig.beacon) beh.push('no_js_beacon');
  if (sig.timing && sig.timing.cv !== null && sig.timing.cv < 0.15) beh.push('regular_timing');
  if (!sig.referrer) beh.push('no_referrer');
  if (beh.length >= 3) {
    return { tier: 4, label: 'behavioural', confidence: 0.6, evidence: [...evidence, ...beh] };
  }

  return { tier: null, label: 'human_like', confidence: 0.5, evidence: [...evidence, ...beh, ...tells] };
}

module.exports = { KNOWN_BOTS, knownBot, isPublicIp, verifyReverseDns, classifySignals };
