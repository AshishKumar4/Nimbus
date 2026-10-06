#!/usr/bin/env bun
// process-redeclare/synthetic-process — `import process from 'node:process'`
// in a .mjs with TLA + ESM imports triggers the two-pass path. The
// two-pass post-process emits `const process = (() => {...})()` in the
// body. The facet's module wrapper once also took `process` as a
// parameter, so the body's `const process` was a SyntaxError
// "Identifier 'process' has already been declared".
//
// Root cause (audit 2026-05-11-nuxt-process-redeclare/plan.md §2-§4):
//   src/runtime/esbuild-service.ts "Default only" branch emits
//   `const process = ...` for `import process from 'node:process'`.
//
// Now: the wrapper takes only Node's five parameters and runs the cell in
// a block, where a lexical declaration of any name shadows instead of
// colliding (core/_shared/commonjs-cell.ts, THE WRAPPER).

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../../_driver.mjs';

const sid = await mintSession();
console.log(`[process-redeclare/synthetic-process] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('process-redeclare/synthetic-process');

// Build the exact shape that triggers the two-pass path:
//   - .mjs extension (forces ESM detection)
//   - top-level ESM imports
//   - top-level `await` (TLA, forces the two-pass branch over single-pass)
//   - default-import of `node:process` (collides with extra-param)
await t.run('rm -rf /home/user/pp && mkdir -p /home/user/pp', 5_000);
const src = `
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// TLA forces the two-pass esbuild path.
const _tla = await Promise.resolve('TLA_OK');

console.log('SENTINEL=process_ok proc=' + (typeof process) + ' url=' + (typeof fileURLToPath) + ' tla=' + _tla);
`;
await t.writeFile('/home/user/pp/entry.mjs', src);

const r = await t.run('node /home/user/pp/entry.mjs', 30_000);
const out = r.output;

A.check(
  'synthetic-process: NO "Identifier \'process\' has already been declared" error',
  !/Identifier ['"]process['"] has already been declared/.test(out),
  `tail: ${out.slice(-500)}`,
);
A.check(
  'synthetic-process: SENTINEL line printed (module body executes; default import of node:process works)',
  /SENTINEL=process_ok proc=object url=function tla=TLA_OK/.test(out),
  `tail: ${out.slice(-500)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
