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
//     deliberately clears it. The other order leaves a guest that reads a
//     filesystem it can never write back to, which looks like success.
//   - a fresh WebAssembly.Instance per call, so one `python -c` never sees the
//     previous caller's __main__.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildCPythonPreamble } from '../../packages/worker/src/runtime/cpython-runner.ts';

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
const adoptAt = preamble.indexOf('__wasiAdoptSupervisor(globalThis.__nimbusSupervisor');
assert.ok(initFsAt > 0 && adoptAt > initFsAt,
  'the supervisor must be adopted after __wasiInitFS, which clears it');

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

const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
const snapshot = {
  root: '',
  files: {
    'usr/local/lib/python313.zip': toB64(readFileSync(STDLIB)),
    'usr/local/lib/python3.13/os.py': toB64(Buffer.from('# stdlib marker\n')),
  },
  dirs: ['usr', 'usr/local', 'usr/local/lib', 'usr/local/lib/python3.13',
         'usr/local/lib/python3.13/lib-dynload', 'home', 'home/user'],
  modes: {
    '': 7, usr: 7, 'usr/local': 7, 'usr/local/lib': 7,
    'usr/local/lib/python3.13': 7, 'usr/local/lib/python3.13/lib-dynload': 7,
    home: 7, 'home/user': 7,
    'usr/local/lib/python313.zip': 7, 'usr/local/lib/python3.13/os.py': 7,
  },
};
const base = {
  pythonHome: '/usr/local',
  userEnv: { HOME: '/home/user', PYTHONUNBUFFERED: '1' },
  progName: 'python',
  cwd: '/home/user',
  fsSnapshot: snapshot,
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

console.log('cpython-runner-preamble: all cases passed');
