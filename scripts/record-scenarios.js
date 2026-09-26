'use strict';
/**
 * Records the Playwright attacks as videos: one per scenario, plus one reel with all of them.
 * Each video shows what the visitor sees (the shop tab or tabs, left), what the precinct sees (the live dashboard, right)
 * and a caption on top. Where the story needs a human, a scripted "demo Judge" uses the dashboard's real Sign / Refuse buttons.
 *
 *   npm run record                                  all five scenarios into recordings/<timestamp>/
 *   npm run record -- --scenario tout,headless      some of them
 *   npm run record -- --out ~/Videos/demo           a directory of your choice
 *   SEED=7 npm run record                           replay the same choices
 *
 * Needs the stack running (npm start), Google Chrome, and Playwright's video encoder (npx playwright install ffmpeg).
 * MP4 files and the reel need the system `ffmpeg`; without it you still get the .webm videos.
 */

require('../gateway/env').loadEnv();
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const V = require('../agents/variety');
const { makeScenarios, SCENARIOS, NAMES } = require('./lib/scenarios');

// ─── options ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const wanted = opt('scenario', 'all') === 'all' ? SCENARIOS : String(opt('scenario')).split(',');
for (const s of wanted) if (!SCENARIOS.includes(s)) { console.error(`Unknown scenario "${s}". Choose from: ${SCENARIOS.join(', ')}, or all.`); process.exit(2); }
const UI_PORT = Number(process.env.UI_PORT) || 3005;
const ADMIN = `http://localhost:${Number(process.env.ADMIN_PORT) || 3002}`;
const UI = `http://localhost:${UI_PORT}`;
const SHOP = `${UI}/shop.html`;
const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const OUT = path.resolve(String(opt('out', path.join(__dirname, '..', 'recordings', ts))).replace(/^~/, os.homedir()));
const RAW = path.join(OUT, '.raw');
const rng = V.fromEnv();
const W = 1600, H = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (who, msg) => console.log(`[${new Date().toLocaleTimeString()}] ${who.padEnd(12)} ${msg}`);
const NORMAL_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const haveEncoder = () => fs.existsSync(path.join(os.homedir(), '.cache', 'ms-playwright')) &&
  fs.readdirSync(path.join(os.homedir(), '.cache', 'ms-playwright')).some((d) => d.startsWith('ffmpeg'));
const sysFfmpeg = () => { const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }); return r.status === 0; };

// ─── the recorded world: one stage page per scenario ────────────────────────
const recorded = [];   // { scenario, webm }
let currentScenario = null;
let RUN_STAMP = '';   // the dashboard on the stage only pops up approvals for this run's visitors, never leftovers

/** Approve or refuse something on camera, through the dashboard's own modal and buttons. */
async function judgeOnCamera(session, { sessionId, action, decision, before, after }) {
  const dash = session.page.frame({ name: 'dash' });
  const pending = await (await fetch(`${ADMIN}/approvals`)).json();
  const item = pending.filter((a) => a.sessionId === sessionId && a.action === action).pop();
  if (!dash || !item) return false;
  session.caption(before, 'wait');
  await dash.evaluate((a) => showApprovalModal(a.hash, a), item);      // the dashboard's own function: the same modal a real approval opens
  await sleep(3200);                                                    // let the viewer read the charge and the evidence
  await dash.locator(decision === 'approve' ? '#btnBossApprove' : '#btnBossDeny').click();
  session.caption(after, decision === 'approve' ? 'ok' : 'bad');
  return true;
}

const world = {
  async session({ honest = false, headless = false, stealth = false, title = '' } = {}) {
    const launchArgs = honest ? ['--disable-blink-features=AutomationControlled'] : [];
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });
    const context = await browser.newContext({
      viewport: { width: W, height: H },
      recordVideo: { dir: RAW, size: { width: W, height: H } },
      ...(honest || stealth ? { userAgent: NORMAL_UA } : {}),
    });
    if (stealth) await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    const page = await context.newPage();
    await page.goto(`${UI}/cinema.html`);
    await page.evaluate(([t, d]) => { window.stage.title(t); window.stage.dashboard(d); }, [title, `${UI}/?focus=${RUN_STAMP}`]);
    await page.waitForTimeout(2500);                                    // the dashboard connects and loads its recent log
    const scenario = currentScenario;
    const tabOf = (i) => {
      const fl = page.frameLocator(`#tab${i}`);
      return {
        page,
        goto: (url) => page.evaluate(([n, u]) => window.stage.load(n, u), [i, url]),
        click: (sel) => fl.locator(sel).first().click(),
        fill: (sel, text) => fl.locator(sel).first().fill(text),
        text: (sel) => fl.locator(sel).first().textContent(),
        box: (sel) => fl.locator(sel).first().boundingBox(),
      };
    };
    const s = {
      page,
      tabs: async (n) => { await page.evaluate((k) => window.stage.setTabs(k), n); return Array.from({ length: n }, (_, i) => tabOf(i)); },
      caption: (text, kind) => { page.evaluate(([t, k]) => window.stage.caption(t, k), [text, kind || 'info']).catch(() => {}); },
      async close() {
        const video = page.video();
        await context.close();                                          // finishes and writes the video file
        await browser.close().catch(() => {});
        if (video && !recorded.some((r) => r.scenario === scenario)) recorded.push({ scenario, webm: await video.path() });
      },
    };
    s.caption('', 'info');
    return s;
  },
};

