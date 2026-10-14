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

// The tail and the WASI host are proven by the boot below (it installs
// __cpythonRun and runs a program); the socket kernel is not, so it is pinned.
const preamble = buildCPythonPreamble();
assert.ok(preamble.includes('__nimbusVirtualSockets'), 'the socket kernel must be present');

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
  //    The credential rides along: it is what the interpreter's own copy of
  //    the namespace is read as (wasi/resident-filesystem.ts), not a mount.
  assert.ok(/__wasiInitFS\(\{\s*root:\s*'',\s*preopens:\s*\[\{\s*wasiPath:\s*'\/',\s*vfsPath:\s*''\s*\}\],\s*cred:\s*args\.cred,\s*pid:\s*args\.supervisorPid\s*\|\|\s*0\s*\}\)/.test(preamble),
    'the boot must init the session root as the only preopen, and nothing else');
  assert.ok(!/fsSnapshot|__wasiDrainPersist|__wasiRevalidateFS/.test(preamble),
    'the boot must not carry a seed or a persist queue');

  // 4. A spawned process needs the module published where the preamble looks.
  assert.ok(socketWorker.includes("globalThis.__NIMBUS_WASM['python.wasm']"),
    'the socket worker must publish python.wasm to __NIMBUS_WASM');

  // Supervisor publish/adopt are asserted over EVERY facet entry by
  // cpython-facet-entry-invariants.mjs, which discovers them rather than
  // listing files — repeating them here would be a second list to rot.
  // That the facet is opened per invocation under the invoker's pid is
  // runtime-image-handoff.mjs's, driven through the runner.
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

const guestRun = globalThis.__cpythonRun;
assert.equal(typeof guestRun, 'function', 'the preamble must install __cpythonRun');
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
const written = { stdout: [], stderr: [] };
globalThis.__nimbusPySupervisor = { ...session.supervisor,
  stdout: bytes => written.stdout.push(bytes.slice()),
  stderr: bytes => written.stderr.push(bytes.slice()),
};
const run = async args => {
  written.stdout.length = 0; written.stderr.length = 0;
  const result = await guestRun(args);
  assert.equal(result.stdout, '', 'the runtime returns no second copy of its streamed stdout');
  assert.equal(result.stderr, '', 'the runtime returns no second copy of its streamed stderr');
  return { ...result, stdout: Buffer.concat(written.stdout).toString(), stderr: Buffer.concat(written.stderr).toString() };
};
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

// With the process's credential the interpreter answers its filesystem from
// its own store and holds what it writes to a new file (wasi/resident-
// filesystem.ts). However the run ends (here os._exit, which skips Python's
// own shutdown), what it wrote is in the session when the call returns.
const credentialed = { ...base, cred: { uid: session.cred.uid, gid: session.cred.gid, groups: [...session.cred.groups] } };
const exited = await run({
  ...credentialed, pyArgv: ['-c'],
  userCode: "import os\nf = open('/home/user/exited.txt', 'w')\nf.write('kept by the host')\nf.flush()\nos._exit(3)",
});
assert.equal(session.user.readFileString('home/user/exited.txt'), 'kept by the host', `${exited.error ?? ''} ${exited.stderr}`);
console.log('  ok  a run ended by os._exit leaves what it wrote in the session');
// os.abort() traps the guest: the VM may not even flush, and the host settles anyway.
const aborted = await run({
  ...credentialed, pyArgv: ['-c'],
  userCode: "import os\nf = open('/home/user/aborted.txt', 'w')\nf.write('kept through a trap')\nf.flush()\nos.abort()",
});
assert.notEqual(aborted.exitCode, 0);
assert.equal(session.user.readFileString('home/user/aborted.txt'), 'kept through a trap', `${aborted.error ?? ''} ${aborted.stderr}`);
console.log('  ok  a run ended by a trap leaves what it wrote in the session');
// A flush that traps (here the program's own stdout.flush aborts): the host still settles.
const flushTrap = await run({
  ...credentialed, pyArgv: ['-c'],
  userCode: "import os, sys\nf = open('/home/user/flushtrap.txt', 'w')\nf.write('kept through a trapping flush')\nf.flush()\n"
    + "class Trap:\n  def write(self, s): return len(s)\n  def flush(self): os.abort()\nsys.stdout = Trap()",
});
assert.equal(session.user.readFileString('home/user/flushtrap.txt'), 'kept through a trapping flush', `${flushTrap.error ?? ''} ${flushTrap.stderr}`);
console.log('  ok  a run whose flush traps leaves what it wrote in the session');

