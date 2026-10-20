#!/usr/bin/env bun
// runtime-primitives/bin-tsc-native — `npm i typescript` gets a native
// binary; `tsc` still compiles, and says which compiler did.
//
// TypeScript 7 ships the compiler as a platform-specific executable: the
// `typescript` package's `bin/tsc` only finds @typescript/typescript-<os>-<arch>
// and hands the process to it. Nothing in the sandbox runs an ELF image, so
// Nimbus answers that `tsc` with tsrs, the Rust port of TypeScript 7 built to
// wasm (runtime/tsrs.ts), and a line naming the installed package and why.
//
// What must hold:
//
//   1. `npm i typescript` (unpinned, whatever `latest` is) installs.
//   2. `tsc` COMES BACK: an unrunnable binary never presents as a hang.
//   3. It says what ran instead of the installed compiler, and why.
//   4. It compiles: a type error is reported as tsc reports it, exit 2.
//
// bin-tsc pins 5.7.3, a JavaScript compiler, which runs as installed.

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

  // ── the invocation must come back, saying what runs ───────────────────
  const invoke = await run(t, 'tsc --version', BIN_TIMEOUT_MS);
  check(`\`tsc\` returns within ${BIN_TIMEOUT_MS / 1000}s instead of hanging`, invoke.ok,
    invoke.ok ? `${invoke.elapsed}ms (typescript@${installed})`
      : `no prompt after ${invoke.elapsed}ms — an unrunnable native binary presented as a hang; ` +
        `output=${JSON.stringify(invoke.output.slice(-400))}`);

  // A major other than 7 means npm's `latest` moved back to a JS
  // compiler, which runs as installed (bin-tsc); nothing here to assert.
  const major = Number.parseInt(installed, 10);
  if (Number.isFinite(major) && major < 7) {
    console.log(`  note: npm latest is typescript@${installed}, a JavaScript compiler; bin-tsc covers it`);
  } else if (invoke.ok) {
    const out = invoke.output;
    const says = new RegExp(`typescript ${installed.replace(/\./g, '\\.')} here is a native compiler.*running tsrs`).test(out);
    check('it says the installed compiler is native and tsrs runs instead', says && /\(tsrs /.test(out),
      says ? '' : `output=${JSON.stringify(out.slice(-500))}`);
    await run(t, `mkdir -p src && echo 'export const n: number = "seven";' > src/bad.ts && echo '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}' > tsconfig.json`, 20_000);
    const checked = await run(t, 'tsc; echo "exit=$?"', BIN_TIMEOUT_MS);
    const reported = /src\/bad\.ts\(1,14\): error TS2322/.test(checked.output) && /exit=2/.test(checked.output);
    check('and it compiles: the type error, exit 2', reported, reported ? '' : `output=${JSON.stringify(checked.output.slice(-500))}`);
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
