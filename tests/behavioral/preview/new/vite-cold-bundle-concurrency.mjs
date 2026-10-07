#!/usr/bin/env bun
// behavioral/preview/new/vite-cold-bundle-concurrency —
// the on-demand /@modules/ cold-bundle path must serve MANY distinct
// packages requested CONCURRENTLY (as a fresh app's first load does)
// without erroring and without crashing the supervisor (CF 1101).
//
// Each cold build leases its slice bytes from the shared supervisor
// allocation budget before the slice is built, so distinct modules never
// hold slices beside each other — or beside the pre-bundler's — past the
// budget (unit-tested in tests/unit/port-route-vite-mount.mjs; this probe
// proves the deployed path serves them all correctly under load).
//
// Public surface: GET /s/<sid>/preview/@modules/<pkg>. Strictly
// black-box. The packages are small, pure-ESM/CJS libs that bundle
// cleanly through the on-demand path.
//
// failing if regressed: a cold-bundle that 500s, returns non-JS, or a
// supervisor reset (502/1101) under concurrent first-load.

import {
  BASE, Terminal, deleteSession, makeAsserter, mintSession, requestHeaders,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('vite-cold-bundle-concurrency');

// Small, well-behaved packages that bundle through the on-demand path.
const PKGS = ['clsx', 'nanoid', 'mitt', 'just-debounce-it', 'dequal'];

const sid = await mintSession();
console.log(`behavioral/preview/new/vite-cold-bundle-concurrency — BASE=${BASE} sid=${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(10_000);

  const dir = '/home/user/cold-concurrency';
  await t.run('cd /home/user', 5000);
  await t.run(`mkdir -p ${dir}/src`, 5000);
  await t.writeFile(`${dir}/package.json`,
    JSON.stringify({
      name: 'cold-concurrency', type: 'module',
      scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
      dependencies: Object.fromEntries(PKGS.map((p) => [p, '*'])),
    }), 10_000);
  // An entry that imports every package so they're resolvable under node_modules.
  await t.writeFile(`${dir}/index.html`,
    '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>', 10_000);
  await t.writeFile(`${dir}/src/main.js`,
    PKGS.map((p, i) => `import * as m${i} from '${p}';`).join('\n') + '\nconsole.log(' + PKGS.map((_, i) => `m${i}`).join(',') + ');\n', 10_000);

  await t.run(`cd ${dir}`, 5000);
  await t.run('npm install', 180_000);

  t.reset();
  t.cmd('npm run dev');
  await t.waitFor((b) => /Nimbus Vite Dev Server/i.test(b), 30_000, 'vite banner');

  // Fire all /@modules/ requests CONCURRENTLY — this is the fresh-load
  // flurry the gate must handle. Measure wall time for the whole batch.
  const t0 = Date.now();
  const results = await Promise.all(PKGS.map(async (p) => {
    const url = `${BASE}/s/${sid}/preview/@modules/${p}`;
    const r = await fetch(url, { redirect: 'manual', headers: requestHeaders() });
    const body = await r.text().catch(() => '');
    return { p, status: r.status, body };
  }));
  const elapsed = Date.now() - t0;
  console.log(`  concurrent /@modules/ batch (${PKGS.length} pkgs) took ${elapsed}ms`);

  for (const { p, status, body } of results) {
    a.check(`@modules/${p} served 200`, status === 200, `status=${status}`);
    // A real bundle is non-trivial JS — not an error stub / empty body.
    a.check(`@modules/${p} is non-empty JS module`,
      status === 200 && body.length > 0 &&
      (body.includes('export') || body.includes('import') || body.length > 40),
      `len=${body.length}`);
    a.check(`@modules/${p} is not an error stub`,
      !/throw __err|Bundle failed|cannot bundle|Transform Error/i.test(body),
      `tail=${JSON.stringify(body.slice(-120))}`);
  }

  // Bounded wall-time: fully serialized, these 5 small bundles should
  // finish well under a minute; a supervisor reset / hang would blow
  // this. (Not a perf assertion — it guards against a deployed
  // regression hanging.)
  a.check('concurrent cold-bundle batch completes under 60s', elapsed < 60_000, `elapsed=${elapsed}ms`);
} catch (e) {
  a.check('the probe ran to completion', false, e?.message || String(e));
} finally {
  await t.close();
  await deleteSession(sid);
}

process.exit(a.summary().fail === 0 ? 0 : 1);
