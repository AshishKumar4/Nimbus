// Follow-up: capture per-package SQL inode existence via VFS listing.

import { runProbe, nodeEvalBase64 } from './_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'w25-diag-fastify2.txt');
fs.writeFileSync(ARTIFACT, '');
const BASE = 'https://nimbus.ashishkmr472.workers.dev';

// 1. Fresh session
const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = (r.headers.get('location') || '').match(/\/s\/([^\/]+)/)[1];
fs.appendFileSync(ARTIFACT, `SID=${sid}\n`);
console.log('SID', sid);

const probe = `
const fs = require('fs');
const cp = require('child_process');
const NM = '/home/user/app/node_modules';

// Count inodes by recursive walk of NM via fs (in-memory tree)
function countAll(d) {
  let f=0, dd=0;
  let ents;
  try { ents = fs.readdirSync(d); } catch { return [0,0]; }
  dd++;
  for (const e of ents) {
    const p = d + '/' + e;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) { const [ff,ddd] = countAll(p); f+=ff; dd+=ddd; }
    else f++;
  }
  return [f, dd];
}

console.log('STATS_BEGIN');
const [filesVisible, dirsVisible] = countAll(NM);
console.log('VISIBLE files=' + filesVisible + ' dirs=' + dirsVisible);

// Try to query stats via the VFS internal endpoint - use process.stat or HTTP
// We're inside a facet, so direct fetch to /api/stats works via session URL.
// (We can't easily — facets are sandboxed. Skip this layer.)

// For each expected pkg, report exists, parent-children-of-parent, etc.
const PKGS = ['fastify','avvio','fastq','pino','semver','fast-json-stringify',
              'find-my-way','light-my-request','process-warning','rfdc',
              'secure-json-parse','toad-cache'];
console.log('PER_PKG_BEGIN');
for (const p of PKGS) {
  const dir = NM + '/' + p;
  const pj = dir + '/package.json';
  let res = { pkg: p };
  try {
    const st = fs.statSync(dir);
    res.dirExists = true;
    res.dirIsDir = st.isDirectory();
    res.entryCount = fs.readdirSync(dir).length;
  } catch (e) { res.dirExists = false; res.dirErr = e.code; }
  try {
    const st = fs.statSync(pj);
    res.pjExists = true; res.pjSize = st.size;
  } catch (e) { res.pjExists = false; res.pjErr = e.code; }
  console.log(JSON.stringify(res));
}
console.log('PER_PKG_END');

// readdir of NM root (this should fire the W2.5b diagnostic if size mismatch)
console.log('NM_ROOT_BEGIN');
console.log(JSON.stringify(fs.readdirSync(NM)));
console.log('NM_ROOT_END');
console.log('STATS_END');
`;

await runProbe('w25-diag2', [
  { kind: 'cmd', cmd: 'cd app && npm install fastify', timeoutMs: 90_000, waitFor: /added \d+ package|npm warn|npm error/ },
  // Force readdir on every package dir + NM root (this will trigger W2.5b diag in worker)
  { kind: 'cmd', cmd: nodeEvalBase64(probe), timeoutMs: 30_000 },
  // Also: stat directly via node
  { kind: 'cmd', cmd: 'ls /home/user/app/node_modules | wc -l', timeoutMs: 10_000 },
  { kind: 'cmd', cmd: 'ls /home/user/app/node_modules', timeoutMs: 10_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });

// Fetch /api/stats for SQL view
const statsR = await fetch(`${BASE}/s/${sid}/api/stats`);
const stats = await statsR.json().catch(() => ({}));
fs.appendFileSync(ARTIFACT, '\n=== /api/stats ===\n' + JSON.stringify(stats, null, 2) + '\n');
console.log('done', ARTIFACT);
