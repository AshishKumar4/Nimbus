#!/usr/bin/env bun
// A child process's parent is the process whose envelope asked for it: the
// pid its binding stamped, never one the request names. Through the session's
// own supervisor dispatch and its _rpcCpSpawn, a cpSpawn envelope from process
// 7 whose request names another parent spawns 7's child. Red before: the
// session took parentPid from the request, so a guest that reached the op
// (SupervisorRPC's `_op`) spawned a child of another process, which inherited
// that process's stdin and identity.

import assert from 'node:assert/strict';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const { NimbusSession } = await importWorkerBundle({ 'packages/worker/src/session/nimbus-session.ts': ['NimbusSession'] });

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const processes = new SessionProcessSupervisor();
const caller = processes.spawn('node', ['caller.js'], '/home/user');
const other = processes.spawn('node', ['other.js'], '/home/user');

const spawned = [];
const session = Object.create(NimbusSession.prototype);
session._ensureChildProcessManager = () => ({ spawn: async (request) => { spawned.push(request); return { childPid: 99 }; } });
const dispatch = createSupervisorOpHandler({ vfs, processes, host: session });

const request = { command: 'echo', args: ['hi'], env: {}, cwd: '/home/user', stdio: ['pipe', 'pipe', 'pipe'] };
await dispatch({ op: 'cpSpawn', pid: caller.pid, run: 'run-1', args: [{ ...request, parentPid: other.pid }] });
assert.equal(spawned.at(-1).parentPid, caller.pid, "the child is the caller's, whatever parent its request names");
await dispatch({ op: 'cpSpawn', pid: caller.pid, run: 'run-1', args: [request] });
assert.equal(spawned.at(-1).parentPid, caller.pid, 'and a request that names none is the caller\'s too');

console.log('cp-spawn-parent-stamped: ok');
