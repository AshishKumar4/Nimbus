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
//
// Wild assertion (real-world Astro flow) is deliberately OUT of this
// probe's scope: it depends on prod stability across an `npm install
// create-astro` cycle (~3 min), during which the sibling deploy storm
// reliably clobbers any non-main deploy. The synthetic checks above
// fully exercise the dynamic-import lowering at all three code paths
// (single-pass, TLA two-pass, rejection). Coverage of the real-world
// next-layer chalk-imports-field bug is documented in the verdict as
// a separate scope-out.

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

// ── Check 4: shape-of-rejection ────────────────────────────────────
//
// Quick rejection-shape check: an explicit import() of a missing file
// with .catch attached. Pre-fix the rejection message is workerd-shape
// ('No such module "..."'). Post-fix it's Nimbus-shape ('Cannot find
// module ...' from Nimbus's __requireFrom). Either is OBSERVABLE
// through the .catch — but the SHAPE proves the lowering happened.

await t.run('rm -rf /home/user/dyn-shape && mkdir -p /home/user/dyn-shape', 5_000);
await writeFile('/home/user/dyn-shape/entry.mjs', `
import('./does-not-exist.mjs').then(
  m => console.log('UNEXPECTED_OK'),
  e => console.log('CAUGHT=' + (e && e.message ? e.message : String(e))),
);
`);
const shapeR = await t.run('cd /home/user/dyn-shape && node entry.mjs', 30_000);
const shapeOut = shapeR.output;
A.check(
  'shape-of-rejection: CAUGHT line present (rejection observable)',
  /CAUGHT=/.test(shapeOut),
  `tail: ${shapeOut.slice(-500)}`,
);
A.check(
  'shape-of-rejection: error shape is Nimbus require() ("Cannot find module"), not workerd ("No such module")',
  /CAUGHT=Cannot find module/.test(shapeOut) && !/No such module/.test(shapeOut),
  `tail: ${shapeOut.slice(-500)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
