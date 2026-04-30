// Wave 1 regression check post-W2.
//
// Wave 1 contract: /preview/ on a fresh starter-app session must serve from
// nimbus.ashishkmr472.workers.dev only — zero external hosts. Specifically:
//   - synthetic-entry barrel for lucide
//   - React dedup
//   - Tailwind vendored at /preview/__nimbus_assets/tailwind-play.js
//   - no jsdelivr/unpkg/esm.sh URLs in the served HTML
//
// W2 changed the runtime resolver and the bare-builtin handler in
// vite-dev-server.ts. Confirm /preview/ still has external host count = 0.
//
// Output: audit/probes/wave1-regression-w2.txt

import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
const ALLOWED_HOST = new URL(BASE).host;
const ARTIFACT = path.join(HERE, 'wave1-regression-w2.txt');

const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };
fs.writeFileSync(ARTIFACT, '');

log(`==== WAVE 1 REGRESSION POST-W2 ====`);
log(`==== TIMESTAMP: ${new Date().toISOString()} ====`);
log(`==== BASE: ${BASE} ====`);

// /new on a fresh session lands you in the starter app already.
const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)[1];
log(`==== SID: ${sid} ====`);
const previewUrl = BASE + '/s/' + sid + '/preview/';

const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let buf = '';
await new Promise((res, rej) => {
  w.on('open', res); w.on('error', rej);
  setTimeout(() => rej(new Error('ws timeout')), 15_000);
});
w.on('message', d => {
  try { const m = JSON.parse(d.toString()); if (m.type === 'output') buf += m.data; } catch {}
});
w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }));
await new Promise(r => setTimeout(r, 1500));

// Starter app lives in ~/app/ on every fresh /new session. Issue the same
// invocation wave1-verify.mjs uses.
buf = '';
w.send(JSON.stringify({ type: 'input', data: 'cd app && npm install && npm run dev\r' }));

let viteReady = false;
const t0 = Date.now();
let stats = null;
for (let i = 0; i < 90; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    stats = await fetch(BASE + '/s/' + sid + '/api/stats').then(r => r.json());
    if (stats?.vite?.running) {
      viteReady = true;
      log(`---- vite ready t=${((Date.now() - t0) / 1000).toFixed(1)}s ----`);
      break;
    }
  } catch {}
}
if (!viteReady) {
  log(`!!!! vite never ready !!!!`);
  log(`buf tail: ${buf.slice(-2000)}`);
  log(`==== END (FAIL) ====`);
  try { w.close(); } catch {}
  process.exit(2);
}

// Settle, then fetch /preview/
await new Promise(r => setTimeout(r, 4000));
const resp = await fetch(previewUrl, { redirect: 'follow' });
const html = await resp.text();
log(`---- GET /preview/ → ${resp.status} (${html.length} bytes) ----`);
log(`first 500 chars: ${html.slice(0, 500).replace(/\n/g, '\\n')}`);

// Extract URLs from the served HTML AND recursively follow same-host JS modules
// to confirm they themselves don't reference external hosts. (One-level deep is
// the cheap version; two levels would be more thorough.)
const urlRegex = /(?:src|href|from\s+["'])\s*=?\s*["']?([^"'\s>]+)/gi;
const seen = new Set();
const externalUrls = new Set();
const internalCount = {};

function classify(u) {
  if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return null;
  try {
    const abs = new URL(u, previewUrl);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    return abs;
  } catch { return null; }
}

const queue = [];
let m;
while ((m = urlRegex.exec(html))) {
  const abs = classify(m[1]);
  if (!abs) continue;
  if (abs.host === ALLOWED_HOST) {
    internalCount[abs.host] = (internalCount[abs.host] || 0) + 1;
    if (!seen.has(abs.href) && (abs.pathname.endsWith('.js') || abs.pathname.endsWith('.mjs') || abs.pathname.includes('/@modules/'))) {
      queue.push(abs.href);
    }
    seen.add(abs.href);
  } else {
    externalUrls.add(abs.href);
  }
}

log(`---- top-level: internal=${JSON.stringify(internalCount)} external=${externalUrls.size} ----`);
log(`---- crawling ${queue.length} same-host JS modules for transitive externals ----`);

let crawled = 0;
const subRegex = /(?:from\s+["']|import\s*\(\s*["']|src\s*=\s*["'])([^"'\s>)]+)/g;
const importRegex = /import\s*[\w*${},\s]*from\s*["']([^"']+)["']/g;
const exportFromRegex = /export\s*[*\w{},\s]*from\s*["']([^"']+)["']/g;
const dynImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

for (const url of queue.slice(0, 40)) {
  try {
    const r = await fetch(url);
    if (!r.ok) continue;
    const txt = await r.text();
    crawled++;
    for (const re of [importRegex, exportFromRegex, dynImportRegex]) {
      re.lastIndex = 0;
      let mm;
      while ((mm = re.exec(txt))) {
        const abs = classify(mm[1]);
        if (!abs) continue;
        if (abs.host === ALLOWED_HOST) {
          internalCount[abs.host] = (internalCount[abs.host] || 0) + 1;
        } else {
          externalUrls.add(abs.href);
        }
      }
    }
  } catch {}
}
log(`---- crawled ${crawled} JS modules (sample: ${queue.slice(0, 5).join(', ')}) ----`);

log(`---- final: internal=${JSON.stringify(internalCount)} external=${externalUrls.size} ----`);
for (const u of externalUrls) log(`  EXTERNAL: ${u}`);

// Tailwind vendor check
let twOk = false;
try {
  const r = await fetch(BASE + '/s/' + sid + '/preview/__nimbus_assets/tailwind-play.js');
  twOk = r.status === 200 && /javascript/.test(r.headers.get('content-type') || '');
  log(`---- tailwind-play.js: status=${r.status} ct=${r.headers.get('content-type')} ----`);
} catch (e) {
  log(`---- tailwind-play.js fetch failed: ${e.message} ----`);
}

const passed = externalUrls.size === 0 && resp.status === 200 && html.length > 200;
log(``);
log(`==== VERDICT: ${passed ? 'PASS' : 'FAIL'} ====`);
log(`  external=${externalUrls.size}, status=${resp.status}, htmlLen=${html.length}, twOk=${twOk}`);
log(`==== END WAVE1 REGRESSION ====`);

try { w.close(); } catch {}
process.exit(passed ? 0 : 1);
