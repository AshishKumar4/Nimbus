#!/usr/bin/env bun
// module-format/export-survives-cjs-wrap — an `.mjs` with top-level await,
// ES imports and every export form loads and runs from CommonJS, through
// import(), as Node runs it: its body executes, its exports are bound, and
// nothing reports "Unexpected token 'export'". (The probe was written for a
// pipeline that lowered such a module to CommonJS, whose rewrite once left
// `export` keywords in a function body; the registry now evaluates the module
// itself.) A require() of such a module throws ERR_REQUIRE_ASYNC_MODULE, as
// Node 22's does: checked once, below.
//
//   1. named-decl: `export const`, `export function`, `export class`.
//   2. named-list: `export { a, b as c };`
//   3. default: `export default expr`.
//   4. re-export named: `export { x } from './sub';`
//   5. re-export star: `export * from './sub';`
//
// The wild case, sv's own engine-*.mjs, runs once in
// frameworks/sveltekit-real.

import { Terminal, mintSession, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[module-format/export-survives-cjs-wrap] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const A = makeAsserter('module-format/export-survives-cjs-wrap');

// Each synthetic has TLA and an import. The .mjs prints its OWN sentinel
// via console.log inside the module body; a consumer.js import()s it.

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
await t.writeFile('/home/user/ex-decl/sib.mjs', declSrc);
await t.writeFile('/home/user/ex-decl/consumer.js', "import('./sib.mjs');");
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

// require() of a module with top-level await refuses, as Node 22's does.
await t.writeFile('/home/user/ex-decl/requirer.js', "try { require('./sib.mjs'); } catch (e) { console.log('REQUIRE_REFUSED=' + e.code); }");
const refused = (await t.run('cd /home/user/ex-decl && node requirer.js', 30_000)).output;
A.check(
  'named-decl: require() of it throws ERR_REQUIRE_ASYNC_MODULE, as Node',
  /REQUIRE_REFUSED=ERR_REQUIRE_ASYNC_MODULE/.test(refused) && !/LOAD=/.test(refused),
  refused.slice(-700),
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
await t.writeFile('/home/user/ex-list/sib.mjs', listSrc);
await t.writeFile('/home/user/ex-list/consumer.js', "import('./sib.mjs');");
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
await t.writeFile('/home/user/ex-def/sib.mjs', defSrc);
await t.writeFile('/home/user/ex-def/consumer.js', "import('./sib.mjs');");
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
await t.writeFile('/home/user/ex-re/sub.js', 'module.exports.viaRe = "REEXP_OK";');
const reSrc = `
import { join } from 'node:path';
const _t = await Promise.resolve(2);
export { viaRe } from './sub.js';
console.log('RE_LOAD=' + (typeof join) + '_tla=' + _t);
`;
await t.writeFile('/home/user/ex-re/sib.mjs', reSrc);
await t.writeFile('/home/user/ex-re/consumer.js', "import('./sib.mjs');");
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
await t.writeFile('/home/user/ex-star/sub.js', 'module.exports.foo = "F"; module.exports.bar = "B";');
const starSrc = `
import { join } from 'node:path';
const _t = await Promise.resolve(3);
export * from './sub.js';
console.log('STAR_LOAD=' + (typeof join) + '_tla=' + _t);
`;
await t.writeFile('/home/user/ex-star/sib.mjs', starSrc);
// A module with top-level await is import()ed: require() of one throws
// ERR_REQUIRE_ASYNC_MODULE, as Node's does.
await t.writeFile('/home/user/ex-star/consumer.js', "import('./sib.mjs').then((ns) => console.log('STAR_NAMES=' + Object.keys(ns).join(',')));");
const starResult = await t.run('cd /home/user/ex-star && node consumer.js', 30_000);
const starOut = starResult.output;
A.check(
  're-export star: module body executes',
  /STAR_LOAD=function_tla=3/.test(starOut),
  starOut.slice(-700),
);
A.check(
  're-export star: the CommonJS names come through the star',
  /STAR_NAMES=bar,foo/.test(starOut),
  starOut.slice(-700),
);
A.check(
  're-export star: NO "Unexpected token" error',
  !/Unexpected token/.test(starOut),
  starOut.slice(-500),
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
