#!/usr/bin/env bun
// Behavior test: buildCPythonPreamble() composes a facet that boots CPython.
//
// cpython-runner.ts ships the interpreter into a loader child as source: the
// virtual socket kernel, then the WASI host, then CPYTHON_PREAMBLE_TAIL. What
// the runner then calls is globalThis.__cpythonRun. This asserts that contract
// against the real composed text and the real committed artifact, because the
// three pieces only exist together inside a facet and nothing else typechecks
// their seam.
//
// Two orderings inside the tail are load-bearing and are asserted here rather
// than left to review:
//   - __wasiInitFS runs BEFORE the supervisor is adopted, because initFS
//     deliberately clears it. The other order leaves a guest with no
//     filesystem at all: every open answers EBADF.
//   - a fresh WebAssembly.Instance per call, so one `python -c` never sees the
//     previous caller's __main__.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildCPythonPreamble } from '../../packages/core/src/runtime/cpython-runner.ts';
import { buildCPythonSocketProcessWorker } from '../../packages/worker/src/runtime/cpython-resident.ts';
import { makeSession } from './lib/wasi-authority.mjs';

const RUNTIME_DIR = path.join(
  import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname),
  '../../packages/worker/wasm/python');
const WASM = path.join(RUNTIME_DIR, 'python.wasm');
const STDLIB = path.join(RUNTIME_DIR, 'python313.zip');
if (!existsSync(WASM) || !existsSync(STDLIB)) {
  console.log('cpython-runner-preamble: SKIPPED (python.wasm not built)');
  process.exit(0);
}

const preamble = buildCPythonPreamble();
assert.ok(preamble.includes('__cpythonRun'), 'the tail must be present');
assert.ok(preamble.includes('__nimbusVirtualSockets'), 'the socket kernel must be present');
assert.ok(preamble.includes('__wasiMakeImports'), 'the WASI host must be present');

// initFS must come before the supervisor adoption in the emitted text.
const initFsAt = preamble.indexOf('__wasiInitFS({');
const adoptAt = preamble.indexOf('__wasiAdoptSupervisor(globalThis.__nimbusPySupervisor');
assert.ok(initFsAt > 0 && adoptAt > initFsAt,
  'the supervisor must be adopted after __wasiInitFS, which clears it');

// ── The four invariants this runtime rediscovered by hitting them ──────────
// Every one of these was already true of ruby-runner, and every one cost a
// debugging cycle here. A header comment only helps a reader who knows to look;
// these assertions fail for the next person instead. They read emitted text
// because that is what a facet actually receives — the seam has no types.
{
  const socketWorker = buildCPythonSocketProcessWorker(preamble);

  // 1. Every entry into the VM is wrapped, not just the calls known to park:
  //    a Suspending import traps on an unpromised stack even returning an i32.
  assert.ok(/__nimbusEnterVm\s*=\s*\(fn\)\s*=>[\s\S]{0,120}WebAssembly\.promising/.test(preamble),
    'the VM entry helper must be WebAssembly.promising');
  for (const entry of ['_initialize', 'nimbus_py_init', 'nimbus_py_run', 'nimbus_py_flush']) {
    const bare = new RegExp(`(?<!__nimbusEnterVm\\()\\bexports\\.${entry}\\s*\\(`);
    assert.ok(!bare.test(preamble), `${entry} must be called through __nimbusEnterVm`);
  }

  // 2. The supervisor is adopted AFTER __wasiInitFS, which clears it on purpose.
  const initFsAt = preamble.indexOf('__wasiInitFS({');
  const adoptAt = preamble.indexOf('__wasiAdoptSupervisor(globalThis.__nimbusPySupervisor');
  assert.ok(initFsAt > 0 && adoptAt > initFsAt,
    'the supervisor must be adopted after __wasiInitFS, which clears it');

  // 3. The interpreter sees the whole session at '/': there is nothing to
  //    seed, and a preamble that still carried a seed would be carrying a
  //    filesystem nobody reads.
  assert.ok(/__wasiInitFS\(\{\s*root:\s*'',\s*preopens:\s*\[\{\s*wasiPath:\s*'\/',\s*vfsPath:\s*''\s*\}\]\s*\}\)/.test(preamble),
    'the boot must init the session root as the only preopen, and nothing else');
  assert.ok(!/fsSnapshot|__wasiDrainPersist|__wasiRevalidateFS/.test(preamble),
    'the boot must not carry a seed or a persist queue');

  // 4. A spawned process needs the module published where the preamble looks.
  assert.ok(socketWorker.includes("globalThis.__NIMBUS_WASM['python.wasm']"),
    'the socket worker must publish python.wasm to __NIMBUS_WASM');

  // Supervisor publish/adopt are asserted over EVERY facet entry by
  // cpython-facet-entry-invariants.mjs, which discovers them rather than
  // listing files — repeating them here would be a second list to rot.
  //
  // The pool is built per invocation: supervisorPid is baked into the
  //    SUPERVISOR binding at construction, so a held pool hands every later
  //    caller the first caller's write credential.
  const runnerSrc = readFileSync(path.join(RUNTIME_DIR, '../../../core/src/runtime/cpython-runner.ts'), 'utf8');
  assert.ok(!/let\s+pool\s*:\s*(?:Nimbus)?IsolatePool\s*\|\s*null/.test(runnerSrc),
    'the loader pool must not be cached across invocations');
  console.log('  ok  the preamble-text invariants ruby already knew are asserted, not documented');
}

