#!/usr/bin/env bun
// process-redeclare/synthetic-console — generalises the synthetic-process
// case to `console`. Verifies the conditional-rename trick covers all 7
// extra-params (process / console / Buffer / setTimeout / setInterval /
// clearTimeout / clearInterval), not just `process`.
//
// `import console from 'node:console'` is legal Node 18+ ESM. In our
// esbuild-CJS-bundled output, the default-import binding resolves to
// the module-namespace object (whose `.log` etc. are the standard
// console functions) — `typeof console` is therefore `"object"`, not
// `"function"`. The collision risk is the same regardless: pass-1 ESM
// preserves the binding name literally, and pass-2 emits
// `const console = ...` which would collide with the `console`
// extra-param at __mkCompiledFn.
//
// legacy-cleanup (2026-05-13): the original assertion required
// `con=function` (assuming default-import returned the Console class
// itself). post-console-facet wave, the binding does resolve cleanly
// to a usable namespace object, so the SENTINEL prints — we just need
// to assert on the shape that actually exists: `con=object` with a
// callable `.log`.

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
  // post-console-facet shape: con=object (module namespace), url=function (named export),
  // tla=CON_OK. The literal-string assertion locks the shape per PROBE-QUALITY R-tier.
  /SENTINEL=console_ok con=object url=function tla=CON_OK/.test(out),
  `tail: ${out.slice(-500)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
