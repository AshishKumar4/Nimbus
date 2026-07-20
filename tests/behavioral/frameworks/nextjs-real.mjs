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
// Boundary (documented, not faked): the S2a npx credential fix moved
// the boundary forward — the FULL template now lands, INCLUDING
// package.json (the old `{"remote":true}` pre-package.json abort is
// gone). create-next-app then spawns its in-scaffold `npm install`,
// which fails ("npm install has failed." → "Aborting installation."):
// nested package-manager child processes inside a create-* facet are
// the remaining, create-next-app-specific boundary. This probe scopes
// to the proven milestone — the complete template including
// package.json — and asserts the in-scaffold install abort as the
// honest boundary, with evidence.

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
  a.check('create-next-app writes package.json (regression guard: the pre-S2a {"remote":true} abort landed BEFORE package.json)',
    /PKG=true/.test(tplOut), JSON.stringify(tplOut.slice(-200)));

  // The honest boundary: the scaffold is complete; the in-scaffold
  // `npm install` child then fails and create-next-app aborts. Assert
  // the abort signal so the boundary is meaningful, not assumed.
  const abortedAtInstall = /Aborting installation/.test(createOut)
    && /npm install has failed/.test(createOut);
  a.check('honest boundary: create-next-app aborts at its in-scaffold npm install (after the full template)',
    abortedAtInstall,
    JSON.stringify(createOut.split(/\r?\n/).filter((l) => /Aborting|install/.test(l)).join(' | ').slice(-300)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
