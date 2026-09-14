#!/usr/bin/env bun
// runtime-primitives/bin-tsc — does `tsc` compile?
//
// The previous version of this probe substituted a three-line `echocli`
// for the compiler and asserted that the shell routed to it, on the
// stated grounds that "tsc + many real bins crash on Nimbus's facet
// runtime for unrelated reasons". That is the feature under test. A
// probe that passes while `tsc --version` hangs forever on production
// is worse than no probe: it buys a green signal with a regression-blind
// period (tests/behavioral/PROBE-QUALITY.md).
//
// So this asserts on compiler OUTPUT, through the surface a user has:
// type `tsc` at the prompt after `npm i typescript`.
//
//   1. `tsc --version` prints the version it installed.
//   2. `tsc -p .` on a valid project EMITS JavaScript, and the emitted
//      file contains the compiled form of the source.
//   3. `tsc --noEmit` on a deliberate type error reports that error, by
//      its real TypeScript diagnostic code.
//
// (2) and (3) are the two halves that matter: a compiler that emits
// nothing is broken, and a compiler that emits without checking is
// worse than broken. Neither can be satisfied by anything other than
// the real tsc having run to completion.
//
// The version is PINNED. `npm i typescript` resolves to TypeScript 7,
// which is a native ELF executable (`@typescript/typescript-linux-x64`)
// that its JS shim launches with `execFileSync` — nothing a wasm sandbox
// can run, and nothing this probe can assert compiler output against.
// 5.7.3 is the JS compiler, and pinning it keeps this probe measuring
// Nimbus rather than measuring npm's `latest` tag. What `npm i typescript`
// does today is the subject of its sibling, bin-tsc-native.
//
// Every step is bounded. A step that does not come back is a FAIL with
// the elapsed time, never a hang — that failure mode is the one this
// probe exists to catch.

import { mintSession, Terminal, stripAnsi, deleteSession, makeAsserter, BASE } from '../_driver.mjs';
import { run } from './_run.mjs';

const TS_VERSION = '5.7.3';
const DIR = '/home/user/tsc-probe';

/**
 * Cleanup runs against a session whose supervisor may be gone — the exact
 * condition this probe exists to catch — and `deleteSession` has no timeout
 * of its own. Bound it, or a failing probe hangs the suite it is part of.
 */
function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: label }), ms)),
  ]);
}


const PKG_JSON = JSON.stringify({ name: 'tsc-probe', version: '1.0.0', private: true });
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2020',
    module: 'CommonJS',
    outDir: 'dist',
    rootDir: 'src',
    strict: true,
  },
  include: ['src'],
});
// Valid, and shaped so the emitted JS is recognisable: the type
// annotations are erased and the template literal survives, so the marker
// can only appear in output a compiler actually produced.
const GOOD_TS = [
  'export function greet(who: string): string {',
  '  return `NIMBUS-TSC-EMIT:${who}`;',
  '}',
  'export const answer: number = greet("ok").length;',
].join('\n');
// `string` is not assignable to `number` — TS2322, one of the most
// stable diagnostic codes TypeScript has.
const BAD_TS = 'export const wrong: number = "not a number";\n';

// A probe whose subject is "this never comes back" must bound its own total
// runtime, or a regression turns one red probe into a stalled suite. Every
// step below is bounded individually; this is the backstop for the sum.
const WALL_CLOCK_MS = 10 * 60 * 1000;
const wallClock = setTimeout(() => {
  console.error(`[bin-tsc] exceeded ${WALL_CLOCK_MS / 1000}s total; the suite is not a place to hang`);
  process.exit(1);
}, WALL_CLOCK_MS);

const sid = await mintSession();
const a = makeAsserter('bin-tsc');
const check = a.check;

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);
  // ── Setup ────────────────────────────────────────────────────────────
  await run(t, `mkdir -p ${DIR}/src`, 15_000);
  await run(t, `cd ${DIR}`, 10_000);
  for (const [path, body] of [
    [`${DIR}/package.json`, PKG_JSON],
    [`${DIR}/tsconfig.json`, TSCONFIG],
    [`${DIR}/src/index.ts`, GOOD_TS],
  ]) {
    const b64 = Buffer.from(body, 'utf8').toString('base64');
    await run(
      t,
      `node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`,
      30_000,
    );
  }

  const install = await run(t, `npm i typescript@${TS_VERSION}`, 300_000);

  const shim = await run(t, `cat ${DIR}/node_modules/.bin/tsc`, 20_000);
  const shimPresent = shim.ok && /typescript\/bin\/tsc/.test(shim.output);
  check(`npm i typescript@${TS_VERSION} links node_modules/.bin/tsc`, shimPresent,
    shimPresent ? '' : `install=${install.ok} shim=${JSON.stringify(shim.output.slice(-300))}`);

  // Everything below needs the install. Without it the compiler
  // assertions would fail for a reason that is not about the compiler.
  if (!shimPresent) throw new Error('install precondition failed');

  // ── 1. the compiler answers at all ───────────────────────────────────
  const version = await run(t, 'tsc --version', 90_000);
  const versionOk = version.ok && new RegExp(`Version\\s+${TS_VERSION.replace(/\./g, '\\.')}`).test(version.output);
  check('`tsc --version` prints the installed version', versionOk,
    versionOk ? `${version.elapsed}ms`
      : `after ${version.elapsed}ms: ${version.error ? `${version.error}; ` : ''}output=${JSON.stringify(version.output.slice(-400))}`);

  // ── 2. the compiler EMITS ────────────────────────────────────────────
  const build = await run(t, 'tsc -p .', 120_000);

  const emitted = await run(t, `cat ${DIR}/dist/index.js`, 30_000);
  // The marker proves this is compiler output; `exports.greet` proves the
  // CommonJS module target was applied rather than the source copied.
  const emitOk = emitted.ok
    && /NIMBUS-TSC-EMIT/.test(emitted.output)
    && /exports\.greet/.test(emitted.output)
    && !/:\s*string/.test(emitted.output);
  check('`tsc -p .` emits compiled JavaScript to dist/index.js', emitOk,
    emitOk ? `${build.elapsed}ms`
      : `build after ${build.elapsed}ms ${build.ok ? 'returned' : `did not return (${build.error})`}; ` +
        `dist/index.js=${JSON.stringify(emitted.output.slice(-400))}`);

  // ── 3. the compiler CHECKS ───────────────────────────────────────────
  const badB64 = Buffer.from(BAD_TS, 'utf8').toString('base64');
  await run(
    t,
    `node -e "require('fs').writeFileSync('${DIR}/src/index.ts', Buffer.from('${badB64}','base64').toString('utf8'))"`,
    30_000,
  );
  const diag = await run(t, 'tsc -p . --noEmit', 120_000);
  const diagOk = diag.ok && /error TS2322/.test(diag.output);
  check('`tsc --noEmit` reports the real diagnostic for a type error', diagOk,
    diagOk ? `${diag.elapsed}ms`
      : `after ${diag.elapsed}ms: ${diag.error ? `${diag.error}; ` : ''}output=${JSON.stringify(diag.output.slice(-400))}`);
} catch (e) {
  if (a.pass + a.fail === 0) check('probe ran', false, e.message);
} finally {
  await withDeadline(t.close().catch(() => {}), 10_000, 'close');
  await withDeadline(deleteSession(sid).catch(() => {}), 30_000, 'delete');
}

clearTimeout(wallClock);
const { pass, fail } = a.summary();
process.exit(fail === 0 && pass > 0 ? 0 : 1);
