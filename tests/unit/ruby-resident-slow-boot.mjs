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
  'globalThis.__nimbusRubyStep = async () => ({ resumed: false, alive: true, wakeAfter: null });',
  'globalThis.__rubyRun = () => new Promise((resolve) => {',
  '  globalThis.__testBind = (port) => globalThis.__nimbusVirtualSockets.listen(port);',
  '  globalThis.__testExit = () => resolve({ exitCode: 0, stdout: "done\\n", stderr: "" });',
  '});',
].join('\n');

// Timers are driven by hand so "longer than any boot deadline" costs no wall time.
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
globalThis.clearTimeout = () => {};
const elapse = (ms) => { for (const t of timers.splice(0)) if (t.ms <= ms) t.fn(); else timers.push(t); };
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0));

const boot = async (stage) => {
  // One module instance is one process, and its state lives on globalThis.
  for (const key of Object.keys(globalThis)) if (key.startsWith('__nimbus')) delete globalThis[key];
  const { NimbusProcess } = await import(join(dir, `worker.mjs?${stage}`));
  const proc = new NimbusProcess({}, {});
  const state = { boot: null };
  const booting = proc.startProcess({ userCode: 'run app', rbArgv: [], userEnv: {}, progName: 'rackup', cwd: '/home/user' })
    .then((value) => { state.boot = value; });
  await settle();
  elapse(60_000);
  await settle();
  assert.equal(state.boot, null, 'a program still loading has not booted yet, however long it has taken');
  if (stage === 'bind') globalThis.__testBind(8126);
  else globalThis.__testExit();
  await booting;
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
} finally {
  globalThis.setTimeout = realSetTimeout;
  rmSync(dir, { recursive: true, force: true });
}
