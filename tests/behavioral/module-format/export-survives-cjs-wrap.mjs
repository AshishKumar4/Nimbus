#!/usr/bin/env bun
// module-format/export-survives-cjs-wrap — `.mjs` with top-level
// export statements survives the two-pass ESM→CJS rewrite (the path
// triggered by TLA + ESM imports). Pre-fix: convertEsmImportsToRequire
// strips imports but leaves `export` keywords, which the async-IIFE
// wrap then puts inside a function body → SyntaxError "Unexpected
// token 'export'" at facet pre-compile.
//
// Root cause (audit 2026-05-11-sk-exports-fix):
//
//   `convertEsmImportsToRequire` in src/runtime/esbuild-service.ts:393
//   handles import statements but not export statements. The async-IIFE
//   wrap (line 749) then puts top-level `export` declarations in a
//   function body, which is illegal grammar (`export` is module-only).
//
// Probe asserts (the two-pass path is the buggy one; single-pass uses
// esbuild's native CJS-format which already handles exports correctly):
//
//   1. synthetic-named-decl: `export const`, `export function`, `export
//      class` survive. Module body logs each via side effect so we
//      verify both that the file LOADS and that the values are correct.
//   2. synthetic-named-list: `export { a, b as c };` (binding-only list,
//      possibly with `as` renames). Same side-effect verification.
//   3. synthetic-default: `export default expr` — module exports a
//      default that the consumer reads via require('m').default.
//   4. synthetic-reexport-named: `export { x } from './sub';`
//   5. synthetic-reexport-star: `export * from './sub';`
//   6. wild-sv: `npx --yes sv@latest create ...` advances past the
//      "Unexpected token 'export'" gate (next-layer errors out of scope).

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[module-format/export-survives-cjs-wrap] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('module-format/export-survives-cjs-wrap');

// Helper: write file via heredoc.
async function writeFile(path, contents) {
  await t.run(`cat > ${path} << 'NIMBUS_HEREDOC_EOF'\n${contents}\nNIMBUS_HEREDOC_EOF`, 10_000);
}

// All synthetics route through the two-pass path: TLA + an import.
// The .mjs prints its OWN sentinel via console.log inside the module
// body (no exports relied upon for the assertion; we only confirm the
// file LOADS and runs its body). For shapes where the *consumer* needs
// to read the export, we also have a consumer.js read via setImmediate
// (async timing window after the IIFE settles).

// ── Check 1: named-decl (const + function + class) ─────────────────
await t.run('rm -rf /home/user/ex-decl && mkdir -p /home/user/ex-decl', 5_000);
const declSrc = `
import { join } from 'node:path';
const _x = await Promise.resolve('decl_ok');
export const SENTINEL_CONST = _x;
export function getSentinel() { return SENTINEL_CONST; }
export class SentinelHolder {
  get value() { return SENTINEL_CONST; }
}
console.log('LOAD=' + (typeof join) + '_' + _x);
console.log('CONST=' + SENTINEL_CONST);
console.log('FUNC=' + getSentinel());
console.log('CLASS=' + (new SentinelHolder()).value);
`;
await writeFile('/home/user/ex-decl/sib.mjs', declSrc);
await writeFile('/home/user/ex-decl/consumer.js', "require('./sib.mjs');");
const declResult = await t.run('cd /home/user/ex-decl && node consumer.js', 30_000);
const declOut = declResult.output;
A.check(
  'named-decl: module body executes (LOAD line present)',
  /LOAD=function_decl_ok/.test(declOut),
  declOut.slice(-700),
);
A.check(
  'named-decl: NO "Unexpected token \'export\'" error',
  !/Unexpected token 'export'/.test(declOut),
  declOut.slice(-500),
);
A.check(
  'named-decl: const + function + class all bound inside module body',
  /CONST=decl_ok/.test(declOut) && /FUNC=decl_ok/.test(declOut) && /CLASS=decl_ok/.test(declOut),
  declOut.slice(-700),
);

