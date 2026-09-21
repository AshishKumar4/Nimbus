#!/usr/bin/env bun
// resident-finished-during-boot — a server-shaped program that exits on its
// own during its boot is a completed run, not a failed launch.
//
// `npx json-server --version` is classified long-running (its bin serves),
// so it boots as a resident. The bin prints the version and exits 0; the
// exit reaches the supervisor, which releases the facet and rejects the
// boot handshake with 'resident process released'. Before this, that
// rejection was reported as "long-running fork failed" and the shell got
// exit 1 for a command that had succeeded. The process table already holds
// the program's real exit code; that is what the caller reports.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { runFresh } from '../../packages/worker/src/runtime/node-runner.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

/** What the program does during its boot: nothing, exit(code), or die. */
let bootBehaviour = { kind: 'serve' };
let fm;
const world = createFacetWorld(() => ({
  async startProcess() {
    if (bootBehaviour.kind === 'exit') {
      // The facet's process reported its exit through the supervisor before
      // the boot handshake settled; the supervisor released the facet, and
      // the handshake rejects the way workerd's abort surfaces it.
      fm.noteProcessReportedExit(bootBehaviour.pid, bootBehaviour.code);
      throw new Error('Nimbus: resident process released');
    }
    if (bootBehaviour.kind === 'crash') throw new Error('boom during boot');
    return { ok: true };
  },
  async handleHttpRequest() { return Response.json({ ok: true }); },
}));
const env = {
  LOADER: world.loader,
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
    },
  },
};
const ctx = createFacetCtx(world, 'do-test');
const processes = new SessionProcessSupervisor();
const portRegistry = new PortRegistry();
const exits = [];
fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {
  onExternalExit: (pid, code, reason) => exits.push({ pid, code, reason }),
});
const disk = createSqliteVfsTestHarness();
const managerVfs = new SqliteVFS(disk.sql, disk.ctx);
fm.setVfs(managerVfs, new SqliteFilesystemAuthority(managerVfs));

const SERVER = 'const http = require("http"); http.createServer(() => {}).listen(3000);';
const opts = (extra = {}) => ({ argv: ['/home/user/cli/bin.js', '--version'], cwd: '/home/user/cli', filename: '/home/user/cli/bin.js', command: 'node bin.js --version', forceLongRunning: true, ...extra });

// ── 1. exits 0 during boot: the command's own exit code, no "started" notice ─
{
  const pidBefore = processes.stats.spawned ?? 0;
  bootBehaviour = { kind: 'exit', code: 0, pid: null };
  // The pid is allocated by runFresh; the world learns it through the table.
  const originalSpawn = processes.spawn.bind(processes);
  processes.spawn = (...args) => { const e = originalSpawn(...args); bootBehaviour.pid = e.pid; return e; };
  const result = await runFresh(fm, SERVER, opts());
  processes.spawn = originalSpawn;
  assert.equal(result.exitCode, 0, `exit 0 is the program's own code: ${JSON.stringify(result)}`);
  assert.equal(result.longRunning, false);
  assert.equal(result.stdout, '', 'no "[started (long-running)]" notice for a run that finished');
  assert.doesNotMatch(result.stderr, /fork failed/);
  assert.equal(processes.get(bootBehaviour.pid).state, 'exited');
  assert.equal(processes.get(bootBehaviour.pid).exitCode, 0);
  assert.equal(exits.some((e) => e.pid === bootBehaviour.pid && /boot failed/.test(e.reason)), false, 'no boot-failure exit is recorded on top of the real one');
  void pidBefore;
  console.log('  exit 0 during boot → exit 0, not a launch failure');
}

// ── 2. exits non-zero during boot: that code, still not a launch failure ────
{
  bootBehaviour = { kind: 'exit', code: 3, pid: null };
  const originalSpawn = processes.spawn.bind(processes);
  processes.spawn = (...args) => { const e = originalSpawn(...args); bootBehaviour.pid = e.pid; return e; };
  const result = await runFresh(fm, SERVER, opts());
  processes.spawn = originalSpawn;
  assert.equal(result.exitCode, 3);
  assert.equal(result.longRunning, false);
  assert.doesNotMatch(result.stderr, /fork failed/);
  console.log('  exit 3 during boot → exit 3');
}

// ── 3. a boot that genuinely fails is still a launch failure ────────────────
{
  bootBehaviour = { kind: 'crash' };
  const result = await runFresh(fm, SERVER, opts());
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /fork failed/);
  assert.ok(exits.some((e) => /boot failed: boom during boot/.test(e.reason)), JSON.stringify(exits));
  console.log('  a crash during boot → launch failure, exit 1');
}

// ── 4. a server that boots stays long-running ───────────────────────────────
{
  bootBehaviour = { kind: 'serve' };
  const result = await runFresh(fm, SERVER, opts({ argv: ['/home/user/cli/bin.js'], command: 'node bin.js' }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.longRunning, true);
  assert.match(result.stdout, /started \(long-running\)/);
  assert.equal(processes.get(result.spawnedPid).state, 'running');
  console.log('  a server that boots → long-running with the started notice');
}

console.log('resident-finished-during-boot: ok');
