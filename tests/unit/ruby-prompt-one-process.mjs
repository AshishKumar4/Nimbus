#!/usr/bin/env bun
// The Ruby prompt is one process: each of its lines is a __rubyRun of the
// same pid, and they all run on the one filesystem mount its first line made,
// as the Python prompt's do. A file a line opens is open on the next line,
// as in irb. A run of another pid in the same facet (a warm facet's next
// process) gets a fresh mount, so none of the last process's descriptors.
//
// Driven through the runner's own __rubyRun over the WASI host (worker
// wasi/preamble.ts), the VM stood in for by a program that makes WASI file
// calls through the host's imports.
//
// Red before: every __rubyRun mounted afresh (__wasiInitFS), so each prompt
// line was a new process to the host: its descriptor table was emptied, the
// held file answered EBADF, and with the caller's credential a new resident
// filesystem reopened the binding's first write epoch, and the session
// refused its writes (EIO, repl/ruby-hello-repl on a throwaway at 5d8c40c90).

import assert from 'node:assert/strict';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';
import { outputControlReader } from '../../packages/core/src/runtime/wasi/output-control.ts';
import { memorySupervisor } from './lib/descriptor-supervisor.mjs';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';
import { loadWasiPreamble } from './lib/wasi-authority.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const P = await loadWasiPreamble();
const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

/** The guest's view of the host: its imports, over a memory of its own. */
function guest() {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const { wasiImport } = makeImportsWithoutJSPI(P, { argv: ['ruby'], env: {}, getMemory: () => memory, stdoutWrite: () => {}, stderrWrite: () => {} });
  const view = () => new DataView(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);
  return {
    async open(path) {
      const bytes = enc.encode(path);
      u8().set(bytes, 0x100);
      const errno = await wasiImport.path_open(3, 1, 0x100, bytes.length, 1 /* O_CREAT */, -1n, -1n, 0, 0x200);
      return { errno, fd: view().getUint32(0x200, true) };
    },
    async write(fd, text) {
      const bytes = enc.encode(text);
      u8().set(bytes, 0x400);
      view().setUint32(0x300, 0x400, true);
      view().setUint32(0x304, bytes.length, true);
      return await wasiImport.fd_write(fd, 0x300, 1, 0x200);
    },
    close: async (fd) => await wasiImport.fd_close(fd),
  };
}

// Each line's program, as the VM would run it (the runner's wrapper of the
// user's code; its prelude and exit-status evals do nothing here): what the
// test hands it next, and what it answered.
let program = async () => 0;
let answered = null;
const supervisor = Object.assign(memorySupervisor(), { stdout: async () => {}, stderr: async () => {} });
Object.assign(globalThis, {
  __wasiSupervisorOutput: wasiOutputRelay,
  __wasiOutputControl: outputControlReader,
  __wasiSettled: async (result) => result,
  __nimbusRubyStep: async () => ({ resumed: false, alive: false }),
  __runLine: async (code) => {
    if (code.includes('TOPLEVEL_BINDING')) answered = await program();
    return { status: 0 };
  },
});
new Function('__wasiInitFS', '__wasiAdoptSupervisor', 'globalThis',
  `${RUBY_RUNNER_PREAMBLE_TAIL}\nasync function __nimbusRubyEval(boot, code) { return globalThis.__runLine(code); }`)(P.__wasiInitFS, P.__wasiAdoptSupervisor, globalThis);
globalThis.__rubyBootstrap = Promise.resolve({ ok: true, rubyInitialized: true });
globalThis.__nimbusRubySupervisor = supervisor;

/** One line of process `pid`, run by __rubyRun: what its program answered (a WASI errno). */
const line = async (pid, body) => {
  program = body;
  answered = null;
  const result = await globalThis.__rubyRun({ userCode: 'line', requires: [], rbArgv: [], userEnv: {}, progName: 'irb', binName: 'ruby', cwd: '/home/user', supervisorPid: pid, cred: CRED });
  assert.equal(result.error, undefined, result.error);
  return answered;
};

const failed = [];
const check = (what, actual, expected) => {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ✓ ${what}`);
  } catch {
    failed.push(`${what}\n  expected ${JSON.stringify(expected)}\n  got ${JSON.stringify(actual)}`);
    console.log(`  ✗ ${what}`);
  }
};

const host = guest();
let held = -1;
const first = await line(7, async () => {
  const opened = await host.open('home/user/held.txt');
  held = opened.fd;
  return opened.errno;
});
check('the first line opens a file', first, 0);
const second = await line(7, async () => {
  const wrote = await host.write(held, 'kept across lines');
  return wrote === 0 ? await host.close(held) : wrote;
});
check('the next line of the same process writes and closes it', second, 0);
check('and the file holds what it wrote', dec.decode(supervisor.store.get('home/user/held.txt') ?? new Uint8Array()), 'kept across lines');

// Another process in the facet: none of the last one's descriptors.
const reopened = await line(7, async () => {
  const opened = await host.open('home/user/left.txt');
  held = opened.fd;
  return opened.errno;
});
check('a line opens another file', reopened, 0);
const next = await line(8, async () => await host.write(held, 'x'));
check('a run of another pid finds that descriptor gone (EBADF)', next, 8);

assert.deepEqual(failed, [], failed.join('\n'));
console.log('ruby-prompt-one-process: ok');
