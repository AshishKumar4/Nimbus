#!/usr/bin/env bun
// process-redeclare/synthetic-process — `import process from 'node:process'`
// in a .mjs with TLA + ESM imports triggers the two-pass path. The
// two-pass post-process emits `const process = (() => {...})()` in the
// body. Pre-fix the facet wrap's `process` function parameter collides
// with the body's `const process` → SyntaxError "Identifier 'process'
// has already been declared" at facet pre-compile.
//
// Root cause (audit 2026-05-11-nuxt-process-redeclare/plan.md §2-§4):
//   src/runtime/esbuild-service.ts:566-572 "Default only" branch emits
//   `const process = ...` for `import process from 'node:process'`.
//   src/facets/manager.ts:269-277 (and twin at :544-552)
//   __mkCompiledFn wraps in `new Function(...params, code)` where
//   `process` is also a param → JS parse-time SyntaxError.
//
// Fix: extend the existing __filename/__dirname conditional-rename
// trick at manager.ts:270-273 to cover the 7 extra-params
// (process, console, Buffer, setTimeout, setInterval, clearTimeout,
// clearInterval), AND broaden regex from (const|let|var) to
// (const|let|var|function|class).

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../../_driver.mjs';

const sid = await mintSession();
console.log(`[process-redeclare/synthetic-process] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('process-redeclare/synthetic-process');

async function writeFile(path, contents) {
  await t.run(`cat > ${path} << 'NIMBUS_HEREDOC_EOF'\n${contents}\nNIMBUS_HEREDOC_EOF`, 10_000);
}

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
await writeFile('/home/user/pp/entry.mjs', src);

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
