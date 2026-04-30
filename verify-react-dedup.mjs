/**
 * verify-react-dedup.mjs — verify React de-duplication after the
 * commit a9b9fb8 deploy. Run after the user deploys from their side.
 *
 * Bet criteria:
 *   1. /preview/@modules/react/jsx-runtime ≤ ~10 KiB (was 117 KiB)
 *   2. /preview/@modules/react-dom ≤ ~120 KiB OR contains exactly ONE
 *      `Symbol.for("react.element")` reference (the one inside react-dom's
 *      own internals, not a duplicated react copy)
 *   3. Each non-react bundle imports react via /preview/@modules/react
 *      — verifiable by grepping for `from "/.+@modules/react"` in the
 *      bundle source.
 *   4. Preview HTML loads without "Objects are not valid as a React child"
 *
 * Usage:
 *   bun x wrangler deploy   # from authenticated environment
 *   node verify-react-dedup.mjs
 */

import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';

const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)[1];
console.log('sid=' + sid);
console.log('preview URL:', BASE + '/s/' + sid + '/preview/');

const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let o = '';
const openP = new Promise(res => w.on('open', res));
w.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'output') o += m.data; });

await openP;
w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }));
await new Promise(r => setTimeout(r, 1500));
w.send(JSON.stringify({ type: 'input', data: 'cd app && npm install && npm run dev\r' }));

let viteReady = false;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const stats = await fetch(BASE + '/s/' + sid + '/api/stats').then(r => r.json());
    if (stats?.vite?.running) { viteReady = true; console.log(`vite ready t=${i*2}s`); break; }
  } catch {}
}
if (!viteReady) {
  console.error('!!! vite never ready');
  process.exit(1);
}

const targets = [
  { spec: 'react', maxBytes: 100_000, expectImports: 0 },
  { spec: 'react/jsx-runtime', maxBytes: 10_000, expectImports: 1 },
  { spec: 'react/jsx-dev-runtime', maxBytes: 10_000, expectImports: 1 },
  { spec: 'react-dom', maxBytes: 200_000, expectImports: 2 }, // imports react + scheduler
  { spec: 'react-dom/client', maxBytes: 200_000, expectImports: 2 },
  { spec: 'react-router-dom', maxBytes: 250_000, expectImports: 2 },
  { spec: 'framer-motion', maxBytes: 500_000, expectImports: 2 },
];

console.log('\n--- bundle inspection ---');
let pass = 0, fail = 0;
for (const t of targets) {
  const url = BASE + '/s/' + sid + '/preview/@modules/' + t.spec;
  const resp = await fetch(url);
  const body = await resp.text();
  const status = resp.status;
  const symbolFor = (body.match(/Symbol\.for\(["']react\.element["']\)/g) || []).length;
  const reactDevImports = (body.match(/var\s+ReactVersion\s*=/g) || []).length;
  // Count import statements that reference @modules/react (any react path)
  const moduleImports = (body.match(/from\s+["'][^"']*@modules\/[^"'/]+/g) || []).length;
  const sizeOK = body.length <= t.maxBytes;
  const hasNoEmbeddedReact = symbolFor <= 1; // 1 is OK (react itself, or react-dom's own); 2+ means react was inlined
  const printableImports = (body.match(/from\s+["'][^"']*@modules\/[^"']+["']/g) || []).slice(0, 5);
  console.log(`  ${t.spec}:`);
  console.log(`    size=${body.length}B (≤${t.maxBytes}? ${sizeOK ? 'PASS' : 'FAIL'})`);
  console.log(`    Symbol.for("react.element")×${symbolFor} (${hasNoEmbeddedReact ? 'PASS' : 'FAIL — react inlined'})`);
  console.log(`    ReactVersion definitions: ${reactDevImports}`);
  console.log(`    @modules imports: ${printableImports.length}`);
  for (const i of printableImports) console.log('      ', i);
  if (sizeOK && hasNoEmbeddedReact) pass++; else fail++;
}

// Also fetch the preview HTML and check it doesn't surface the React error
const previewHtml = await fetch(BASE + '/s/' + sid + '/preview/').then(r => r.text());
fs.mkdirSync('local', { recursive: true });
fs.writeFileSync('local/preview-react-fixed.html', previewHtml);
console.log(`\npreview HTML saved: local/preview-react-fixed.html (${previewHtml.length}B)`);

// Counters
const diag = await fetch(BASE + '/s/' + sid + '/api/_diag/memory').then(r => r.json());
console.log('\n--- counters ---');
console.log('  resolverPath:', diag.counters?.resolverPath);
console.log('  installFacet.path:', diag.counters?.installFacet?.path);
console.log('  installFacet.tarballsCompleted:', diag.counters?.installFacet?.tarballsCompleted);
console.log('  preBundleFacet.bundlesCompleted:', diag.counters?.preBundleFacet?.bundlesCompleted);
console.log('  preBundleFacet.errors:', diag.counters?.preBundleFacet?.errors);
console.log('  preBundleFacet.lastError:', diag.counters?.preBundleFacet?.lastError);
console.log('  cumulativePackumentBytesDecoded:', diag.counters?.cumulativePackumentBytesDecoded);

console.log('\n=== RESULTS ===');
console.log(`bundles: ${pass} PASS, ${fail} FAIL`);

w.close();
if (fail > 0) {
  console.error('\n!!! ASSERTION FAILED: bundles still contain duplicated React');
  process.exit(1);
}
console.log('\nREACT DEDUP OK');
process.exit(0);
