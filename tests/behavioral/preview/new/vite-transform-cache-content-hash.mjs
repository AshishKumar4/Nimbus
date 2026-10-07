#!/usr/bin/env bun
// behavioral/preview/new/vite-transform-cache-content-hash —
// the persistent user-module transform cache (user_module_transforms,
// keyed vfs_path + content_hash + the transforming code's key) must:
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

import {
  BASE, Terminal, deleteSession, makeAsserter, mintSession, requestHeaders,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('vite-transform-cache-content-hash');

const sid = await mintSession();
console.log(`behavioral/preview/new/vite-transform-cache-content-hash — BASE=${BASE} sid=${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(10_000);

  const dir = '/home/user/xform-cache';
  await t.run('cd /home/user', 5000);
  await t.run(`mkdir -p ${dir}/src`, 5000);
  await t.writeFile(`${dir}/package.json`,
    JSON.stringify({ name: 'xform-cache', type: 'module', scripts: { dev: 'vite --host 0.0.0.0 --port 5173' } }), 10_000);
  await t.writeFile(`${dir}/index.html`,
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/App.tsx"></script></body></html>', 10_000);
  // A .tsx so the transform path (esbuild) is exercised. A unique marker
  // string lets us assert which version was served.
  await t.writeFile(`${dir}/src/App.tsx`,
    'export const MARKER: string = "MARKER_V1";\nexport default function App() { return null; }\n', 10_000);

  await t.run(`cd ${dir}`, 5000);
  t.reset();
  t.cmd('npm run dev');
  await t.waitFor((b) => /Nimbus Vite Dev Server/i.test(b), 30_000, 'vite banner');

  const modUrl = `${BASE}/s/${sid}/preview/src/App.tsx`;

  // 1. First transform — output must contain MARKER_V1 and be valid JS
  //    (esbuild stripped the `: string` type annotation).
  const r1 = await fetch(modUrl, { redirect: 'manual', headers: requestHeaders() });
  const body1 = await r1.text();
  a.check('first transform served (200)', r1.status === 200, `status=${r1.status}`);
  a.check('first transform contains MARKER_V1', body1.includes('MARKER_V1'),
    `tail=${JSON.stringify(body1.slice(-120))}`);
  a.check('first transform is type-stripped JS (no `: string`)', !body1.includes(': string'),
    'esbuild should have removed the TS annotation');

  // 2. Edit the source content, then re-request. A content-addressed
  //    cache must serve the NEW marker — never the stale V1 transform.
  await t.writeFile(`${dir}/src/App.tsx`,
    'export const MARKER: string = "MARKER_V2_EDITED";\nexport default function App() { return null; }\n', 10_000);
  // The write has returned (the prompt is back); a content-addressed cache
  // must serve it on the next request.

  const r2 = await fetch(modUrl, { redirect: 'manual', headers: requestHeaders() });
  const body2 = await r2.text();
  a.check('post-edit transform served (200)', r2.status === 200, `status=${r2.status}`);
  a.check('post-edit transform contains MARKER_V2_EDITED', body2.includes('MARKER_V2_EDITED'),
    `tail=${JSON.stringify(body2.slice(-160))}`);
  a.check('post-edit transform does NOT serve stale MARKER_V1', !body2.includes('MARKER_V1'),
    'stale path-only cache hit would return V1');

  // 3. Re-request the unchanged V2 — should still be V2 (cache hit path).
  const r3 = await fetch(modUrl, { redirect: 'manual', headers: requestHeaders() });
  const body3 = await r3.text();
  a.check('repeat request stays V2 (cache hit)', body3.includes('MARKER_V2_EDITED') && !body3.includes('MARKER_V1'));
} catch (e) {
  a.check('the probe ran to completion', false, e?.message || String(e));
} finally {
  await t.close();
  await deleteSession(sid);
}

process.exit(a.summary().fail === 0 ? 0 : 1);