// The interpreter's umask, mode and credential are the session's (nimbus-libc):
// a file is made with the mode asked for under the live umask, and the
// process is the user it runs as. Its umask was its own C variable, its open
// mode was dropped (preview1 carries none), and getuid answered 0.
const modes = await run({
  ...credentialed, pyArgv: ['-c'],
  userCode: "import os\nprint(os.getuid(), os.getgid())\nprint(oct(os.umask(0o077)))\n"
    + "open('/home/user/umask-077.txt', 'w').close()\nos.umask(0o022)\n"
    + "os.close(os.open('/home/user/open-0600.txt', os.O_WRONLY | os.O_CREAT, 0o600))\n"
    + "os.close(os.open('/home/user/open-0755.txt', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755))",
});
assert.equal(modes.exitCode, 0, `${modes.error ?? ''} ${modes.stderr}`);
assert.equal(modes.stdout, `${session.cred.uid} ${session.cred.gid}\n0o22\n`, 'the session\'s uid and gid, and its umask');
assert.equal(session.user.stat('home/user/umask-077.txt').mode & 0o7777, 0o600, 'a file made under umask 077 is 0600');
assert.equal(session.user.stat('home/user/open-0600.txt').mode & 0o7777, 0o600, 'os.open makes a file with its mode');
assert.equal(session.user.stat('home/user/open-0755.txt').mode & 0o7777, 0o755, 'an exclusive create keeps its execute bits');
console.log('  ok  the umask, a created file\'s mode and the credential are the session\'s');

// A name the interpreter's name table cannot hold is refused, never dialed as another.
const names = await run({
  ...base, pyArgv: ['-c'],
  userCode: "import socket\naddrs = [socket.getaddrinfo(f'host-{i}.invalid', 80)[0][4][0] for i in range(64)]\n"
    + "print(len(set(addrs)))\n"
    + "try:\n  socket.getaddrinfo('host-64.invalid', 80)\nexcept socket.gaierror as e:\n  print('refused', e.errno == socket.EAI_MEMORY)\n"
    + "print(socket.getaddrinfo('host-0.invalid', 80)[0][4][0] == addrs[0])",
});
assert.equal(names.exitCode, 0, `${names.error ?? ''} ${names.stderr}`);
assert.equal(names.stdout, '64\nrefused True\nTrue\n', 'the 65th name is refused; a known name keeps its address');
console.log('  ok  a full name table refuses a new name');

// A recvfrom on a socket with no peer fails as recv fails, and takes no name: 64 names still fit.
const unconnected = await run({
  ...base, pyArgv: ['-c'],
  userCode: "import errno, socket\ns = socket.socket()\ntry:\n  s.recvfrom(10)\nexcept OSError as e:\n  print(errno.errorcode.get(e.errno))\n"
    + "print(len({socket.getaddrinfo(f'host-{i}.invalid', 80)[0][4][0] for i in range(64)}))",
});
assert.equal(unconnected.exitCode, 0, `${unconnected.error ?? ''} ${unconnected.stderr}`);
assert.equal(unconnected.stdout, 'ENOTCONN\n64\n', 'recvfrom of an unconnected socket is ENOTCONN, and 64 names resolve after it');
console.log('  ok  a failed recvfrom takes no name');

await session.dispose();
console.log('cpython-runner-preamble: all cases passed');