// The preamble is module-scope text in a facet; give it a module to be.
const modPath = path.join(os.tmpdir(), `cpython-preamble-${process.pid}.mjs`);
writeFileSync(modPath, `${preamble}\nexport const ready = true;\n`);
try {
  globalThis.__NIMBUS_WASM = { 'python.wasm': new WebAssembly.Module(readFileSync(WASM)) };
  await import(pathToFileURL(modPath).href);
} finally {
  rmSync(modPath, { force: true });
}

const run = globalThis.__cpythonRun;
assert.equal(typeof run, 'function', 'the preamble must install __cpythonRun');
console.log('  ok  the composed preamble installs __cpythonRun');

// The session the interpreter runs in, adopted the way cpythonRunFacetFn
// adopts it: published on globalThis, where the boot re-adopts it after
// __wasiInitFS has cleared the previous adoption.
const session = makeSession({
  dirs: ['opt/py/lib/python3.13/lib-dynload'],
  files: {
    'opt/py/lib/python313.zip': readFileSync(STDLIB),
    'opt/py/lib/python3.13/os.py': '# stdlib marker\n',
  },
});
globalThis.__nimbusPySupervisor = session.supervisor;
const base = {
  pythonHome: '/opt/py',
  userEnv: { HOME: '/home/user', PYTHONUNBUFFERED: '1' },
  progName: 'python',
  cwd: '/home/user',
};

// A one-shot invocation, exactly as cpythonRunFacetFn calls it.
const hello = await run({ ...base, pyArgv: ['-c'], userCode: "print('hello from the runner preamble')" });
assert.equal(hello.error, undefined, `unexpected error: ${hello.error}\n${hello.stderr}`);
assert.equal(hello.exitCode, 0);
assert.equal(hello.stdout.trim(), 'hello from the runner preamble');
console.log('  ok  __cpythonRun boots an interpreter and returns its output');

// SystemExit is the process exit code, not a traceback.
const bye = await run({ ...base, pyArgv: ['-c'], userCode: 'import sys; sys.exit(7)' });
assert.equal(bye.exitCode, 7, 'sys.exit must reach the shell as an exit code');
console.log('  ok  sys.exit reaches the caller as an exit code');

// A fresh interpreter per call: the previous call's __main__ must not leak.
const first = await run({ ...base, pyArgv: ['-c'], userCode: 'LEAKED = 1' });
assert.equal(first.exitCode, 0);
const second = await run({
  ...base, pyArgv: ['-c'],
  userCode: "print('leaked' if 'LEAKED' in dir() else 'clean')",
});
assert.equal(second.stdout.trim(), 'clean', 'each invocation must get a pristine interpreter');
console.log('  ok  each invocation gets a fresh interpreter');

// Output and exit status survive a failing program, and stderr carries why.
const boom = await run({ ...base, pyArgv: ['-c'], userCode: "print('before'); raise ValueError('deliberate')" });
assert.equal(boom.exitCode, 1);
assert.equal(boom.stdout.trim(), 'before', 'stdout written before the failure must not be lost');
assert.match(boom.stderr, /ValueError: deliberate/);
console.log('  ok  a failing program keeps its stdout and reports why on stderr');

// What the program writes is in the session when the call returns.
const wrote = await run({ ...base, pyArgv: ['-c'], userCode: "open('/home/user/out.txt', 'w').write('from python')" });
assert.equal(wrote.exitCode, 0, wrote.stderr);
assert.equal(session.user.readFileString('home/user/out.txt'), 'from python');
console.log('  ok  a write is in the session filesystem when __cpythonRun returns');

await session.dispose();
console.log('cpython-runner-preamble: all cases passed');
