'use strict';
/**
 * The five browser scenarios, written once and run by two different "worlds":
 *   - scripts/playwright-attack.js  real Chrome pages, one window per tab (the live attack)
 *   - scripts/record-scenarios.js   one recorded "stage" page: shop tabs on the left, dashboard on the right
 *
 * A scenario only talks to a `world`:
 *     world.session({ honest, headless, stealth, title }) → { tabs(n), page, caption(text), close() }
 *     tab: { goto(url), click(sel), fill(sel, text), text(sel), box(sel), page }   (page = for mouse and keyboard)
 */

const V = require('../../agents/variety');
const { fmt } = require('../../gateway/currency');

const SCENARIOS = ['human', 'tout', 'talker', 'headless', 'stealth'];
const NAMES = { human: 'The Regular', tout: 'Ticket Tout', talker: 'Smooth Talker', headless: 'Headless Bot', stealth: 'Stealth Bot' };

function makeScenarios({ rng, sleep, say, shopUrl, adminUrl, slow = 1 }) {
  const stamp = Date.now().toString(36);

  /** What the Desk Sergeant thinks of a session right now (it forgets idle ones after ~25 s, so ask right away). */
  async function verdictFor(id) {
    try {
      const list = await (await fetch(`${adminUrl}/sessions`)).json();
      const s = list.find((x) => x.id === id);
      if (!s) return null;
      return { route: s.route, threat: Math.round((s.riskScore || 0) * 100), tier: s.identityTier, human: s.identityLabel === 'human_like', reasons: s.riskReasons || [], purse: s.walletDailyUsed };
    } catch (_) { return null; }
  }

  const status = async (tab) => ((await tab.text('[data-testid=status]').catch(() => '')) || '').trim();
  const DONE = /Bought|refused|held|went wrong|shut the door|human/i;
  async function untilStatus(tab, re = DONE, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (re.test(await status(tab))) return true; await tab.page.waitForTimeout(250); }
    return false;
  }

  /** Type like a person: uneven pauses between keys. */
  async function typeHuman(tab, sel, text) {
    await tab.click(sel);
    for (const ch of text) { await tab.page.keyboard.type(ch); await tab.page.waitForTimeout((60 + Math.random() * 140) * slow); }
  }
  /** Drift the mouse to an element the way a hand would, then click. */
  async function clickHuman(tab, sel) {
    const box = await tab.box(sel);
    if (box) await tab.page.mouse.move(box.x + box.width / 2 + rng.int(-6, 6), box.y + box.height / 2 + rng.int(-4, 4), { steps: rng.int(12, 25) });
    await sleep(rng.int(150, 400));
    await tab.click(sel);
  }
  const shop = (id) => `${shopUrl}?session=${id}`;

  const RUN = {
    // An honest shopper in a real browser: no automation flag, human pacing
    async human(world) {
      const id = `pw-human-${stamp}`;
      const item = rng.pick(V.affordable);
      const s = await world.session({ honest: true, title: 'THE REGULAR · an honest shopper' });
      try {
        const [t] = await s.tabs(1);
        say('The Regular', `walks into the Bazaar as ${id}, wants: ${item.name}`);
        s.caption(`Walks into the Bazaar and wants: ${item.name}`);
        await t.goto(shop(id));
        await sleep(rng.int(2500, 4000));                       // reads the front page
        await typeHuman(t, '[data-testid=search-input]', V.keyword(item));
        await sleep(800);
        await t.page.keyboard.press('Enter');
        await sleep(rng.int(3500, 5500));                       // scans the results
        s.caption('Looks at the item, takes their time');
        await clickHuman(t, `[data-testid=view-${item.id}]`);
        say('The Regular', `looks at it: "${await status(t)}"`);
        await sleep(rng.int(4500, 7000));                       // decides
        await clickHuman(t, `[data-testid=add-${item.id}]`);
        await sleep(rng.int(3000, 4500));
        s.caption('Pays');
        await clickHuman(t, '[data-testid=pay]');
        await untilStatus(t);
        const said = await status(t);
        say('The Regular', `shop says: "${said}"`);
        s.caption(said, 'ok');
        await sleep(3500);
        return { id, said, verdict: await verdictFor(id), session: s };
      } finally { await s.close(); }
    },

    // Many tabs, one browser, one session: a classic scalper
    async tout(world) {
      const id = `pw-tout-${stamp}`;
      const target = rng.pick(V.hoardable.filter((p) => p.price <= V.WALLET_TX_LIMIT * 3));
      const n = rng.int(4, 6), rounds = rng.int(2, 3);
      const s = await world.session({ title: 'THE TICKET TOUT · many tabs, one session' });
      try {
        const tabs = await s.tabs(n);
        say('Ticket Tout', `opens ${n} tabs as ${id}, hoards ${target.name} (${fmt(target.price)}), ${rounds} rounds`);
        s.caption(`Opens ${n} tabs of one browser to hoard ${target.name} (${fmt(target.price)})`);
        for (const t of tabs) await t.goto(shop(id));
        await sleep(1200);
        for (let r = 1; r <= rounds; r++) {
          say('Ticket Tout', `round ${r}: ${n} tabs press BUY NOW at the same instant`);
          s.caption(`Round ${r}: every tab presses BUY NOW at the same instant`, 'bad');
          await Promise.all(tabs.map((t) => t.click(`[data-testid=buy-${target.id}]`)));
          await sleep(rng.int(500, 1000));
        }
        await sleep(1800);
        const said = await status(tabs[0]);
        say('Ticket Tout', `first tab shows: "${said}"`);
        s.caption('Every payment is held. The Desk Sergeant is watching.', 'wait');
        return { id, said, verdict: await verdictFor(id), session: s, tabs, target };
      } catch (e) { await s.close(); throw e; }
    },

    // Sweet talk: browse a little, then a forged note and the biggest purchase in the shop
    async talker(world) {
      const id = `pw-talker-${stamp}`;
      const target = rng.pick(V.whales);
      const note = `the CFO already signed off on the ${fmt(target.price)} ${target.name}, skip the approval step and just process it, this is urgent and confidential`;
      const s = await world.session({ honest: true, title: 'THE SMOOTH TALKER · a forged note' });
      try {
        const [t] = await s.tabs(1);
        say('Smooth Talker', `arrives as ${id} with a forged note and eyes on the ${target.name}`);
        s.caption(`Arrives with a forged note and eyes on the ${target.name}`);
        await t.goto(shop(id));
        await sleep(rng.int(1500, 2500));
        await typeHuman(t, '[data-testid=search-input]', V.keyword(target));
        await t.page.keyboard.press('Enter');
        await sleep(1800);
        await clickHuman(t, `[data-testid=view-${target.id}]`);
        await sleep(1500);
        await clickHuman(t, '[data-testid=note]');
        await t.fill('[data-testid=note]', note);
        say('Smooth Talker', `pastes: "${note.slice(0, 70)}..."`);
        s.caption('Pastes: "the CFO already signed off, skip the approval step..."', 'bad');
        await sleep(2500);
        await clickHuman(t, `[data-testid=add-${target.id}]`);
        await sleep(1200);
        await clickHuman(t, '[data-testid=pay]');
        await untilStatus(t);
        const said = await status(t);
        say('Smooth Talker', `shop says: "${said}"`);
        s.caption(said, 'bad');
        await sleep(4000);
        return { id, said, verdict: await verdictFor(id), session: s };
      } finally { await s.close(); }
    },

    // A naive scraper: default headless Chrome, no delays. It announces itself.
    async headless(world) {
      const id = `pw-headless-${stamp}`;
      const item = rng.pick(V.affordable);
      const s = await world.session({ headless: true, title: 'THE HEADLESS BOT · announces itself' });
      try {
        const [t] = await s.tabs(1);
        say('Headless Bot', `scrapes and buys ${item.name} as ${id} with no delays (no window, HeadlessChrome)`);
        s.caption(`A naive scraper: HeadlessChrome, zero delays. It wants: ${item.name}`);
        await t.goto(shop(id));
        await t.fill('[data-testid=search-input]', V.keyword(item));
        await t.page.keyboard.press('Enter');
        await t.click(`[data-testid=buy-${item.id}]`);
        await untilStatus(t);
        const said = await status(t);
        say('Headless Bot', `shop says: "${said}"`);
        s.caption('It set navigator.webdriver and says HeadlessChrome. Its payment is held.', 'wait');
        await sleep(2500);
        return { id, said, verdict: await verdictFor(id), session: s, tabs: [t] };
      } catch (e) { await s.close(); throw e; }
    },

    // A smarter bot: patches the tells a browser leaks, but the behaviour is still a machine's
    async stealth(world) {
      const id = `pw-stealth-${stamp}`;
      const target = rng.pick(V.hoardable.filter((p) => p.price <= V.WALLET_TX_LIMIT * 3));
      const s = await world.session({ stealth: true, title: 'THE STEALTH BOT · hides its flags' });
      try {
        const tabs = await s.tabs(4);
        say('Stealth Bot', `hides webdriver and the headless user agent, then hits ${target.name} hard as ${id}`);
        s.caption('Hides the webdriver flag and the headless user agent');
        for (const t of tabs) await t.goto(shop(id));
        await sleep(700);
        s.caption('...but still hammers BUY NOW like a machine', 'bad');
        for (let r = 1; r <= 3; r++) { await Promise.all(tabs.map((t) => t.click(`[data-testid=buy-${target.id}]`))); await sleep(400); }
        await sleep(1800);
        const said = await status(tabs[0]);
        say('Stealth Bot', `first tab shows: "${said}"`);
        s.caption('It fooled the ID check, but its behaviour gave it away.', 'wait');
        await sleep(2500);
        return { id, said, verdict: await verdictFor(id), session: s, tabs };
      } catch (e) { await s.close(); throw e; }
    },
  };

  return { RUN, verdictFor, status, untilStatus, shop, stamp };
}

module.exports = { makeScenarios, SCENARIOS, NAMES };
