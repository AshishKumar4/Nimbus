#!/usr/bin/env bun
// A resident launched in the foreground behaves like a foreground process
// until its boot settles: what it prints goes to the command that launched
// it, and an interrupt ends the process, not just the wait.
//
// A Ruby script is resident, and its boot waits for it to bind or exit. One
// that does neither (a worker loop, a file watcher) used to hold the shell
// with no output and no way out.

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

// The program never binds and never exits: its boot does not settle.
const booting = [];
const evaluate = () => ({
  startProcess() { return new Promise((resolve) => { booting.push(resolve); }); },
  async handleHttpRequest() { return new Response('unreachable', { status: 500 }); },
});

function instance() {
  const world = createFacetWorld(evaluate);
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(PID_GEN_STRIDE);
  const disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const manager = new FacetManager(createFacetCtx(world, 'foreground', new Map()), { LOADER: world.loader }, processes, new PortRegistry(), processHostFor, {});
  manager.setVfs(vfs, new SqliteFilesystemAuthority(vfs));
  return { processes, manager };
}

const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)),
]);

{
  const { processes, manager } = instance();
  const controller = new AbortController();
  const written = [];
  let pid = 0;
  const launch = manager.spawnWorker('export default {}', 'ruby worker.rb', '/home/user', {
    resident: { runtime: 'ruby', argv: ['ruby', 'worker.rb'] },
    foreground: { signal: controller.signal, write: (stream, text) => { written.push([stream, text]); } },
  });
  launch.catch(() => {});
  while (booting.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  pid = processes.getAll().find((entry) => entry.command === 'ruby worker.rb').pid;

  // What the process prints reaches the supervisor as it always does.
  processes.appendOutput(pid, 'stdout', 'tick 1\n');
  processes.appendOutput(pid, 'stderr', 'warn\n');
  assert.deepEqual(written, [['stdout', 'tick 1\n'], ['stderr', 'warn\n']], 'output reaches the launching command while the boot waits');
  assert.equal(processes.get(pid).foreground, true, 'and the shell mirror leaves it to that command');

  controller.abort();
  await assert.rejects(within(launch, 2000, 'the interrupted launch'), (error) => error.name === 'AbortError', 'the launch ends on interrupt');
  assert.equal(processes.get(pid).state, 'killed', 'and the process with it');
  assert.notEqual(processes.get(pid).foreground, true);
}

console.log('resident-foreground-launch: ok');
