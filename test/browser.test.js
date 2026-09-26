'use strict';
/**
 * Browser tests: the real Playwright attacks (scripts/playwright-attack.js) against a real Chrome, the real shop page and an
 * isolated stack. Slow (about 2 minutes) and needs Chrome, so it only runs with BROWSER=1:
 *
 *   npm run test:browser
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { startStack, request, waitFor, PORTS, ROOT } = require('./helpers');

const RUN = process.env.BROWSER === '1';
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].some((p) => fs.existsSync(p));
const skip = !RUN ? 'set BROWSER=1 to run browser tests' : (CHROME ? false : 'Google Chrome not found');
const UI = 14005;

let stack, ui;
test.before(async () => {
  if (skip) return;
  stack = await startStack();
  ui = spawn(process.execPath, [path.join(ROOT, 'ui', 'server.js')], { env: { ...process.env, UI_PORT: String(UI), GATEWAY_PORT: String(PORTS.gateway), ADMIN_PORT: String(PORTS.admin) }, stdio: 'ignore' });
  await waitFor(async () => (await request(UI, 'GET', '/config.js')).status === 200, { timeout: 10000 });
});
test.after(async () => { if (ui) ui.kill('SIGKILL'); if (stack) await stack.stop(); });

function attack(scenario) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'playwright-attack.js'), '--headless', '--scenario', scenario],
      { env: { ...process.env, SEED: '7', UI_PORT: String(UI), ADMIN_PORT: String(PORTS.admin), GATEWAY_PORT: String(PORTS.gateway) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 120000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}
const verdictLine = (out, name) => (out.match(new RegExp(`^${name}\\s+(.*)$`, 'm')) || [])[1] || '';

test('an honest browser is cleared and buys, with no robot signs', { skip, timeout: 130000 }, async () => {
  const r = await attack('human');
  assert.equal(r.code, 0, r.out.slice(-400));
  assert.match(r.out, /Bought 1 x /, 'the purchase went through');
  const v = verdictLine(r.out, 'human');
  assert.match(v, /CLEARED/);
  assert.match(v, /looks human/);
});

test('the Ticket Tout (several tabs, one session) is caught and its payments are held', { skip, timeout: 130000 }, async () => {
  const r = await attack('tout');
  assert.equal(r.code, 0, r.out.slice(-400));
  const v = verdictLine(r.out, 'tout');
  assert.match(v, /ARREST PROPOSED|HELD FOR QUESTIONING/);
  assert.doesNotMatch(v, /CLEARED/);
  assert.match(r.out, /being held\. Waiting for a human/);
});

test('the Smooth Talker\'s forged note does not move the Cashier: the huge payment is refused', { skip, timeout: 130000 }, async () => {
  const r = await attack('talker');
  assert.equal(r.code, 0, r.out.slice(-400));
  assert.match(r.out, /refused: over what this wallet may ever spend/);
  assert.doesNotMatch(r.out, /Bought 1 x (Gaming GPU|Premium Package)/);
});

test('a naive headless bot announces itself and is held, not cleared', { skip, timeout: 130000 }, async () => {
  const r = await attack('headless');
  assert.equal(r.code, 0, r.out.slice(-400));
  const v = verdictLine(r.out, 'headless');
  assert.match(v, /HELD FOR QUESTIONING|ARREST PROPOSED/);
  assert.match(v, /T5/, 'both tells (HeadlessChrome and navigator.webdriver) make it tier 5');
  assert.match(r.out, /identity-tier-5/);
});

test('a stealth bot that hides its flags fools the ID check but is still caught by how it behaves', { skip, timeout: 130000 }, async () => {
  const r = await attack('stealth');
  assert.equal(r.code, 0, r.out.slice(-400));
  const v = verdictLine(r.out, 'stealth');
  assert.match(v, /HELD FOR QUESTIONING|ARREST PROPOSED/);
  assert.match(v, /looks human/, 'hiding the flags fools the ID check: nothing on its face gives it away');
  assert.match(r.out, /heavy-burst/);
});
