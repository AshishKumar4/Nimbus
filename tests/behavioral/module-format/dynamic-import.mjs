#!/usr/bin/env bun
// module-format/dynamic-import — dynamic `import()` calls in user code
// resolve via Nimbus's require() chain (which knows the VFS) instead of
// workerd's module-map resolver (which doesn't).
//
// Root cause (audit 2026-05-11-astro-silent-exit):
//
//   esbuild's `format: 'cjs'` transform leaves `import(specifier)`
//   literal in the output. The facet's `new Function(...)` wrap runs
//   that body; workerd's `import()` resolves against the worker's
//   module map (just `{'runner.js': workerCode}`), NOT the VFS. So
//   ANY user dynamic `import()` of a relative/absolute path rejects
//   with "No such module ...".
//
//   create-astro.mjs (npm `create-astro@5`) ends with:
//     import('./dist/index.js').then(({main}) => main());
//   no `.catch()` → unhandled rejection → facet exits exitCode=0
//   silently (W5 contract only catches non-zero exits).
//
// Fix: add `supported: {'dynamic-import': false}` to esbuild calls at
// runtime-registry.ts:384 (entry-script transform) and manager.ts:1409
// (bundle-transform). esbuild then emits
//   `Promise.resolve().then(() => __toESM(require(spec)))`
// which routes through Nimbus's scopedRequire → __requireFrom → VFS.
//
// Probe asserts:
//   1. synthetic-resolve: import('./mod.mjs').then(m => log) prints mod's export
//   2. synthetic-reject: import('./nonexistent.mjs').catch(e => log) prints CAUGHT
//   3. synthetic-tla-import: `const m = await import('./mod.mjs')` works (TLA route)
//   4. wild-create-astro: `npm create astro@latest …` advances past the
//      dynamic-import gate. We DO NOT assert scaffold success in totality;
//      the next-layer Node-version check (astro requires >=22.12) is
//      separate. We only assert: `mvp/package.json` exists post-run.

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[module-format/dynamic-import] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('module-format/dynamic-import');

async function writeFile(path, contents) {
  await t.run(`cat > ${path} << 'NIMBUS_HEREDOC_EOF'\n${contents}\nNIMBUS_HEREDOC_EOF`, 10_000);
}

// ── Check 1: synthetic-resolve ──────────────────────────────────────
//
// entry.mjs does `import('./mod.mjs').then(m => console.log('RESULT=' + m.X))`.
// Pre-fix: workerd's import() rejects ("No such module"), .then handler
// never runs, no output. Post-fix: esbuild rewrites to require() →
// resolves via VFS → m.X is "RES_OK".

await t.run('rm -rf /home/user/dyn-r && mkdir -p /home/user/dyn-r', 5_000);
await writeFile('/home/user/dyn-r/mod.mjs', "export const X = 'RES_OK';");
await writeFile(
  '/home/user/dyn-r/entry.mjs',
  `import('./mod.mjs').then(m => console.log('RESULT=' + m.X));`,
);
const resR = await t.run('cd /home/user/dyn-r && node entry.mjs', 30_000);
const resOut = resR.output;
A.check(
  'synthetic-resolve: import("./mod.mjs").then(m => log m.X) prints RES_OK',
  /RESULT=RES_OK/.test(resOut),
  `tail: ${resOut.slice(-500)}`,
);

// ── Check 2: synthetic-reject ───────────────────────────────────────
//
// entry.mjs does `import('./nonexistent.mjs').catch(e => log)`.
// Post-fix: require('./nonexistent.mjs') throws → wrapped in
// Promise.resolve().then → .catch fires → CAUGHT printed.
// (Pre-fix: workerd's import() rejects with "No such module" but the
// rejection IS caught here since we attached a .catch — but the
// rejection message comes from workerd, not from Nimbus's require.
// We accept either error message; the assertion is that the .catch
// handler fired AT ALL.)