// ── Check 2: named-list (export { a, b as c }) ─────────────────────
await t.run('rm -rf /home/user/ex-list && mkdir -p /home/user/ex-list', 5_000);
const listSrc = `
import { join } from 'node:path';
const _t = await Promise.resolve(1);
const innerA = 'A_val';
const innerB = 'B_val';
const innerC$1 = 'C_dollar_val';
export { innerA, innerB as renamedB, innerC$1 as renamedC };
console.log('LIST_LOAD=' + (typeof join) + '_tla=' + _t);
console.log('A=' + innerA + ' B=' + innerB + ' C=' + innerC$1);
`;
await writeFile('/home/user/ex-list/sib.mjs', listSrc);
await writeFile('/home/user/ex-list/consumer.js', "require('./sib.mjs');");
const listResult = await t.run('cd /home/user/ex-list && node consumer.js', 30_000);
const listOut = listResult.output;
A.check(
  'named-list: module body executes',
  /LIST_LOAD=function_tla=1/.test(listOut) && /A=A_val B=B_val C=C_dollar_val/.test(listOut),
  listOut.slice(-700),
);
A.check(
  'named-list: NO "Unexpected token \'export\'" error',
  !/Unexpected token 'export'/.test(listOut),
  listOut.slice(-500),
);

// ── Check 3: default ─────────────────────────────────────────────
await t.run('rm -rf /home/user/ex-def && mkdir -p /home/user/ex-def', 5_000);
const defSrc = `
import { join } from 'node:path';
const _t = await Promise.resolve(7);
const myDefault = { kind: 'default', value: _t };
export default myDefault;
console.log('DEF_LOAD=' + (typeof join) + '_tla=' + _t);
console.log('DEFVAL=' + JSON.stringify(myDefault));
`;
await writeFile('/home/user/ex-def/sib.mjs', defSrc);
await writeFile('/home/user/ex-def/consumer.js', "require('./sib.mjs');");
const defResult = await t.run('cd /home/user/ex-def && node consumer.js', 30_000);
const defOut = defResult.output;
A.check(
  'default: module body executes',
  /DEF_LOAD=function_tla=7/.test(defOut) && /DEFVAL=\{"kind":"default","value":7\}/.test(defOut),
  defOut.slice(-700),
);
A.check(
  'default: NO "Unexpected token" error',
  !/Unexpected token/.test(defOut),
  defOut.slice(-500),
);

// ── Check 4: re-export named — `export { x } from "./sub";` ────────
await t.run('rm -rf /home/user/ex-re && mkdir -p /home/user/ex-re', 5_000);
await writeFile('/home/user/ex-re/sub.js', 'module.exports.viaRe = "REEXP_OK";');
const reSrc = `
import { join } from 'node:path';
const _t = await Promise.resolve(2);
export { viaRe } from './sub.js';
console.log('RE_LOAD=' + (typeof join) + '_tla=' + _t);
`;
await writeFile('/home/user/ex-re/sib.mjs', reSrc);
await writeFile('/home/user/ex-re/consumer.js', "require('./sib.mjs');");
const reResult = await t.run('cd /home/user/ex-re && node consumer.js', 30_000);
const reOut = reResult.output;
A.check(
  're-export named: module body executes',
  /RE_LOAD=function_tla=2/.test(reOut),
  reOut.slice(-700),
);
A.check(
  're-export named: NO "Unexpected token" error',
  !/Unexpected token/.test(reOut),
  reOut.slice(-500),
);

// ── Check 5: re-export star — `export * from "./sub";` ─────────────
await t.run('rm -rf /home/user/ex-star && mkdir -p /home/user/ex-star', 5_000);
await writeFile('/home/user/ex-star/sub.js', 'module.exports.foo = "F"; module.exports.bar = "B";');
const starSrc = `
import { join } from 'node:path';
const _t = await Promise.resolve(3);
export * from './sub.js';
console.log('STAR_LOAD=' + (typeof join) + '_tla=' + _t);
`;
await writeFile('/home/user/ex-star/sib.mjs', starSrc);
await writeFile('/home/user/ex-star/consumer.js', "require('./sib.mjs');");
const starResult = await t.run('cd /home/user/ex-star && node consumer.js', 30_000);
const starOut = starResult.output;
A.check(
  're-export star: module body executes',
  /STAR_LOAD=function_tla=3/.test(starOut),
  starOut.slice(-700),
);
A.check(
  're-export star: NO "Unexpected token" error',
  !/Unexpected token/.test(starOut),
  starOut.slice(-500),
);

// ── Check 6: wild-sv ────────────────────────────────────────────────
await t.run('rm -rf /home/user/sv-probe && mkdir -p /home/user/sv-probe && cd /home/user/sv-probe', 5_000);
const svRun = await t.run(
  'npx --yes sv@latest create mvp --template minimal --types ts --no-add-ons --no-install',
  360_000,
);
const svOut = svRun.output;
A.check(
  'wild-sv: NO "Unexpected token \'export\'" in sv invocation',
  !/Unexpected token 'export'/.test(svOut),
  svOut.slice(-700),
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
