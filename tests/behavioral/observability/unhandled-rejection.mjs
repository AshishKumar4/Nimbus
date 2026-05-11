#!/usr/bin/env bun
// observability/unhandled-rejection — facet body installs an
// `unhandledrejection` / `error` listener that converts async
// fire-and-forget rejections (and uncaught setTimeout-scheduled
// errors) into stderr lines + exitCode=1. Pre-fix: silent exit
// with exitCode=0 and empty stderr (the W5 zero-silent-OOM
// contract only catches non-zero exits).
//
// Root cause (audit 2026-05-11-unhandled-rejection):
//
//   The facet's `NodeProcess.run()` wraps `__compiledFn(...)` in a
//   try/catch (manager.ts:376-397) that only captures SYNCHRONOUS
//   exceptions. Asynchronous rejections from `import().then()` calls
//   without `.catch`, or unawaited async-function throws, fire during
//   the microtask drain at line 400 and are NEITHER caught nor
//   reported. Facet exits exitCode=0 with empty stderr. User sees
//   a return-to-prompt with no diagnostic.
//
// Probe asserts:
//   1. synthetic-rejection-loud: `Promise.reject(new Error('boom'))`
//      with no .catch → stderr contains "Unhandled promise rejection"
//      + the message, AND the process exits with code 1.
//   2. async-fire-forget: an unawaited async function that throws →
//      same shape.
//   3. handler-no-double: `Promise.reject(new Error('caught')).catch(()=>{})`
//      → NO "Unhandled promise rejection" string, exit=0. Verifies
//      the listener doesn't false-positive on handled rejections.
//   4. dynamic-import-regression: dynamic-import probe still works
//      (the listener doesn't interfere with the existing fix).

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[observability/unhandled-rejection] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('observability/unhandled-rejection');

async function writeFile(path, contents) {
  await t.run(`cat > ${path} << 'NIMBUS_HEREDOC_EOF'\n${contents}\nNIMBUS_HEREDOC_EOF`, 10_000);
}

// ── Check 1: synthetic-rejection-loud ──────────────────────────────
//
// Promise.reject(...) with no .catch. Pre-fix the facet silently exits
// exitCode=0 with empty stderr. Post-fix the listener fires:
//   stderr: "Unhandled promise rejection: <Error.stack | message>"
//   exitCode: 1

await t.run('rm -rf /home/user/unhrej && mkdir -p /home/user/unhrej', 5_000);
await writeFile('/home/user/unhrej/rej.mjs', `
console.log('BEFORE');
Promise.reject(new Error('synthetic-boom-42'));
console.log('AFTER_KICKOFF');
`);
const rejR = await t.run('cd /home/user/unhrej && node rej.mjs', 30_000);
const rejOut = rejR.output;
A.check(
  'synthetic-rejection-loud: stderr contains "Unhandled promise rejection" + message',
  /Unhandled promise rejection[\s\S]*synthetic-boom-42/.test(rejOut),
  `tail: ${rejOut.slice(-700)}`,
);
A.check(
  'synthetic-rejection-loud: process exits with code 1 (NOT silent exit=0)',
  /exited with code 1/.test(rejOut) && !/exited with code 0/.test(rejOut),
  `tail: ${rejOut.slice(-700)}`,
);

// ── Check 2: async-fire-forget ─────────────────────────────────────
//
// Unawaited async function that throws. Same observable behaviour as
// Promise.reject — the listener fires.

await t.run('rm -rf /home/user/aff && mkdir -p /home/user/aff', 5_000);
await writeFile('/home/user/aff/aff.mjs', `
async function failing() { throw new Error('async-fire-forget-99'); }
console.log('BEFORE');
failing();
console.log('AFTER_KICKOFF');
`);
const affR = await t.run('cd /home/user/aff && node aff.mjs', 30_000);
const affOut = affR.output;
A.check(
  'async-fire-forget: stderr contains "Unhandled promise rejection" + message',
  /Unhandled promise rejection[\s\S]*async-fire-forget-99/.test(affOut),
  `tail: ${affOut.slice(-700)}`,
);
A.check(
  'async-fire-forget: process exits with code 1',
  /exited with code 1/.test(affOut),
  `tail: ${affOut.slice(-700)}`,
);

// ── Check 3: handler-no-double ──────────────────────────────────────
//
// Rejection WITH explicit .catch handler attached → no unhandledrejection
// event → listener doesn't fire. Process exits cleanly with code 0.

await t.run('rm -rf /home/user/handled && mkdir -p /home/user/handled', 5_000);
await writeFile('/home/user/handled/handled.mjs', `
Promise.reject(new Error('caught-101')).catch(() => { console.log('CAUGHT_OK'); });
`);
const handR = await t.run('cd /home/user/handled && node handled.mjs', 30_000);
const handOut = handR.output;
A.check(
  'handler-no-double: NO "Unhandled promise rejection" stderr (rejection was caught)',
  !/Unhandled promise rejection/.test(handOut),
  `tail: ${handOut.slice(-500)}`,
);
A.check(
  'handler-no-double: .catch handler fired (CAUGHT_OK printed)',
  /CAUGHT_OK/.test(handOut),
  `tail: ${handOut.slice(-500)}`,
);
A.check(
  'handler-no-double: process exits cleanly (code 0)',
  /exited with code 0/.test(handOut),
  `tail: ${handOut.slice(-500)}`,
);

// ── Check 4: dynamic-import-regression ──────────────────────────────
//
// Run a single check from the dynamic-import wave to confirm the
// new listener doesn't break the existing fix. import('./mod').then(m => log)
// should still print mod's export and exit cleanly.

await t.run('rm -rf /home/user/dyn-reg && mkdir -p /home/user/dyn-reg', 5_000);
await writeFile('/home/user/dyn-reg/mod.mjs', "export const X = 'REG_OK';");
await writeFile('/home/user/dyn-reg/entry.mjs', `import('./mod.mjs').then(m => console.log('RESULT=' + m.X));`);
const regR = await t.run('cd /home/user/dyn-reg && node entry.mjs', 30_000);
const regOut = regR.output;
A.check(
  'dynamic-import-regression: RESULT=REG_OK printed (existing fix still works)',
  /RESULT=REG_OK/.test(regOut),
  `tail: ${regOut.slice(-500)}`,
);
A.check(
  'dynamic-import-regression: process exits with code 0 (no false-positive from listener)',
  /exited with code 0/.test(regOut) && !/Unhandled promise rejection/.test(regOut),
  `tail: ${regOut.slice(-500)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
