#!/usr/bin/env bun
// A Ruby server's launch reports its port however long the program takes to
// bind. rackup spends ~20 s in `require` on a live session (every file lookup
// is a supervisor round trip), and the launch used to give up after 10 s and
// report a portless "started" while the port answered 502.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plugin } from 'bun';
import { buildRubySocketProcessWorker } from '../../packages/worker/src/runtime/ruby-resident.ts';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';
import { outputControlReader } from '../../packages/core/src/runtime/wasi/output-control.ts';

plugin({
  name: 'cloudflare-shims',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: { DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } },
    }));
  },
});

// The interpreter is stood in for by a program that binds only when told to.
const preamble = [
  'function __wasiAdoptSupervisor() {}',
  'globalThis.__nimbusRubyDrainOutput = () => globalThis.__testOutput.drain();',
  'globalThis.__nimbusRubyStep = async () => ({ resumed: false, alive: true, wakeAfter: null });',
  'globalThis.__rubyRun = () => new Promise((resolve) => {',
  '  globalThis.__testBind = (port) => globalThis.__nimbusVirtualSockets.listen(port);',
  '  globalThis.__testExit = () => resolve({ exitCode: 0, stdout: "done\\n", stderr: "" });',
  // Stand in for the same bounded byte/control path as the real preamble.
  '  globalThis.__testWrite = (stream, text) => {',
  '    globalThis.__testOutput[stream+"Bytes"](new TextEncoder().encode(text));',
  '  };',
  '});',
].join('\n');

// Timers are driven by hand so "longer than any boot deadline" costs no wall time.
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
globalThis.clearTimeout = () => {};
const elapse = (ms) => { for (const t of timers.splice(0)) if (t.ms <= ms) t.fn(); else timers.push(t); };
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0));

const boot = async (stage, env = {}) => {
  // One module instance is one process, and its state lives on globalThis.
  for (const key of Object.keys(globalThis)) if (key.startsWith('__nimbus')) delete globalThis[key];
  const { NimbusProcess } = await import(join(dir, `worker.mjs?${stage}`));
  const proc = new NimbusProcess({}, env);
  const control = outputControlReader([{key:'resume',prefix:'__NIMBUS_RESUMED_',suffix:'\n'}]);
  globalThis.__testOutput = wasiOutputRelay({stdout:b=>env.SUPERVISOR?.stdout(b),stderr:b=>{const data=control.feed(b);if(data.length)return env.SUPERVISOR?.stderr(data);}});
  const state = { boot: null };
  const booting = proc.startProcess({ userCode: 'run app', rbArgv: [], userEnv: {}, progName: 'rackup', cwd: '/home/user' })
    .then((value) => { state.boot = value; });
  await settle();
  elapse(60_000);
  await settle();
  assert.equal(state.boot, null, 'a program still loading has not booted yet, however long it has taken');
  // The program writes while it loads, before it binds: at a fixed point of
  // the boot, not after however many macrotasks the import took.
  if (stage === 'stream' || stage === 'drain') {
    globalThis.__testWrite('stdout', 'loading\n');
    globalThis.__testWrite('stderr', '__NIMBUS_RESUMED_true_1_0_nil\n');
    globalThis.__testWrite('stderr', 'Ignoring debug\n');
  }
  if (stage === 'bind' || stage === 'stream' || stage === 'drain') globalThis.__testBind(8126);
  else globalThis.__testExit();
  if (stage === 'drain') {
    await settle();
    assert.equal(state.boot, null, 'a listener does not retire its boot I/O context while output RPCs are pending');
    globalThis.__testAcknowledge();
  }
  await booting;
  await globalThis.__testOutput.drain();
  return state.boot;
};

const dir = mkdtempSync(join(tmpdir(), 'ruby-resident-slow-boot-'));
try {
  writeFileSync(join(dir, 'ruby+stdlib.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  writeFileSync(join(dir, 'worker.mjs'), buildRubySocketProcessWorker(preamble));

  const server = await boot('bind');
  assert.equal(server.state, 'listening');
  assert.equal(server.port, 8126, 'the launch reports the port the program bound');
  console.log('  ok  a server that binds after a minute of loading reports its port');

  const script = await boot('exit');
  assert.equal(script.state, 'exited');
  assert.equal(script.result.stdout, 'done\n', 'a slow script that never binds answers with its own output');
  console.log('  ok  a script that runs past a minute and exits reports its result');

  // With a supervisor, output leaves the process as it is written, in order,
  // and the runner's own markers never do; the boot answer repeats none of it.
  const sent = [];
  const SUPERVISOR = {
    stdout: async (bytes) => { sent.push(['stdout', new TextDecoder().decode(bytes)]); },
    stderr: async (bytes) => { sent.push(['stderr', new TextDecoder().decode(bytes)]); },
    registerPort: async () => {},
  };
  const streamed = await boot('stream', { SUPERVISOR });
  assert.deepEqual(sent, [['stdout', 'loading\n'], ['stderr', 'Ignoring debug\n']], 'written output left the process before the boot answered');
  assert.equal(streamed.stdout, '', 'and the boot answer does not repeat it');
  assert.equal(streamed.stderr, '');
  console.log('  ok  a booting process streams what it writes, markers excluded');
  const drained = await boot('drain', { SUPERVISOR: {
    stdout: () => new Promise(resolve => { globalThis.__testAcknowledge = resolve; }),
    stderr: async () => {}, registerPort: async () => {},
  } });
  assert.equal(drained.state, 'listening');
  console.log('  ok  boot output settles before the listener response ends its I/O context');
} finally {
  globalThis.setTimeout = realSetTimeout;
  rmSync(dir, { recursive: true, force: true });
}