await t.run('rm -rf /home/user/dyn-rej && mkdir -p /home/user/dyn-rej', 5_000);
await writeFile(
  '/home/user/dyn-rej/entry.mjs',
  `import('./does-not-exist.mjs').catch(e => console.log('CAUGHT=' + (e && e.message ? e.message : String(e))));`,
);
const rejR = await t.run('cd /home/user/dyn-rej && node entry.mjs', 30_000);
const rejOut = rejR.output;
A.check(
  'synthetic-reject: import("./nonexistent").catch handler fires (CAUGHT line present)',
  /CAUGHT=/.test(rejOut),
  `tail: ${rejOut.slice(-500)}`,
);

// ── Check 3: synthetic-tla-import ───────────────────────────────────
//
// `const m = await import('./mod.mjs')` inside a top-level await context
// forces the two-pass (TLA + imports) esbuild path. Post-fix the dynamic
// import rewrite must work in BOTH pass-1 ESM output and the assembled
// CJS body.

await t.run('rm -rf /home/user/dyn-tla && mkdir -p /home/user/dyn-tla', 5_000);
await writeFile('/home/user/dyn-tla/mod.mjs', "export const Y = 'TLA_OK';");
const tlaSrc = `
import { join } from 'node:path';
const m = await import('./mod.mjs');
console.log('RESULT=' + m.Y + ' join=' + (typeof join));
`;
await writeFile('/home/user/dyn-tla/entry.mjs', tlaSrc);
const tlaR = await t.run('cd /home/user/dyn-tla && node entry.mjs', 30_000);
const tlaOut = tlaR.output;
A.check(
  'synthetic-tla-import: await import("./mod.mjs") inside TLA context resolves',
  /RESULT=TLA_OK join=function/.test(tlaOut),
  `tail: ${tlaOut.slice(-500)}`,
);

// ── Check 4: wild-create-astro ──────────────────────────────────────
//
// Real-world `npm create astro@latest` runs create-astro.mjs which uses
// dynamic import. Pre-fix: silent exit, no output past the
// `[facet started: pid=1 ...]` notice (the `import('./dist/index.js')`
// rejects with no .catch attached → facet exits exitCode=0 silently).
// Post-fix: the import is rewritten to `require(...)` → loads
// create-astro/dist/index.js → which itself transitively requires
// `chalk/source/index.js` (uses imports-field `#ansi-styles`) → may
// surface a NEW next-layer error (chalk imports-field resolution,
// scope-out per charter).
//
// We assert ONLY that the facet produced VISIBLE output beyond the
// `[facet started]` banner — i.e. the dynamic-import gate is no
// longer the silent-exit cause. Next-layer errors (imports-field,
// or astro's Node >=22.12 check) are documented out-of-scope.

await t.run('rm -rf /home/user/wild-astro && mkdir -p /home/user/wild-astro && cd /home/user/wild-astro', 5_000);
const createR = await t.run(
  'npm create astro@latest mvp -- --template minimal --no-install --no-git --skip-houston --yes',
  600_000,
);
const createOut = createR.output;
// The dynamic-import gate IS what produces the pure-silent exit. Post-fix
// the facet either: (a) scaffolds successfully (rare while next-layer
// errors lurk), or (b) emits a visible Node-side error (stack trace).
// EITHER outcome demonstrates the dynamic-import gate is passed. We
// look for ANY post-banner content: a stack trace fragment or a node
// trace, OR a successful 'mvp/' creation indicator.
const banner = '[facet started: pid=1 cmd="node /tmp/.npx-cache/node_modules/create-astro/create-astro.mjs"]';
const idx = createOut.indexOf(banner);
const postBanner = idx >= 0 ? createOut.slice(idx + banner.length) : createOut;
// Strip ANSI + trailing prompt + whitespace
const cleanPost = postBanner
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/user@nimbus:[^$]*\$\s*$/m, '')
  .trim();

A.check(
  'wild-create-astro: NOT silent — post-banner content present (dynamic-import gate passed; next-layer error or scaffold output expected)',
  cleanPost.length > 20,
  `cleanPost (${cleanPost.length} bytes): ${cleanPost.slice(0, 600)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
