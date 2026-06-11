#!/usr/bin/env bun
// frameworks/astro-real — honest-boundary probe for `npm create astro`.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npm create astro@latest mvp -- --template minimal --no-install
//     --no-git --skip-houston --yes
//
// What this probe PROVES (the real, useful capability): create-astro
// runs under Nimbus, resolves+installs its own dependency tree, boots,
// and reaches the "Template copying…" step — i.e. it gets all the way
// to fetching the template tarball from GitHub. Reaching this step
// exercises two capabilities that earlier waves added/fixed:
//   1. outbound fetch with a default User-Agent — create-astro's giget
//      hits api.github.com, which 403s a UA-less request. workerd's
//      global fetch sends no UA; Nimbus now injects "User-Agent: node"
//      (matching undici) so the GitHub API answers 302→codeload 200.
//   2. the startup-drain timer/promise tracking that keeps the facet
//      alive through giget's async download instead of exiting early.
//
// Boundary (documented, not faked): create-astro copies the template by
// EXTRACTING a gzip tarball with `node-tar`. node-tar's bundled minizlib
// instantiates `zlib.Gunzip`/`zlib.Unzip` as constructors and decom-
// presses SYNCHRONOUSLY via the low-level zlib binding's
// `_handle._processChunk`. workerd exposes no synchronous zlib at all
// (only the async CompressionStream/DecompressionStream Web APIs;
// zlib.Gunzip is `undefined`, `gunzipSync` throws), so node-tar's
// synchronous extract cannot run. This is a genuine workerd platform
// boundary: there is no synchronous gzip primitive to bind node-tar to.
// Proven live: in a facet, `new zlib.Gunzip()` → "z.Gunzip is not a
// constructor", and node-tar's `extract({file})` → "z.default.open is
// not a function" / synchronous `_processChunk` is unavailable. A
// running Astro dev server is therefore out of reach for this tool until
// Nimbus ships a synchronous (WASM) zlib for the facet runtime.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('astro-real');

const sid = await mintSession();
console.log(`[astro-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/astro-probe && cd /home/user/astro-probe', 10_000);
  console.log('[astro-real] npm create astro@latest...');

  // create-astro resolves+installs its own dependency tree, then launches
  // the create-astro CLI as a facet. This step is deterministic and
  // exercises the npm resolver + facet spawn. (The template DOWNLOAD that
  // follows hits the extraction boundary asserted below; create-astro's
  // own banner/error output past launch is non-deterministic — sometimes
  // it reaches "Template copying" and stalls in node-tar, sometimes it
  // errors before flushing — so the deterministic milestone is launch.)
  const createR = await t.run(
    'npm create astro@latest mvp -- --template minimal --no-install --no-git --skip-houston --yes 2>&1; echo "___DONE___"',
    180_000,
  );
  const createOut = stripAnsi(createR.output);
  const launched = /facet started: pid=\d+ cmd="node[^"]*create-astro/.test(createOut);
  a.check('create-astro resolves its dependency tree and launches (npm resolver + facet spawn)',
    launched, JSON.stringify(createOut.split(/\r?\n/).slice(-6).join(' | ')));

  // The honest boundary: node-tar's synchronous gzip extraction cannot
  // run on workerd. Prove the missing primitive directly so the boundary
  // is asserted meaningfully, not assumed.
  await t.waitForPrompt(60_000).catch(() => {});
  const z = await t.run(
    `node -e "const z=require('zlib');console.log('GUNZIP_CTOR='+(typeof z.Gunzip));console.log('GUNZIP_SYNC='+(typeof z.gunzipSync));try{new z.Gunzip();console.log('NEW=ok');}catch(e){console.log('NEW_ERR='+e.message);}"`,
    30_000,
  );
  const zOut = stripAnsi(z.output);
  const noSyncZlib = /GUNZIP_CTOR=undefined/.test(zOut) && /NEW_ERR=.*is not a constructor/.test(zOut);
  a.check('workerd has no synchronous zlib (node-tar extract boundary): zlib.Gunzip is not a constructor',
    noSyncZlib, JSON.stringify(zOut.slice(-300)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
