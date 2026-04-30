/**
 * wave1-verify.mjs — Wave 1 contract verification.
 *
 * Asserts on prod:
 *   1. Starter app installs + dev-server boots cleanly
 *   2. Browser-load /preview/ renders the Nimbus Starter UI
 *   3. Tailwind utility classes are computed by the embedded JIT
 *      (verifies our edge-vendored bundle is functional)
 *   4. EVERY resource fetched during the page load originates from
 *      nimbus.ashishkmr472.workers.dev — zero external hosts.
 *   5. /preview/__nimbus_assets/tailwind-play.js returns 200 with
 *      JS content-type and the expected first bytes.
 *
 * Output:
 *   - local/wave1-network-isolated.png — full-page screenshot
 *   - local/wave1-resources.json — every resource URL + initiator
 *   - exit 0 on pass, 1 on any contract violation.
 */
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
const CHROME = '/root/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome';
const ALLOWED_HOST = new URL(BASE).host;

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

w.send(JSON.stringify({ type: 'input', data: 'cd app && npm install && npm run dev\r' }));

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

// 5. Quick HEAD/GET on the asset endpoint.
const assetUrl = BASE + '/s/' + sid + '/preview/__nimbus_assets/tailwind-play.js';
const assetResp = await fetch(assetUrl);
const assetBody = await assetResp.text();
console.log(`asset endpoint: status=${assetResp.status} size=${assetBody.length} ct=${assetResp.headers.get('content-type')} cc=${assetResp.headers.get('cache-control')} ver=${assetResp.headers.get('x-tailwind-play-version')}`);
const assetOk =
  assetResp.status === 200 &&
  /javascript/i.test(assetResp.headers.get('content-type') || '') &&
  assetBody.startsWith('(()=>{') &&
  assetBody.length > 200_000;

// Browser-side Network capture.
const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  headless: 'new',
});
const page = await browser.newPage();
const requests = [];
const failed = [];
page.on('request', r => requests.push({ url: r.url(), method: r.method(), resourceType: r.resourceType() }));
page.on('requestfailed', r => failed.push({ url: r.url(), failure: r.failure()?.errorText }));
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e?.message || e)));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.setViewport({ width: 1280, height: 800 });
const navResp = await page.goto(previewUrl, { waitUntil: 'networkidle2', timeout: 90000 });
console.log('navigation status:', navResp?.status());
// Idle settle so any deferred MutationObserver / Tailwind class detection runs.
await new Promise(r => setTimeout(r, 5000));

// 3. Verify a Tailwind class actually applied. Pick an element with a known
//    utility from the seed (App.tsx uses bg-slate-950/30 etc.). Easier: pick
//    ANY element whose class list contains a tailwind utility, and assert
//    its computed style differs from the browser default.
const tailwindOk = await page.evaluate(() => {
  // Find an element with a bg-* class and assert its computed background
  // is not the default transparent rgba(0,0,0,0).
  const el = document.querySelector('[class*="bg-"]');
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  return { found: true, background: cs.backgroundColor, color: cs.color, classes: el.className };
});
console.log('tailwind probe:', JSON.stringify(tailwindOk).slice(0, 300));

const rootHtml = await page.evaluate(() => document.querySelector('#root')?.innerHTML ?? null);
const bodyText = await page.evaluate(() => document.body.innerText || '');
fs.mkdirSync('local', { recursive: true });
await page.screenshot({ path: 'local/wave1-network-isolated.png', fullPage: true });

// 4. Audit Network: list every host that received a request.
const resources = await page.evaluate(() => {
  return performance.getEntriesByType('resource').map(r => ({
    name: r.name,
    initiatorType: r.initiatorType,
    transferSize: r.transferSize,
  }));
});
// Add the page navigation itself (not in resource entries on Chromium).
const allUrls = [previewUrl, ...resources.map(r => r.name), ...requests.map(r => r.url)];
const externalUrls = [];
const internalCount = {};
for (const u of allUrls) {
  let host;
  try { host = new URL(u).host; } catch { host = u; }
  if (host === ALLOWED_HOST) {
    internalCount[host] = (internalCount[host] || 0) + 1;
  } else if (host.startsWith('data:') || host === '' || u.startsWith('blob:') || u.startsWith('data:')) {
    // data: / blob: URLs are inline, not network egress
  } else {
    externalUrls.push(u);
  }
}
fs.writeFileSync('local/wave1-resources.json', JSON.stringify({
  ts: Date.now(),
  sid,
  previewUrl,
  allowedHost: ALLOWED_HOST,
  resources,
  requests,
  externalUrls,
  internalCount,
  consoleErrors,
  failed,
}, null, 2));

console.log('\n=== assertions ===');
console.log(`#root.innerHTML length: ${rootHtml ? rootHtml.length : 'null'}`);
console.log(`body text length: ${bodyText.length}`);
console.log(`requests captured: ${requests.length}`);
console.log(`resource entries: ${resources.length}`);
console.log(`internal hosts: ${JSON.stringify(internalCount)}`);
console.log(`external URLs: ${externalUrls.length}`);
for (const u of externalUrls.slice(0, 10)) console.log('  ' + u);
console.log(`failed requests: ${failed.length}`);
for (const f of failed.slice(0, 5)) console.log(`  ${f.url} (${f.failure})`);
console.log(`page console errors: ${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e.slice(0, 200)}`);
console.log(`tailwind asset endpoint OK: ${assetOk}`);

let exit = 0;
if (externalUrls.length > 0) {
  console.error('\n!!! CONTRACT VIOLATION: external URL fetches detected');
  exit = 1;
}
if (!assetOk) {
  console.error('\n!!! tailwind-play.js asset endpoint returned unexpected response');
  exit = 1;
}
if (!tailwindOk.found || !tailwindOk.background || tailwindOk.background === 'rgba(0, 0, 0, 0)') {
  console.error('\n!!! Tailwind utility classes did not render — JIT did not run');
  exit = 1;
}
if (!rootHtml || rootHtml.length < 1000) {
  console.error('\n!!! #root rendered too little content');
  exit = 1;
}
if (bodyText.length < 100) {
  console.error('\n!!! body text too short');
  exit = 1;
}

if (exit === 0) {
  console.log('\nWAVE 1 OK — preview renders, Tailwind JIT applied, ZERO external hosts');
}

await browser.close();
try { w.close(); } catch {}
process.exit(exit);
