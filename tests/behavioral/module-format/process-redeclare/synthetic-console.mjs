#!/usr/bin/env bun
// process-redeclare/synthetic-console — generalises the synthetic-process
// case to `console`. Verifies the conditional-rename trick covers all 7
// extra-params (process / console / Buffer / setTimeout / setInterval /
// clearTimeout / clearInterval), not just `process`.
//
// `import console from 'node:console'` is legal Node 18+ ESM (the
// `node:console` module exports a Console class as default), and esbuild
// pass-1 ESM preserves it literally; pass-2 emits `const console = ...`
// which would collide with the `console` extra-param at __mkCompiledFn.

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../../_driver.mjs';

const sid = await mintSession();
console.log(`[process-redeclare/synthetic-console] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('process-redeclare/synthetic-console');

async function writeFile(path, contents) {
  await t.run(`cat > ${path} << 'NIMBUS_HEREDOC_EOF'\n${contents}\nNIMBUS_HEREDOC_EOF`, 10_000);
}

await t.run('rm -rf /home/user/pc && mkdir -p /home/user/pc', 5_000);
// Default-import the node:console Console class as `console` — collides
// with the `console` extra-param. Use globalThis.console.log to print
// the sentinel (the imported `console` binding shadows globalThis.console
// inside the module body).
const src = `
import console from 'node:console';
import { fileURLToPath } from 'node:url';

const _tla = await Promise.resolve('CON_OK');

globalThis.console.log('SENTINEL=console_ok con=' + (typeof console) + ' url=' + (typeof fileURLToPath) + ' tla=' + _tla);
`;
await writeFile('/home/user/pc/entry.mjs', src);

const r = await t.run('node /home/user/pc/entry.mjs', 30_000);
const out = r.output;

A.check(
  'synthetic-console: NO "Identifier \'console\' has already been declared" error',
  !/Identifier ['"]console['"] has already been declared/.test(out),
  `tail: ${out.slice(-500)}`,
);
A.check(
  'synthetic-console: SENTINEL line printed (module body executes; default import of node:console works)',
  /SENTINEL=console_ok con=function url=function tla=CON_OK/.test(out),
  `tail: ${out.slice(-500)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
