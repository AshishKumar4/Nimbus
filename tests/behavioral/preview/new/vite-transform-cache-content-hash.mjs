#!/usr/bin/env bun
// behavioral/preview/new/vite-transform-cache-content-hash —
// the persistent user-module transform cache (user_module_transforms,
// keyed vfs_path + content_hash + BUNDLER_VERSION) must:
//   1. serve a transformed user .tsx module, and
//   2. NEVER serve a stale transform after the source content changes —
//      even if the in-memory moduleCache invalidation were to miss the
//      write — because the cache is content-addressed (B5 fix).
//
// This is the user-visible contract of O2 (persist user-module
// transforms). The hibernation-survival property (B4 fix) is covered by
// the unit test (tests/unit/npm-cache-user-transforms.mjs) since forcing
// a real DO hibernation mid-probe isn't reliably observable black-box;
// here we assert the content-hash staleness guarantee end-to-end.
//
// Public surface: GET /s/<sid>/preview/<module>.tsx (the dev-server
// transform endpoint the browser iframe uses). Strictly black-box.
//
// failing if regressed: a path-only cache would return the FIRST
// transform's output (old marker) for the second request after the edit.

import WebSocket from 'ws';
import { mintSession, wsHeaders, requestHeaders, deleteSession, sleep, stripAnsi }
  from '../../_driver.mjs';

const BASE = process.env.BASE;
if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const WS_BASE = BASE.replace(/^http/, 'ws');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
};

const sid = await mintSession();
console.log(`behavioral/preview/new/vite-transform-cache-content-hash — BASE=${BASE} sid=${sid}`);

const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`, wsHeaders());
let buf = '';
let tConn = false, tClosed = false;
ws.on('open', () => { tConn = true; });
ws.on('close', () => { tClosed = true; });
ws.on('error', () => {});
ws.on('message', (data) => {
  try { const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'output' && typeof m.data === 'string') buf += m.data; } catch {}
});

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate(stripAnsi(buf))) return Date.now() - t0;
    if (tClosed) throw new Error(`terminal closed waiting for ${label}`);
    await sleep(50);
  }
  throw new Error(`waitFor(${label}) timeout ${timeoutMs}ms; tail=${JSON.stringify(stripAnsi(buf).slice(-300))}`);
}
const cmd = (line) => ws.send(JSON.stringify({ type: 'input', data: line + '\r' }));
async function run(line, timeoutMs = 30_000) {
  const before = buf.length;
  cmd(line);
  await waitFor((b) => buf.length > before && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    timeoutMs, `prompt after ${line}`);
}
const writeFile = (path, content) => {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return `node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`;
};

try {
  {
    const t0 = Date.now();
    while (!tConn && Date.now() - t0 < 15_000) await sleep(50);
    if (!tConn) throw new Error('terminal connect timeout');
  }
  await waitFor((b) => /[$#>]\s*$/.test(b.trimEnd().slice(-3)), 10_000, 'initial prompt');

  const dir = '/home/user/xform-cache';
  await run('cd /home/user', 5000);
  await run(`mkdir -p ${dir}/src`, 5000);
  await run(writeFile(`${dir}/package.json`,
    JSON.stringify({ name: 'xform-cache', type: 'module', scripts: { dev: 'vite --host 0.0.0.0 --port 5173' } })), 10_000);
  await run(writeFile(`${dir}/index.html`,
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/App.tsx"></script></body></html>'), 10_000);
  // A .tsx so the transform path (esbuild) is exercised. A unique marker
  // string lets us assert which version was served.
  await run(writeFile(`${dir}/src/App.tsx`,
    'export const MARKER: string = "MARKER_V1";\nexport default function App() { return null; }\n'), 10_000);

  await run(`cd ${dir}`, 5000);
  buf = '';
  cmd('npm run dev');
  await waitFor((b) => /Nimbus Vite Dev Server/i.test(b), 30_000, 'vite banner');

  const modUrl = `${BASE}/s/${sid}/preview/src/App.tsx`;

  // 1. First transform — output must contain MARKER_V1 and be valid JS
  //    (esbuild stripped the `: string` type annotation).
  const r1 = await fetch(modUrl, { redirect: 'manual', headers: requestHeaders() });
  const body1 = await r1.text();
  check('first transform served (200)', r1.status === 200, `status=${r1.status}`);
  check('first transform contains MARKER_V1', body1.includes('MARKER_V1'),
    `tail=${JSON.stringify(body1.slice(-120))}`);
  check('first transform is type-stripped JS (no `: string`)', !body1.includes(': string'),
    'esbuild should have removed the TS annotation');

  // 2. Edit the source content, then re-request. A content-addressed
  //    cache must serve the NEW marker — never the stale V1 transform.
  await run(writeFile(`${dir}/src/App.tsx`,
    'export const MARKER: string = "MARKER_V2_EDITED";\nexport default function App() { return null; }\n'), 10_000);
  // Give the VFS event a beat to propagate; the content-hash guarantee
  // holds even if it doesn't, but we don't want to race the write RPC.
  await sleep(500);

  const r2 = await fetch(modUrl, { redirect: 'manual', headers: requestHeaders() });
  const body2 = await r2.text();
  check('post-edit transform served (200)', r2.status === 200, `status=${r2.status}`);
  check('post-edit transform contains MARKER_V2_EDITED', body2.includes('MARKER_V2_EDITED'),
    `tail=${JSON.stringify(body2.slice(-160))}`);
  check('post-edit transform does NOT serve stale MARKER_V1', !body2.includes('MARKER_V1'),
    'stale path-only cache hit would return V1');

  // 3. Re-request the unchanged V2 — should still be V2 (cache hit path).
  const r3 = await fetch(modUrl, { redirect: 'manual', headers: requestHeaders() });
  const body3 = await r3.text();
  check('repeat request stays V2 (cache hit)', body3.includes('MARKER_V2_EDITED') && !body3.includes('MARKER_V1'));
} catch (e) {
  console.error('FATAL:', e?.message || e);
  fail++;
} finally {
  try { ws.close(); } catch {}
  await deleteSession(sid).catch(() => {});
}

console.log(`\n  ──── [vite-transform-cache-content-hash] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
