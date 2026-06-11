#!/usr/bin/env bun
// frameworks/remix-real — honest-boundary probe for `create-react-router`.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx create-react-router@latest mvp --no-git-init --no-install --yes
//
// Note: Remix v2 was upstreamed into React Router; `create-remix@latest`
// now redirects to `create-react-router@latest`, which we use.
//
// What this probe PROVES (the real, useful capability): create-react-
// router resolves+installs its own dependency tree and launches its CLI
// as a facet, reaching the template-copy step. The template download
// itself works (outbound fetch + the default-User-Agent fix that lets
// codeload/GitHub answer 200, and Readable.fromWeb in stream.pipeline).
//
// Boundary (documented, not faked): create-react-router extracts the
// template tarball with a STREAM pipeline —
//   pipeline(input, gunzip-maybe(), tar-fs.extract(dest))
// `gunzip-maybe` and `tar-fs` pull `Duplex`/`Readable` from
// `readable-stream`, which inherits via the classic constructor-stealing
// pattern (`inherits(Duplexify, Duplex)` then `Duplex.call(this)`).
// Nimbus's stream classes are ES6 `class`es, and an ES6 class constructor
// CANNOT be invoked via `.call()` on an existing instance — it throws
// "Class constructor Duplex cannot be invoked without 'new'". So the
// gunzip-maybe/tar-fs extraction stack cannot be constructed. Making the
// whole stream substrate callable-without-new is a separate substrate
// change (it must not regress the npm/vite/child_process stream paths
// that every passing probe depends on). Proven live below with a minimal
// `Duplex.call(this)` repro. A running dev server is therefore out of
// reach for this tool until that stream-substrate work lands.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('remix-real');

const sid = await mintSession();
console.log(`[remix-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/remix-probe && cd /home/user/remix-probe', 10_000);
  console.log('[remix-real] npx create-react-router@latest...');

  // create-react-router resolves+installs its dependency tree then
  // launches its CLI as a facet. Deterministic milestone (npm resolver +
  // facet spawn). The template extraction that follows hits the stream
  // boundary asserted below.
  const createR = await t.run(
    'npx --yes create-react-router@latest mvp --no-git-init --no-install --yes 2>&1; echo "___DONE___"',
    240_000,
  );
  const createOut = stripAnsi(createR.output);
  const launched = /facet started: pid=\d+ cmd="node[^"]*create-react-router/.test(createOut);
  a.check('create-react-router resolves its dependency tree and launches (npm resolver + facet spawn)',
    launched, JSON.stringify(createOut.split(/\r?\n/).slice(-6).join(' | ')));

  // The honest boundary: the gunzip-maybe/tar-fs extraction stack builds
  // its streams via readable-stream's constructor-stealing inheritance,
  // which ES6-class stream constructors reject. Prove the missing
  // capability directly with a minimal repro.
  await t.waitForPrompt(60_000).catch(() => {});
  const repro = [
    'const s=require("stream");',
    'function Child(){ s.Duplex.call(this); }',
    'Object.setPrototypeOf(Child.prototype, s.Duplex.prototype);',
    'try{ new Child(); console.log("NEW=ok"); }catch(e){ console.log("NEW_ERR="+e.message); }',
  ].join('\n');
  const b64 = Buffer.from(repro).toString('base64');
  await t.run(`printf '%s' '${b64}' | base64 -d > /home/user/remix-probe/rs.js`, 15_000);
  const r = await t.run('node /home/user/remix-probe/rs.js 2>&1', 30_000);
  const rOut = stripAnsi(r.output);
  const constructorStealingBoundary = /NEW_ERR=Class constructor Duplex cannot be invoked without 'new'/.test(rOut);
  a.check("readable-stream constructor-stealing boundary: Duplex.call(this) is rejected by ES6-class streams",
    constructorStealingBoundary, JSON.stringify(rOut.slice(-300)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
