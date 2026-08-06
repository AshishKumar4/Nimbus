#!/usr/bin/env bun
// frameworks/sveltekit-real — `sv create` scaffolds a real SvelteKit project.
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
// What this proves: sv resolves and installs its own dependency tree,
// launches its CLI as a facet, runs its `@clack/prompts` group flow to
// completion with no TTY, and writes the project into the VFS.
//
// This probe used to assert the opposite. Until 2026-08-05 it recorded a
// boundary: clack's group machinery opened an interactive readline session
// over stdin, and under the facet's no-TTY environment the flow never
// completed — sv printed its intro box and exited without writing a single
// file. That boundary is gone. Measured on that date sv runs through to
// "You're all set!" and leaves a complete project: package.json depending on
// @sveltejs/kit and svelte, vite.config.ts, tsconfig.json, and
// src/routes/+page.svelte.
//
// So it was red for the best possible reason — the product outgrew the
// limitation the probe was pinning. Asserting the capability is what stops
// it regressing back to the intro box.
//
// NOT proven here: a RUNNING SvelteKit dev server. `--no-install` leaves the
// toolchain unfetched, so that needs a full SvelteKit + vite install on top
// of this. That is the next milestone and this probe does not claim it.

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

  // The clack group flow runs to completion with no TTY and writes the
  // project. Asserted on the files a SvelteKit app cannot be without, not on
  // sv's own success banner — a tool that prints "You're all set!" and
  // scaffolds nothing is exactly the failure this probe exists to catch.
  const proj = await t.run(
    `node -e "const fs=require('fs');const p='mvp/';const pkg=fs.existsSync(p+'package.json')?JSON.parse(fs.readFileSync(p+'package.json','utf8')):null;`
    + `const d={...(pkg&&pkg.dependencies||{}),...(pkg&&pkg.devDependencies||{})};`
    + `console.log('KIT='+('@sveltejs/kit' in d));console.log('SVELTE='+('svelte' in d));`
    + `console.log('VITECFG='+fs.existsSync(p+'vite.config.ts'));`
    + `console.log('TSCFG='+fs.existsSync(p+'tsconfig.json'));`
    + `console.log('PAGE='+fs.existsSync(p+'src/routes/+page.svelte'));"`,
    20_000,
  );
  const projOut = stripAnsi(proj.output);
  a.check('sv writes a complete SvelteKit project with no TTY to drive clack',
    /KIT=true/.test(projOut) && /SVELTE=true/.test(projOut)
      && /VITECFG=true/.test(projOut) && /TSCFG=true/.test(projOut)
      && /PAGE=true/.test(projOut),
    JSON.stringify(projOut.slice(-300)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
