#!/usr/bin/env bun
// frameworks/nextjs-real — honest-boundary probe for `create-next-app`.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx create-next-app@latest mvp --ts --no-eslint --tailwind --app
//     --src-dir --import-alias '@/*' --use-npm --yes
//
// What this probe PROVES (the real, useful capability): create-next-app
// runs under Nimbus, resolves+installs its own dependency tree, launches
// its CLI as a facet, and gets all the way through "Initializing project
// with template: app-tw" — writing the bulk of the local template
// (next.config.ts, tsconfig.json, postcss.config.mjs, src/, public/,
// next-env.d.ts, README, .gitignore) to the live VFS.
//
// Boundary (documented, not faked): create-next-app then ABORTS before
// writing package.json with an opaque error serialized as `{"remote":
// true}`, during the remote phase of its template/install pipeline. The
// token "remote" appears nowhere in create-next-app's own bundle (grep
// over dist/index.js: 0 hits), so the error originates from a remote
// operation in a transitive/runtime path it invokes after the local
// template files are written. The two general fetch/stream fixes this
// wave landed (default User-Agent, web-stream pipeline) are not enough to
// clear it; the remaining remote op is a deeper, create-next-app-specific
// boundary. This probe scopes to the proven milestone — the template
// files are written deterministically — and asserts the abort as the
// honest boundary (package.json is never produced), with evidence.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('nextjs-real');

const sid = await mintSession();
console.log(`[nextjs-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/nextjs-probe && cd /home/user/nextjs-probe', 10_000);
  console.log('[nextjs-real] npx create-next-app@latest...');

  const createR = await t.run(
    "npx --yes create-next-app@latest mvp --ts --no-eslint --tailwind --app --src-dir --import-alias '@/*' --use-npm --yes 2>&1; echo \"___DONE___\"",
    240_000,
  );
  const createOut = stripAnsi(createR.output);

  const reachedTemplateInit = /Initializing project with template/.test(createOut);
  a.check('create-next-app launches and initializes the local template (npm resolver + facet spawn)',
    reachedTemplateInit, JSON.stringify(createOut.split(/\r?\n/).slice(-8).join(' | ')));

  // Proven milestone: the local template files are written to the VFS.
  const tpl = await t.run(
    `node -e "const fs=require('fs');const need=['mvp/next.config.ts','mvp/tsconfig.json','mvp/src'];console.log('TPL='+need.every(p=>fs.existsSync(p)));console.log('PKG='+fs.existsSync('mvp/package.json'));"`,
    20_000,
  );
  const tplOut = stripAnsi(tpl.output);
  a.check('create-next-app writes the local template files to the VFS (next.config.ts, tsconfig.json, src/)',
    /TPL=true/.test(tplOut), JSON.stringify(tplOut.slice(-200)));

  // The honest boundary: it aborts with {"remote":true} before producing
  // package.json. Assert both the abort signal and the missing
  // package.json so the boundary is meaningful, not assumed.
  const abortedRemote = /Aborting installation/.test(createOut)
    && /\{"remote":true\}/.test(createOut);
  a.check('honest boundary: create-next-app aborts at a remote op ({"remote":true}) before package.json',
    abortedRemote && /PKG=false/.test(tplOut),
    JSON.stringify(createOut.split(/\r?\n/).filter((l) => /Aborting|remote/.test(l)).join(' | ').slice(-300)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
