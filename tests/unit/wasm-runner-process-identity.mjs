#!/usr/bin/env bun
// A wasm program runs as a child of the command that ran it, under that
// command's credential.
//
// wasm-runner registered each run as a process of its own, at the top of the
// table, so it ran under the table's default credential (the session user,
// uid 1000) whoever ran it, and it was in nobody's process tree. Under the
// Durable Object host a facet's file syscalls are answered under the
// credential the process table holds for the facet's pid (SupervisorRPC
// stamps the pid; core supervisor-op.ts credFor resolves it): a program a
// confined principal ran wrote where only the session user may. What has to
// hold, on the library host (localFacetHost, which answers through the view
// the runner bound) and on that rule:
//
//   (1) the run is a process under the command's own, so the reap of a call's
//       tree removes it: an unnamed ws.exec leaves none behind;
//   (2) a run a non-session principal started carries that principal's
//       credential, and its file syscalls are refused where that principal's
//       are.

import assert from 'node:assert/strict';
import wabtInit from 'wabt';

import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { rpcExec } from '../../packages/worker/src/session/programmatic.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { programmaticHost } from './lib/programmatic-host.mjs';

// Creates `made-by-guest` in its working directory (the preopen at fd 3) and
// exits with path_open's errno: 0 when it may, 2 (EACCES) when it may not.
const GUEST = `(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 16) "made-by-guest")
  (func (export "_start")
    (call $proc_exit
      (call $path_open (i32.const 3) (i32.const 0) (i32.const 16) (i32.const 13)
        (i32.const 9) (i64.const 0x1fffffff) (i64.const 0x1fffffff) (i32.const 0) (i32.const 64)))))`;
const wabt = await wabtInit();
const guestModule = wabt.parseWat('guest.wat', GUEST);
const GUEST_WASM = guestModule.toBinary({}).buffer;
guestModule.destroy();

const EACCES = 2;
const AGENT = { uid: 2000, gid: 2000 };

/**
 * The Durable Object host's rule, off workerd: a facet's syscalls answer under
 * the credential the process table holds for the facet's pid, whatever view
 * the runner bound (worker runtime/facet-loader-host.ts passes the pool only
 * the pid). Everything else is the local host's.
 */
function pidKeyedFacets(workspace) {
  const local = localFacetHost(ISOLATE_NETWORK);
  return {
    ...local,
    open(spec) {
      if (!spec.syscalls) return local.open(spec);
      const { pid } = spec.syscalls;
      const ws = workspace();
      return local.open({ ...spec, syscalls: { pid, vfs: ws.filesystem.bind({ pid, cred: ws.processes.cred(pid) }) } });
    },
  };
}

/** The guest, a directory only the session user may write in, and a principal who is not the session user. */
function seed(ws) {
  const kernel = ws.vfs.as(CRED_KERNEL);
  kernel.writeFile('home/user/guest.wasm', new Uint8Array(GUEST_WASM), { mode: 0o755 });
  kernel.chown('home/user/guest.wasm', 1000, 1000);
  kernel.mkdir('home/user/locked', { mode: 0o755 });
  kernel.chown('home/user/locked', 1000, 1000);
  const passwd = new TextDecoder().decode(kernel.readFile('etc/passwd'));
  kernel.writeFile('etc/passwd', `${passwd}agent:x:${AGENT.uid}:${AGENT.gid}:Agent:/home/agent:/bin/sh\n`);
}

const runners = (ws) => ws.processes.getAll().filter((entry) => entry.argv[0] === 'wasm-runner');
const made = (ws) => ws.vfs.as(CRED_KERNEL).exists('home/user/locked/made-by-guest');
const unmake = (ws) => { if (made(ws)) ws.vfs.as(CRED_KERNEL).unlink('home/user/locked/made-by-guest'); };

// ── The library host: ws.exec ───────────────────────────────────────────────
{
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, facets: localFacetHost(ISOLATE_NETWORK) });
  seed(ws);

  const own = await ws.exec('cd /home/user/locked && /home/user/guest.wasm');
  assert.equal(own.exitCode, 0, `the session user may create there: ${own.stderr}`);
  assert.ok(made(ws));
  assert.deepEqual(runners(ws), [], '(1) the call\'s reap took the run it started');
  unmake(ws);

  const confined = await ws.exec('cd /home/user/locked && sudo -u agent /home/user/guest.wasm');
  assert.equal(confined.exitCode, EACCES, `(2) the agent may not: ${confined.stderr}`);
  assert.equal(made(ws), false);
  assert.deepEqual(runners(ws), []);
}

// ── The Durable Object host's rule: the session's programmatic exec ────────
{
  let workspace = null;
  const { ws, host, close } = await programmaticHost({ facets: pidKeyedFacets(() => workspace) });
  workspace = ws;
  try {
    seed(ws);
    const own = await rpcExec(host, 'cd /home/user/locked && /home/user/guest.wasm');
    assert.equal(own.exitCode, 0, `the session user may create there: ${own.stderr}`);
    assert.ok(made(ws));
    unmake(ws);

    const line = 'cd /home/user/locked && sudo -u agent /home/user/guest.wasm';
    const confined = await rpcExec(host, line);
    const run = runners(ws).at(-1);
    assert.equal(run.cred.uid, AGENT.uid, '(2) the run carries the credential of the principal who started it');
    assert.equal(confined.exitCode, EACCES, `(2) and its file syscalls are refused where the agent's are: ${confined.stderr}`);
    assert.equal(made(ws), false);

    const job = ws.processes.getAll().find((entry) => entry.command === line);
    assert.ok(ws.processes.descendantsOf(job.pid).some((entry) => entry.pid === run.pid),
      '(1) the run is in the tree of the call that started it');
    await ws.processes.reapTree(job.pid);
    assert.equal(ws.processes.get(run.pid), undefined, '(1) and the reap of that tree takes it');
  } finally {
    close();
  }
}

console.log('ok - wasm-runner-process-identity (a child of its command, under its credential, on both hosts)');
