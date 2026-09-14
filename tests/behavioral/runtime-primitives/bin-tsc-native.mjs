#!/usr/bin/env bun
// runtime-primitives/bin-tsc-native — `npm i typescript` gets a native
// binary. Nimbus must say so, fast.
//
// TypeScript 7 ships the compiler as a platform-specific ELF executable.
// The `typescript` package's `bin/tsc` is a JS shim whose only job is to
// find that executable and hand the process over to it:
//
//   lib/tsc.js       → getExePath() → @typescript/typescript-<os>-<arch>
//                    → process.execve(exe) / execFileSync(exe)
//
// The executable is a statically linked Go binary. There is no version of
// Nimbus that runs it: the sandbox executes JavaScript and WebAssembly,
// and an x86-64 ELF image is neither. So `npm i typescript && tsc` cannot
// succeed, and the only question is whether the user is TOLD that or left
// waiting.
//
// This probe pins the answer to "told, and quickly". It is the companion
// to bin-tsc, which pins 5.7.3 — the last line that is a JavaScript
// compiler — and asserts that it actually compiles.
//
// What must hold:
//
//   1. `npm i typescript` (unpinned, whatever `latest` is) installs.
//   2. `tsc` COMES BACK. A bounded wait that expires is the failure this
//      probe exists to catch — an unrunnable binary must never present as
//      a hung terminal.
//   3. It comes back NON-ZERO. Reporting success for a compiler that
//      never ran is the silent-truncation failure.
//   4. The output names the cause. The user has to be able to act on it
//      without reading Nimbus's source.
//
// Check 4 deliberately does not pin an exact sentence — TypeScript owns
// part of this text and will reword it. It pins the two facts a user
// needs: which package could not be run, and that a platform/native
// constraint is why.

import { mintSession, Terminal, stripAnsi, deleteSession, makeAsserter, BASE } from '../_driver.mjs';
import { run } from './_run.mjs';

const DIR = '/home/user/tsc-native-probe';
/** `tsc` answers in ~3s today. A minute is generous and still bounded. */
const BIN_TIMEOUT_MS = 60_000;

const WALL_CLOCK_MS = 8 * 60 * 1000;
const wallClock = setTimeout(() => {
  console.error(`[bin-tsc-native] exceeded ${WALL_CLOCK_MS / 1000}s total`);
  process.exit(1);
}, WALL_CLOCK_MS);

function withDeadline(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
}

const sid = await mintSession();
console.log(`[bin-tsc-native] sid=${sid} BASE=${BASE}`);

const a = makeAsserter('bin-tsc-native');
const check = a.check;

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  await run(t, `mkdir -p ${DIR}`, 15_000);
  await run(t, `cd ${DIR}`, 10_000);
  await run(
    t,
    `node -e "require('fs').writeFileSync('${DIR}/package.json', JSON.stringify({name:'p',version:'1.0.0',private:true}))"`,
    30_000,
  );

  const install = await run(t, 'npm i typescript', 300_000);

  const shim = await run(t, `cat ${DIR}/node_modules/.bin/tsc`, 20_000);
  const shimPresent = shim.ok && /typescript\/bin\/tsc/.test(shim.output);
  check('`npm i typescript` links node_modules/.bin/tsc', shimPresent,
    shimPresent ? '' : `install=${install.ok} shim=${JSON.stringify(shim.output.slice(-300))}`);
  if (!shimPresent) throw new Error('install precondition failed');

  const ver = await run(
    t,
    `node -e "console.log('INSTALLED-' + require('${DIR}/node_modules/typescript/package.json').version)"`,
    30_000,
  );
  const installed = /INSTALLED-(\d+\.\d+\.\d+[^\s]*)/.exec(ver.output)?.[1] ?? '(unknown)';

  // ── the invocation must come back, non-zero, with a reason ───────────
  const invoke = await run(t, 'tsc --version', BIN_TIMEOUT_MS);
  check(`\`tsc\` returns within ${BIN_TIMEOUT_MS / 1000}s instead of hanging`, invoke.ok,
    invoke.ok ? `${invoke.elapsed}ms (typescript@${installed})`
      : `no prompt after ${invoke.elapsed}ms — an unrunnable native binary presented as a hang; ` +
        `output=${JSON.stringify(invoke.output.slice(-400))}`);

  // A major other than 7 means npm's `latest` moved back to a JS
  // compiler. Then `tsc` should WORK, and bin-tsc is the probe that says
  // so; this one has nothing left to assert.
  const major = Number.parseInt(installed, 10);
  if (Number.isFinite(major) && major < 7) {
    console.log(`  note: npm latest is typescript@${installed}, a JavaScript compiler; bin-tsc covers it`);
  } else if (invoke.ok) {
    const out = invoke.output;
    const nonZero = /exited with code [1-9]/.test(out) || /code=[1-9]/.test(out);
    check('the failure is reported as a non-zero exit, not a success', nonZero,
      nonZero ? '' : `output=${JSON.stringify(out.slice(-500))}`);

    const namesPackage = /@typescript\/typescript-\w+-\w+/.test(out);
    const namesCause = /platform|native|executable|unsupported/i.test(out);
    check('the output names the platform package and why it cannot run',
      namesPackage && namesCause,
      namesPackage && namesCause ? ''
        : `namesPackage=${namesPackage} namesCause=${namesCause} output=${JSON.stringify(out.slice(-500))}`);
  }
} catch (e) {
  if (a.pass + a.fail === 0) check('probe ran', false, e.message);
} finally {
  await withDeadline(t.close().catch(() => {}), 10_000);
  await withDeadline(deleteSession(sid).catch(() => {}), 30_000);
}

clearTimeout(wallClock);
const { pass, fail } = a.summary();
process.exit(fail === 0 && pass > 0 ? 0 : 1);
