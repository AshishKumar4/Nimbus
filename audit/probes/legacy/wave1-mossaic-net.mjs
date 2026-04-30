// Same network-isolation check as wave1-verify but for Mossaic.
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
const CHROME = '/root/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome';
const ALLOWED_HOST = new URL(BASE).host;
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
w.send(JSON.stringify({ type: 'input', data: `git clone ${REPO} && cd Mossaic && npm install && npm run dev\r` }));
let viteReady = false;
for (let i = 0; i < 90; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const stats = await fetch(BASE + '/s/' + sid + '/api/stats').then(r => r.json());
    if (stats?.vite?.running) { viteReady = true; console.log(`vite ready t=${i*2}s`); break; }
  } catch {}
}
if (!viteReady) { console.error('!!! vite never ready'); process.exit(2); }
await new Promise(r => setTimeout(r, 5000));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  headless: 'new',
});
const page = await browser.newPage();
const requests = [];
page.on('request', r => requests.push({ url: r.url(), method: r.method(), resourceType: r.resourceType() }));
await page.setViewport({ width: 1280, height: 800 });
await page.goto(previewUrl, { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise(r => setTimeout(r, 6000));

const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(r => ({ name: r.name, type: r.initiatorType })));
const allUrls = [previewUrl, ...resources.map(r => r.name), ...requests.map(r => r.url)];
const externalUrls = [];
const internalCount = {};
for (const u of allUrls) {
  let host;
  try { host = new URL(u).host; } catch { host = u; }
  if (host === ALLOWED_HOST) internalCount[host] = (internalCount[host] || 0) + 1;
  else if (!host.startsWith('data:') && host !== '' && !u.startsWith('blob:')) externalUrls.push(u);
}
fs.mkdirSync('local', { recursive: true });
await page.screenshot({ path: 'local/wave1-mossaic-net.png', fullPage: true });
fs.writeFileSync('local/wave1-mossaic-net.json', JSON.stringify({ ts: Date.now(), sid, previewUrl, internalCount, externalUrls, resources, requests }, null, 2));

const bodyText = await page.evaluate(() => document.body.innerText || '');
console.log(`internal hosts: ${JSON.stringify(internalCount)}`);
console.log(`external URLs: ${externalUrls.length}`);
for (const u of externalUrls.slice(0, 10)) console.log('  ' + u);
console.log(`body text length: ${bodyText.length}`);

await browser.close();
try { w.close(); } catch {}
process.exit(externalUrls.length === 0 && bodyText.length > 100 ? 0 : 1);
