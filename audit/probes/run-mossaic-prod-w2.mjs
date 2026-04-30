// W2 Mossaic prod regression. No browser dep — curl-style check via fetch().
//
// Asserts:
//   - clone + npm install + npm run dev all succeed on a fresh prod session
//   - vite reports running via /api/stats
//   - GET /preview/ returns 200 with a non-trivial HTML body
//   - all <script src=>, <link href=>, image src= URLs resolve same-host
//   - DO doesn't crash during the run (no error toast in WS output stream)
//
// Output: audit/probes/mossaic-prod-w2.txt (raw transcript + summary)

import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'sections'); // unused — final write to audit/probes/
const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
const ALLOWED_HOST = new URL(BASE).host;
const REPO = 'https://github.com/AshishKumar4/Mossaic';
const ARTIFACT = path.join(HERE, 'mossaic-prod-w2.txt');

const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };
fs.writeFileSync(ARTIFACT, '');

log(`==== MOSSAIC PROD W2 REGRESSION ====`);
log(`==== TIMESTAMP: ${new Date().toISOString()} ====`);
log(`==== BASE: ${BASE} ====`);

const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)[1];
log(`==== SID: ${sid} ====`);
const previewUrl = BASE + '/s/' + sid + '/preview/';

const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let buf = '';
let wsClosed = false;
w.on('close', () => { wsClosed = true; });
await new Promise((res, rej) => {
  w.on('open', res);
  w.on('error', rej);
  setTimeout(() => rej(new Error('ws timeout')), 15_000);
});
w.on('message', d => {
  try { const m = JSON.parse(d.toString()); if (m.type === 'output') buf += m.data; } catch {}
});
w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }));
await new Promise(r => setTimeout(r, 2000));
buf = '';

// Single command — clone + install + dev. dev will hold the shell open.
const cmd = `git clone ${REPO} && cd Mossaic && npm install && npm run dev &\r`;
log(`---- STEP cmd (clone+install+dev): git clone ${REPO} && cd Mossaic && npm install && npm run dev & ----`);
w.send(JSON.stringify({ type: 'input', data: cmd }));

// Poll /api/stats for vite ready up to 240s.
let viteReady = false;
let viteFiles = -1;
let stats = null;
const t0 = Date.now();
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    stats = await fetch(BASE + '/s/' + sid + '/api/stats').then(r => r.json()).catch(() => null);
    if (stats?.vite?.running) {
      viteReady = true;
      viteFiles = stats?.vfs?.files ?? stats?.vite?.files ?? -1;
      log(`---- vite ready t=${((Date.now() - t0) / 1000).toFixed(1)}s ----`);
      log(`---- stats: ${JSON.stringify(stats).slice(0, 800)} ----`);
      break;
    }
  } catch (e) {}
}
if (!viteReady) {
  log(`!!!! VITE NEVER READY after ${((Date.now() - t0) / 1000).toFixed(1)}s !!!!`);
  log(`---- last buffer (-2000): ${buf.slice(-2000)} ----`);
  log(`---- last stats: ${JSON.stringify(stats)?.slice(0, 800) || 'null'} ----`);
  log(`==== END MOSSAIC PROD W2 (FAIL: vite never ready) ====`);
  try { w.close(); } catch {}
  process.exit(2);
}

// Settle then capture WS output snapshot
await new Promise(r => setTimeout(r, 4000));
log(`---- WS output snapshot (last 4000 chars) ----`);
log(buf.slice(-4000).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
log(`---- end snapshot ----`);

// Now fetch /preview/ via plain fetch (no browser).
log(`---- GET ${previewUrl} ----`);
let html = '';
let status = 0;
try {
  const resp = await fetch(previewUrl, { redirect: 'follow' });
  status = resp.status;
  html = await resp.text();
  log(`status: ${status}`);
  log(`content-length: ${html.length}`);
  log(`first 600 chars: ${html.slice(0, 600).replace(/\n/g, '\\n')}`);
} catch (e) {
  log(`!!!! FETCH /preview/ FAILED: ${e.message} !!!!`);
  log(`==== END MOSSAIC PROD W2 (FAIL: preview fetch) ====`);
  try { w.close(); } catch {}
  process.exit(3);
}

// Parse out src=/href= URLs from the HTML
const urlRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const found = [];
let m;
while ((m = urlRegex.exec(html))) found.push(m[1]);
log(`---- URLs found in /preview/ HTML: ${found.length} ----`);
for (const u of found.slice(0, 30)) log(`  ${u}`);
if (found.length > 30) log(`  ... +${found.length - 30} more`);

// Bucket by host
const externalUrls = [];
const internalCount = {};
for (const u of found) {
  if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) continue;
  let abs;
  try { abs = new URL(u, previewUrl); } catch { continue; }
  if (abs.host === ALLOWED_HOST) internalCount[abs.host] = (internalCount[abs.host] || 0) + 1;
  else externalUrls.push(abs.href);
}
log(`---- internal host counts: ${JSON.stringify(internalCount)} ----`);
log(`---- external URLs: ${externalUrls.length} ----`);
for (const u of externalUrls) log(`  EXTERNAL: ${u}`);

// Issue WS poke to ensure session alive (no DO crash)
buf = '';
w.send(JSON.stringify({ type: 'input', data: 'echo ALIVE_$(date +%s)\r' }));
await new Promise(r => setTimeout(r, 3000));
const alive = /ALIVE_\d+/.test(buf);
log(`---- session alive after preview load: ${alive} ----`);
log(`---- buf tail after alive-check: ${buf.slice(-400).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')} ----`);

// Check /api/stats again to confirm DO didn't crash.
let stats2 = null;
try { stats2 = await fetch(BASE + '/s/' + sid + '/api/stats').then(r => r.json()); } catch {}
log(`---- /api/stats post-preview: ${JSON.stringify(stats2).slice(0, 800)} ----`);

// Verdict
const passed =
  status === 200 &&
  html.length > 200 &&
  externalUrls.length === 0 &&
  alive &&
  stats2?.vite?.running === true;

log(``);
log(`==== VERDICT: ${passed ? 'PASS' : 'FAIL'} ====`);
log(`  status=${status}, htmlLen=${html.length}, external=${externalUrls.length}, alive=${alive}, viteRunning=${stats2?.vite?.running}`);
log(`==== END MOSSAIC PROD W2 ====`);

try { w.close(); } catch {}
process.exit(passed ? 0 : 1);