// ─── main ───────────────────────────────────────────────────────────────────
(async () => {
  if (!haveEncoder()) { console.error('Playwright\'s video encoder is missing. Run: npx playwright install ffmpeg'); process.exit(1); }
  try { const r = await fetch(`${UI}/cinema.html`); if (!r.ok) throw new Error(`HTTP ${r.status}`); }
  catch (e) { console.error(`Cannot reach ${UI} (${e.message}). Start the stack first: npm start`); process.exit(1); }
  try { await fetch(`${ADMIN}/stats/all`); } catch (_) { console.error(`Cannot reach the gateway admin API at ${ADMIN}. Start the stack first: npm start`); process.exit(1); }
  fs.mkdirSync(RAW, { recursive: true });

  const { RUN, stamp } = makeScenarios({ rng, sleep, say, shopUrl: SHOP, adminUrl: ADMIN, slow: 1 });
  RUN_STAMP = stamp;
  console.log(`Recording ${wanted.join(', ')} · ${W}x${H} · seed ${rng.seed} (SEED=${rng.seed} to replay)`);
  console.log(`Saving to ${OUT}\n`);

  const summary = [];
  for (const name of wanted) {
    currentScenario = name;
    let result = null, error = null;
    try {
      result = await RUN[name](world);
      const s = result.session;
      if (s) {
        // The story beats that need a human: shown with the dashboard's real buttons.
        if (name === 'tout') {
          const ok = await judgeOnCamera(s, { sessionId: result.id, action: 'BLOCK_SESSION', decision: 'approve',
            before: 'The Judge is asked to sign the arrest warrant...', after: 'The Judge signs. The door is slammed on the Ticket Tout.' });
          if (ok) {
            await sleep(2500);
            try { await result.tabs[0].click(`[data-testid=buy-${result.target.id}]`); await sleep(1800); s.caption('One more try: "The Desk Sergeant has shut the door on you (403)"', 'bad'); } catch (_) {}
            await sleep(3500);
          }
        } else if (name === 'headless' || name === 'stealth') {
          const ok = await judgeOnCamera(s, { sessionId: result.id, action: 'WALLET_CHECKOUT', decision: 'deny',
            before: 'The Judge is asked about the held payment...', after: 'The Judge refuses. Nothing is charged.' });
          if (ok) await sleep(4500);   // the shop page follows the decision live
        }
        await s.close();
      }
    } catch (e) { error = e.message.split('\n')[0]; console.error(`  ${name} failed: ${error}`); }
    summary.push({ scenario: name, name: NAMES[name], sessionId: result && result.id, said: result && result.said, verdict: result && result.verdict, error });
    await sleep(1500);
    console.log('');
  }

  // ─── name the files, make MP4s and the reel ───
  const files = [];
  for (const r of recorded) {
    const n = String(wanted.indexOf(r.scenario) + 1).padStart(2, '0');
    const base = `${n}-${r.scenario}`;
    const webm = path.join(OUT, `${base}.webm`);
    fs.renameSync(r.webm, webm);
    files.push({ scenario: r.scenario, base, webm });
  }
  try { fs.rmSync(RAW, { recursive: true, force: true }); } catch (_) { /* leave it */ }

  if (sysFfmpeg()) {
    const mp4s = [];
    for (const f of files) {
      const mp4 = path.join(OUT, `${f.base}.mp4`);
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f.webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-r', '25', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
      if (r.status === 0) { f.mp4 = mp4; mp4s.push(mp4); } else console.error(`  could not make ${f.base}.mp4: ${(r.stderr || '').split('\n')[0]}`);
    }
    if (mp4s.length > 1) {
      const list = path.join(OUT, '.reel.txt');
      fs.writeFileSync(list, mp4s.map((m) => `file '${m.replace(/'/g, "'\\''")}'`).join('\n'));
      const reel = path.join(OUT, 'all-scenarios.mp4');
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', reel], { encoding: 'utf8' });
      fs.rmSync(list, { force: true });
      if (r.status === 0) files.reel = reel; else console.error(`  could not make the reel: ${(r.stderr || '').split('\n')[0]}`);
    }
  } else console.log('(system ffmpeg not found: only .webm files were written)');

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ recordedAt: new Date().toISOString(), seed: rng.seed, ui: UI, results: summary }, null, 2));
  console.log('══════════════ Recordings ══════════════');
  console.log(`Folder: ${OUT}`);
  for (const f of fs.readdirSync(OUT).sort()) {
    const size = (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1);
    console.log(`  ${f.padEnd(24)} ${size} MB`);
  }
  console.log('\n══════════════ What happened ══════════════');
  for (const r of summary) console.log(`${r.scenario.padEnd(9)} ${r.error ? `ERROR ${r.error}` : `${r.verdict ? `${r.verdict.route} ${r.verdict.threat}%` : '(session forgotten)'}  "${(r.said || '').slice(0, 90)}"`}`);
})().catch((e) => { console.error(e); process.exit(1); });
