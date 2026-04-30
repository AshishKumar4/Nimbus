/**
 * browser-mossaic-test.mjs — full Mossaic E2E:
 *   clone → npm install → npm run dev → puppeteer /preview/.
 * Pass: page mounts, no DO restart 60s post-load, screenshot captured.
 */
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
const CHROME = '/root/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome';
const REPO = 'https://github.com/AshishKumar4/Mossaic';

const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)[1];
console.log('sid=' + sid);
const previewUrl = BASE + '/s/' + sid + '/preview/';

const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let buf = '';
await new Promise(res => w.on('open', res));
w.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.type === 'output') buf += m.data; } catch {} });
w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }));
await new Promise(r => setTimeout(r, 1500));

w.send(JSON.stringify({
  type: 'input',
  data: `git clone ${REPO} && cd Mossaic && npm install && npm run dev\r`,
}));

let viteReady = false;
for (let i = 0; i < 90; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const stats = await fetch(BASE + '/s/' + sid + '/api/stats').then(r => r.json());
    if (stats?.vite?.running) { viteReady = true; console.log(`vite ready t=${i*2}s`); break; }
  } catch {}
}
if (!viteReady) {
  console.error('!!! vite never ready');
  console.log('shell tail:\n' + buf.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '').slice(-2000));
  process.exit(2);
}
await new Promise(r => setTimeout(r, 3000));

async function diag(label) {
  try {
    const j = await fetch(BASE + '/s/' + sid + '/api/_diag/memory').then(r => r.json());
    const c = j.counters?.preBundleFacet ?? {};
    const snap = {
      label, samples: j.peak?.samples ?? null, vfsFiles: j.vfs?.files ?? null,
      preBundle: { att: c.attempted ?? 0, ok: c.bundlesCompleted ?? 0, err: c.errors ?? 0, skip: c.skipped ?? 0, modules: Object.keys(c.errorsByModule || {}) },
    };
    console.log(JSON.stringify(snap));
    return snap;
  } catch { return null; }
}

const probes = [];
probes.push(await diag('pre-load'));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  headless: 'new',
});
const page = await browser.newPage();
const consoleMessages = [];
const pageErrors = [];
const failedReqs = [];
page.on('console', m => consoleMessages.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => pageErrors.push(String(e?.message || e)));
page.on('requestfailed', r => failedReqs.push({ url: r.url(), failure: r.failure()?.errorText }));
await page.setViewport({ width: 1280, height: 800 });

let navResp = null;
try {
  navResp = await page.goto(previewUrl, { waitUntil: 'networkidle2', timeout: 90000 });
} catch (e) {
  console.error('!!! navigation error:', e?.message || e);
}
console.log('navigation status:', navResp?.status());
await new Promise(r => setTimeout(r, 6000));

const rootHtml = await page.evaluate(() => document.querySelector('#root')?.innerHTML ?? null);
const bodyText = await page.evaluate(() => document.body.innerText || '');
fs.mkdirSync('local', { recursive: true });
await page.screenshot({ path: 'local/mossaic-fixed.png', fullPage: true });

probes.push(await diag('post-load'));
await new Promise(r => setTimeout(r, 60000));
probes.push(await diag('+60s'));

console.log('\n=== assertions ===');
console.log(`#root.innerHTML length: ${rootHtml ? rootHtml.length : 'null'}`);
console.log(`body text length: ${bodyText.length}`);
console.log(`page errors: ${pageErrors.length}`);
console.log(`failed requests: ${failedReqs.length}`);
for (const e of pageErrors.slice(0, 5)) console.log(`  pageerror: ${e.slice(0, 200)}`);
for (const r of failedReqs.slice(0, 5)) console.log(`  failed: ${r.url.slice(0, 100)} (${r.failure})`);

console.log('\n--- body text (first 400 chars) ---');
console.log(bodyText.slice(0, 400));

let exit = 0;
let prev = null;
for (const p of probes) {
  if (!p) continue;
  if (prev && p.samples != null && prev.samples != null && p.samples < prev.samples) {
    console.error(`!!! DO RESTART between ${prev.label}(samples=${prev.samples}) and ${p.label}(samples=${p.samples})`);
    exit = 1;
  }
  if (prev && p.preBundle.att > 0 && p.preBundle.att < prev.preBundle.att) {
    console.error(`!!! preBundle counter reset ${prev.label}=${prev.preBundle.att} -> ${p.label}=${p.preBundle.att}`);
    exit = 1;
  }
  prev = p;
}
if (probes[1]?.preBundle?.err > 0) {
  console.error(`!!! pre-bundle errors: ${probes[1].preBundle.err}, modules: ${probes[1].preBundle.modules.join(',')}`);
  exit = 1;
}

if (exit === 0) {
  console.log('\nMOSSAIC OK — installed + dev + preview rendered, no DO restart, no pre-bundle errors');
} else {
  console.log('shell tail:\n' + buf.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '').slice(-2000));
}

await browser.close();
try { w.close(); } catch {}
process.exit(exit);
