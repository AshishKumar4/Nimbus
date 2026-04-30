// Scaffold a project using @phosphor-icons/react (or similar barrel)
// to verify the synthesizer is general-purpose, not lucide-specific.
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

// Replace the seed's lucide-react imports with @phosphor-icons/react.
// Edit App.tsx + add @phosphor-icons/react to package.json.
// Stage the setup as a one-line bash invocation that runs to
// completion before we issue the install. Single PTY input avoids
// the queue-ahead echo problem.
const setup =
  `cd app && ` +
  `sed -i 's|"lucide-react": "[^"]*"|"@phosphor-icons/react": "^2.1.7"|' package.json && ` +
  `sed -i "s|from 'lucide-react'|from '@phosphor-icons/react'|" src/App.tsx && ` +
  `sed -i "s|import { Home, FileText, Zap }|import { House, FileText, Lightning }|" src/App.tsx && ` +
  `sed -i 's|icon: Home,|icon: House,|; s|icon: Zap,|icon: Lightning,|' src/App.tsx && ` +
  `npm install && npm run dev`;
w.send(JSON.stringify({ type: 'input', data: setup + '\r' }));

let viteReady = false;
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const stats = await fetch(BASE + '/s/' + sid + '/api/stats').then(r => r.json());
    if (stats?.vite?.running) { viteReady = true; console.log(`vite ready t=${i*2}s`); break; }
  } catch {}
}
if (!viteReady) {
  console.error('!!! vite never ready');
  console.log('=== shell tail ===');
  console.log(buf.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '').slice(-5000));
  // Probe diag for clues
  try {
    const d = await fetch(BASE + '/s/' + sid + '/api/_diag/memory').then(r => r.json());
    console.log('=== diag ===');
    console.log(JSON.stringify(d.counters, null, 2));
  } catch {}
  try { w.close(); } catch {}
  process.exit(2);
}
await new Promise(r => setTimeout(r, 5000));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  headless: 'new',
});
const page = await browser.newPage();
const requests = [];
const failed = [];
const errs = [];
page.on('request', r => requests.push({ url: r.url(), type: r.resourceType() }));
page.on('requestfailed', r => failed.push({ url: r.url(), failure: r.failure()?.errorText }));
page.on('pageerror', e => errs.push(String(e?.message || e)));
await page.setViewport({ width: 1280, height: 800 });
await page.goto(previewUrl, { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise(r => setTimeout(r, 6000));

const rootHtml = await page.evaluate(() => document.querySelector('#root')?.innerHTML ?? null);
const bodyText = await page.evaluate(() => document.body.innerText || '');
fs.mkdirSync('local', { recursive: true });
await page.screenshot({ path: 'local/wave1-2nd-barrel.png', fullPage: true });

// Probe synth bundle
const synthResp = await fetch(BASE + '/s/' + sid + '/preview/@modules/@phosphor-icons/react');
const synthBody = await synthResp.text();
console.log(`@phosphor-icons/react: status=${synthResp.status} size=${synthBody.length}`);
console.log(`  first 200 chars: ${synthBody.slice(0, 200)}`);

const externalUrls = requests
  .map(r => r.url)
  .filter(u => {
    let host;
    try { host = new URL(u).host; } catch { return false; }
    return host !== ALLOWED_HOST && !u.startsWith('data:') && !u.startsWith('blob:');
  });

console.log(`\n=== assertions ===`);
console.log(`#root.innerHTML length: ${rootHtml ? rootHtml.length : 'null'}`);
console.log(`body text length: ${bodyText.length}`);
console.log(`page errors: ${errs.length}`);
for (const e of errs.slice(0, 5)) console.log('  ' + e.slice(0, 200));
console.log(`failed requests: ${failed.length}`);
for (const f of failed.slice(0, 5)) console.log(`  ${f.url} (${f.failure})`);
console.log(`external URLs: ${externalUrls.length}`);
for (const u of externalUrls.slice(0, 10)) console.log('  ' + u);

await browser.close();
try { w.close(); } catch {}
process.exit(externalUrls.length === 0 && (rootHtml?.length ?? 0) > 1000 ? 0 : 1);
