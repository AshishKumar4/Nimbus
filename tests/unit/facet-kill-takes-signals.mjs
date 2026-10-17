#!/usr/bin/env bun
// The hosted session's kill of a process whose program takes its own signals
// (SessionProcessSupervisor.takeSignals: git-runner@2's git), as `kill -INT
// <pid>` from another shell sends it (FacetManager.kill): a signal it catches
// is its program's, and nothing of the process is torn down, its input
// included; one it does not catch ends it as before.
import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { signalAbortReason } from '../../packages/core/src/substrate/lifo/shell/signals.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });

const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; } }));
const processes = new SessionProcessSupervisor();
const manager = new FacetManager(createFacetCtx(world, 'facet-kill-takes-signals'), { LOADER: world.loader, ASSETS: stagedAssets }, processes, new PortRegistry(), processHostFor, {});
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, processFiles(vfs));

const git = processes.spawn('git', ['git', 'commit'], '/home/user');
processes.openInput(git.pid);
processes.takeSignals(git.pid, ['SIGINT', 'SIGTERM']);
let ended = 0;
processes.subscribeTerminal(git.pid, () => { ended++; });

assert.equal(manager.kill(git.pid, 'INT', signalAbortReason('INT')), true, 'the kill is delivered');
assert.equal(processes.get(git.pid).state, 'running', 'the process runs on');
assert.equal(ended, 0, 'no end of it is told');
assert.equal(processes.hasInput(git.pid), true, 'its input is not torn down');
assert.deepEqual(processes.writeInput(git.pid, 'typed'), { ok: true }, 'and still takes what is typed');
assert.equal(await processes.nextSignal(git.pid, 100), 'SIGINT', 'its program takes the signal');

assert.equal(manager.kill(git.pid, 'USR1', signalAbortReason('USR1')), true);
assert.deepEqual([processes.get(git.pid).state, processes.get(git.pid).exitCode], ['killed', 138], 'one it does not catch ends it');
assert.equal(ended, 1);
console.log('facet-kill-takes-signals: ok');
