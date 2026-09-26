'use strict';
/**
 * Signal collector — pure extraction of identity/behaviour signals from a request.
 * Captures: UA, headers, timing regularity, referrer, beacon, path sequence.
 * Stores only its own per-session state; touches no other module's internals.
 */

const MAX_HISTORY = 20;
const MAX_SESSIONS = 2000;
const _state = new Map(); // sessionId → { times[], paths[], beacon }

// Fields we try to capture on every request (drives the missing-field rate).
const TRACKED_FIELDS = ['ua', 'accept', 'accept_language', 'referrer', 'sec_fetch', 'beacon'];

const HEADLESS_UA = /(HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|WebDriver)/i;   // browsers that announce they are being driven
const BOT_DECLARED = /(bot|crawler|spider|gptbot|claudebot|perplexity|agent|scrapy|slurp)/i;
const TOOL_UA = /^(curl|wget|python-requests|python-urllib|aiohttp|httpx|node-fetch|axios|undici|go-http-client|java|okhttp|libwww|postmanruntime)/i;
const BROWSER_UA = /(mozilla\/5\.0.*(chrome|firefox|safari|edg))/i;

function classifyUA(ua) {
  if (!ua) return 'missing';
  if (HEADLESS_UA.test(ua)) return 'headless';
  if (TOOL_UA.test(ua)) return 'http_library';
  if (BOT_DECLARED.test(ua)) return 'declared_bot';
  if (BROWSER_UA.test(ua)) return 'browser_like';
  return 'other';
}

function sessionState(id) {
  let s = _state.get(id);
  if (!s) {
    s = { times: [], paths: [], beacon: false };
    _state.set(id, s);
    if (_state.size > MAX_SESSIONS) _state.delete(_state.keys().next().value);
  }
  return s;
}

/** Mean/stddev of inter-arrival gaps; cv (stddev/mean) near 0 = machine-regular. */
function timingStats(times) {
  if (times.length < 3) return { samples: times.length, mean_ms: null, cv: null };
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  return { samples: gaps.length, mean_ms: +mean.toFixed(1), cv: mean > 0 ? +(Math.sqrt(variance) / mean).toFixed(3) : 0 };
}

/** Collapse a URL to a route label so sequences compare across ids/queries. */
function pathLabel(url) {
  const p = String(url).split('?')[0];
  if (p.startsWith('/product/')) return 'product';
  if (p.startsWith('/search')) return 'search';
  if (p.startsWith('/cart')) return 'cart';
  if (p.startsWith('/checkout')) return 'checkout';
  if (p.startsWith('/beacon')) return 'beacon';
  return 'other';
}

/** Journey shape from the labelled path sequence. */
function sequenceShape(labels) {
  const has = (l) => labels.includes(l);
  if (!has('checkout')) return 'browsing';
  const firstCheckout = labels.indexOf('checkout');
  const before = labels.slice(0, firstCheckout);
  if (before.includes('search') && before.includes('product')) return 'full_journey';
  if (before.includes('product') || before.includes('search')) return 'partial_journey';
  return 'direct_checkout';
}

/**
 * The shop page pings /beacon once loaded, so a client that runs JavaScript is seen. It may also report a few facts about
 * the browser (navigator.webdriver is true in Playwright, Puppeteer and Selenium unless the bot hides it). Only known,
 * simple fields are kept, and untrusted input is never echoed anywhere.
 */
function recordBeacon(sessionId, telemetry) {
  const st = sessionState(sessionId);
  st.beacon = true;
  if (telemetry && typeof telemetry === 'object') {
    const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1000, Number(v))) : null);
    st.telemetry = { webdriver: telemetry.webdriver === true, plugins: n(telemetry.plugins), languages: n(telemetry.languages) };
  }
}

/**
 * Extract signals for one request. Call once per request, in arrival order.
 * @param {{headers:object, method:string, url:string}} req
 */
function extract(sessionId, req, { signature = null } = {}) {
  const h = req.headers || {};
  const st = sessionState(sessionId);
  const label = pathLabel(req.url);

  if (label !== 'beacon') {
    st.times.push(Date.now());
    st.paths.push(label);
    if (st.times.length > MAX_HISTORY) { st.times.shift(); st.paths.shift(); }
  }

  const ua = h['user-agent'] || null;
  const signals = {
    ua,
    ua_class: classifyUA(ua),
    accept: h['accept'] || null,
    accept_language: h['accept-language'] || null,
    referrer: h['referer'] || h['referrer'] || null,
    sec_fetch: h['sec-fetch-mode'] || h['sec-fetch-site'] || null,
    header_count: Object.keys(h).length,
    declared_agent: h['x-agent-type'] ? String(h['x-agent-type']).slice(0, 40) : null,
    signature_present: !!(signature || h['signature'] || h['signature-input']),
    signature, // null = none sent; else { valid, reason?, pubkeyId? } from signature.verify()
    beacon: st.beacon,
    browser: st.telemetry || null,   // { webdriver, plugins, languages } as reported by the page, or null
    timing: timingStats(st.times),
    path_sequence: [...st.paths],
    sequence_shape: sequenceShape(st.paths),
    method: req.method,
    ip: (req.socket && req.socket.remoteAddress) || null,
  };

  const present = {
    ua: !!signals.ua,
    accept: !!signals.accept,
    accept_language: !!signals.accept_language,
    referrer: !!signals.referrer,
    sec_fetch: !!signals.sec_fetch,
    beacon: signals.beacon,
  };
  return { signals, present };
}

module.exports = { extract, recordBeacon, classifyUA, timingStats, pathLabel, sequenceShape, TRACKED_FIELDS };
