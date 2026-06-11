#!/usr/bin/env bun
// frameworks/sveltekit-real — honest-boundary probe for `sv create`.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx sv@latest create mvp --template minimal --types ts --no-add-ons
//     --no-install
//
// Note: `npm create svelte` is deprecated; the current tool is `sv`
// (the Svelte CLI). The flags above are sv's own documented
// non-interactive form ("Provide --template, --types, --add, and
// --install (or --no-install) to skip prompts entirely").
//
// What this probe PROVES (the real, useful capability): sv resolves+
// installs its own dependency tree, launches its CLI as a facet, and
// reaches its scaffold entry — printing "Welcome to the Svelte CLI!"
// (clack's intro). The npm resolver + facet spawn + drain all work.
//
// Boundary (documented, not faked): sv's `create` runs its scaffold
// through a `@clack/prompts` group flow. Even with every value supplied
// on the CLI (so no step actually prompts), the clack group machinery
// sets up an interactive readline session over stdin; under the facet's
// no-TTY environment the flow does not complete — sv prints the intro
// box and exits WITHOUT writing a project (no package.json, no files).
// This is the same interactive-CLI boundary documented for nuxt-real:
// the tool's scaffold path is gated behind clack's interactive session,
// which has no TTY to drive in a facet. A running SvelteKit dev server
// is therefore out of reach for this tool until sv exposes a fully
// non-interactive (clack-free) scaffold path, or Nimbus provides a TTY
// that satisfies clack's group session.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('sveltekit-real');

const sid = await mintSession();
console.log(`[sveltekit-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/sk-probe && cd /home/user/sk-probe', 10_000);
  console.log('[sveltekit-real] npx sv@latest create...');

  const createR = await t.run(
    'npx --yes sv@latest create mvp --template minimal --types ts --no-add-ons --no-install 2>&1; echo "___DONE___"',
    180_000,
  );
  const createOut = stripAnsi(createR.output);

  // Proven milestone: sv launches and reaches its clack scaffold intro.
  const reachedIntro = /facet started: pid=\d+ cmd="node[^"]*sv\/dist/.test(createOut)
    && /Welcome to the Svelte CLI/.test(createOut);
  a.check('sv launches and reaches its scaffold intro (npm resolver + facet spawn + drain)',
    reachedIntro, JSON.stringify(createOut.split(/\r?\n/).slice(-6).join(' | ')));

  // The honest boundary: the clack group scaffold flow does not complete
  // non-interactively in the facet — no project is produced.
  const proj = await t.run(
    `node -e "const fs=require('fs');console.log('PKG='+fs.existsSync('mvp/package.json'));console.log('DIR='+fs.existsSync('mvp'));"`,
    20_000,
  );
  const projOut = stripAnsi(proj.output);
  a.check('honest boundary: sv\'s clack scaffold produces no project non-interactively (no package.json)',
    /PKG=false/.test(projOut), JSON.stringify(projOut.slice(-200)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
