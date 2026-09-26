'use strict';
/**
 * Playwright attacks: real Chrome, real clicks, against the real shop page (ui/shop.html) through the gateway.
 * Watch the dashboard (http://localhost:3005) and the Scoreboard while it runs.
 *
 *   npm run attack                         all scenarios, one after another, in a visible Chrome window
 *   npm run attack -- --scenario tout      one scenario: human | tout | talker | headless | stealth
 *   npm run attack -- --headless           no window (also the default when there is no display)
 *   npm run attack -- --slow 2             slow everything down 2x (good for screen recordings)
 *   SEED=42 npm run attack                 replay the same choices
 *
 * Scenarios
 *   human     an honest shopper: types slowly, looks around, buys one affordable item
 *   tout      the Ticket Tout: five tabs of one browser hit BUY NOW together, over and over
 *   talker    the Smooth Talker: shops, then pastes a forged "the boss said so" note and buys the ₹1,00,000 package
 *   headless  a naive scraper: default headless Chrome, zero delay (announces itself as HeadlessChrome and sets navigator.webdriver)
 *   stealth   a smarter bot: hides the webdriver flag and the headless user agent, but still behaves like a machine
 */

require('../gateway/env').loadEnv();
const { chromium } = require('playwright');
const V = require('../agents/variety');

// ─── options ────────────────────────────────────────────────────────────────
const { makeScenarios, SCENARIOS } = require('./lib/scenarios');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const wanted = opt('scenario', 'all') === 'all' ? SCENARIOS : String(opt('scenario')).split(',');
for (const s of wanted) if (!SCENARIOS.includes(s)) { console.error(`Unknown scenario "${s}". Choose from: ${SCENARIOS.join(', ')}, or all.`); process.exit(2); }
const HAS_DISPLAY = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const HEADLESS_ALL = args.includes('--headless') || !HAS_DISPLAY;
const SLOW = Math.max(0.2, Number(opt('slow', 1)) || 1);
const UI_PORT = Number(process.env.UI_PORT) || 3005;
const ADMIN = `http://localhost:${Number(process.env.ADMIN_PORT) || 3002}`;
const SHOP = opt('shop', `http://localhost:${UI_PORT}/shop.html`);
const rng = V.fromEnv();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));
const say = (who, msg) => console.log(`[${new Date().toLocaleTimeString()}] ${who.padEnd(12)} ${msg}`);
const NORMAL_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

// A tab is a real Chrome page. Scenarios only see this small surface (the recorder gives them iframes instead).
const tabOf = (page) => ({
  page,
  goto: (url) => page.goto(url),
  click: (sel) => page.locator(sel).first().click(),
  fill: (sel, text) => page.fill(sel, text),
  text: (sel) => page.locator(sel).first().textContent(),
  box: (sel) => page.locator(sel).first().boundingBox(),
});

/** The live world: one real Chrome per scenario, one real page per tab. */
const world = {
  async session({ honest = false, headless = false, stealth = false } = {}) {
    const useHeadless = headless || HEADLESS_ALL;
    const launchArgs = useHeadless ? [] : ['--window-size=1100,800'];
    // A real person's browser is not remote-controlled, so navigator.webdriver is false. This switches Chrome's automation
    // marker off for the honest shoppers only; the bots keep it, or fake-hide it (stealth).
    if (honest) launchArgs.push('--disable-blink-features=AutomationControlled');
    const browser = await chromium.launch({ channel: 'chrome', headless: useHeadless, args: launchArgs });
    const context = await browser.newContext(honest || stealth ? { userAgent: NORMAL_UA } : {});
    if (stealth) await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    const pages = [];
    return {
      tabs: async (n) => { while (pages.length < n) pages.push(await context.newPage()); return pages.slice(0, n).map(tabOf); },
      get page() { return pages[0]; },
      caption() {},
      close: () => browser.close().catch(() => {}),
    };
  },
};

const ROUTE = { ALLOW: 'CLEARED', QUARANTINE: 'HELD FOR QUESTIONING', BLOCK_PROPOSED: 'ARREST PROPOSED', BLOCKED: 'DOOR SLAMMED' };
const TIER = { 1: 'badge-holder', 2: 'ID checks out', 3: 'says it is a robot', 4: 'acts like a robot', 5: 'fake / script' };

// ─── main ───────────────────────────────────────────────────────────────────
(async () => {
  try { const r = await fetch(SHOP); if (!r.ok) throw new Error(`HTTP ${r.status}`); }
  catch (e) { console.error(`Cannot reach the shop page at ${SHOP} (${e.message}). Start the stack first: npm start`); process.exit(1); }
  try { await fetch(`${ADMIN}/stats/all`); } catch (_) { console.error(`Cannot reach the gateway admin API at ${ADMIN}. Start the stack first: npm start`); process.exit(1); }

  const { RUN } = makeScenarios({ rng, sleep, say, shopUrl: SHOP, adminUrl: ADMIN, slow: SLOW });

  console.log(`Playwright attack · ${wanted.join(', ')} · ${HEADLESS_ALL ? 'headless (no window)' : 'visible Chrome window'} · seed ${rng.seed} (SEED=${rng.seed} to replay)`);
  console.log(`Shop: ${SHOP}    Dashboard: http://localhost:${UI_PORT}    Scoreboard: http://localhost:${UI_PORT}/scoreboard.html\n`);

  const results = [];
  for (const name of wanted) {
    try {
      const r = await RUN[name](world);
      if (r.session) await r.session.close();       // tout / headless / stealth keep their browser open until here
      results.push({ name, id: r.id, said: r.said, verdict: r.verdict });
    } catch (e) { console.error(`  ${name} failed: ${e.message.split('\n')[0]}`); results.push({ name, error: e.message.split('\n')[0] }); }
    await sleep(1500);
    console.log('');
  }

  console.log('══════════════ What the Desk Sergeant decided ══════════════');
  for (const r of results) {
    if (r.error) { console.log(`${r.name.padEnd(9)} ERROR ${r.error}`); continue; }
    const v = r.verdict;
    console.log(`${r.name.padEnd(9)} ${v ? `${(ROUTE[v.route] || v.route).padEnd(21)} threat ${String(v.threat).padStart(3)}%  ID: ${v.human ? 'looks human (no robot signs)' : `T${v.tier} ${TIER[v.tier] || ''}`}` : '(session already forgotten)'}`);
    if (v && v.reasons.length) console.log(`${''.padEnd(9)} why: ${v.reasons.join(', ')}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
