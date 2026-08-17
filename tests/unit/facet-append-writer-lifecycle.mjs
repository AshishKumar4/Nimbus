#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { setCtxExports, setSupervisorEntrypointName } from '../../packages/fabric/src/ctx-exports.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const bindings = [];
const stagedEntrypoints = [];
setSupervisorEntrypointName('SupervisorRPC');
setCtxExports({
  SupervisorRPC({ props }) {
    const binding = {
      props,
      disposed: false,
      [Symbol.dispose]() { this.disposed = true; },
    };
    bindings.push(binding);
    return binding;
  },
  NimbusLoadedEntrypoint({ props }) {
    const entrypoint = {
      props,
      disposed: false,
      async fetch() {
        return Response.json({ exitCode: 0, stdout: '', stderr: '' });
      },
      [Symbol.dispose]() { this.disposed = true; },
    };
    stagedEntrypoints.push(entrypoint);
    return entrypoint;
  },
});

const env = {
  LOADER: {
    get() {
      throw new Error('the one-shot lifecycle test must not use keyed LOADER.get');
    },
    load(config) {
      const worker = {
        disposed: false,
        getEntrypoint() {
          return {
            disposed: false,
            async fetch() {
              return Response.json({ exitCode: 0, stdout: '', stderr: '' });
            },
            [Symbol.dispose]() { this.disposed = true; },
          };
        },
        [Symbol.dispose]() { this.disposed = true; },
      };
      worker.supervisor = config.env?.SUPERVISOR;
      return worker;
    },
  },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(
        readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
        { status: 200 },
      );
    },
  },
};
const ctx = { id: { toString: () => 'writer-lifecycle-test' }, waitUntil() {} };
const processes = new SessionProcessSupervisor();
const manager = new FacetManager(ctx, env, processes, new PortRegistry(), processHostFor, {});
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(rawVfs);

const activated = [];
const activate = rawVfs.activateAppendWriter.bind(rawVfs);
rawVfs.activateAppendWriter = (pid, writerId) => {
  assert.equal(
    bindings.some((binding) => binding.props.writerId === writerId),
    false,
    'direct supervisor binding is not exposed before writer activation',
  );
  assert.equal(
    stagedEntrypoints.some((entrypoint) => entrypoint.props.supervisor.writerId === writerId),
    false,
    'staged entrypoint is not exposed before writer activation',
  );
  activate(pid, writerId);
  activated.push({ pid, writerId });
};

const retired = [];
const revoke = rawVfs.revokeAppendWriter.bind(rawVfs);
rawVfs.revokeAppendWriter = (pid, writerId) => {
  const direct = bindings.find((binding) => binding.props.writerId === writerId);
  const staged = stagedEntrypoints.find(
    (entrypoint) => entrypoint.props.supervisor.writerId === writerId,
  );
  assert.equal(
    direct?.disposed ?? staged?.disposed,
    true,
    'the concrete RPC capability is disposed before its authority identity is retired',
  );
  retired.push({ pid, writerId });
  revoke(pid, writerId);
};

await manager.exec('module.exports = 1', {
  filename: '<eval>',
  cwd: '/home/user',
  captureOutput: true,
});
assert.equal(retired.length, 1, 'unkeyed one-shot node execution retires its writer');
assert.equal(
  [...harness.sql.exec(
    `SELECT COUNT(*) AS count FROM vfs_append_writer_state
     WHERE pid = ? AND writer_id = ?`,
    retired[0].pid,
    retired[0].writerId,
  )][0].count,
  0,
  'retirement removes positive authority instead of retaining a tombstone',
);
assert.deepEqual(activated[0], retired[0]);

manager._stageOpencodeFacet = async () => {
  const entry = processes.spawn('opencode run', ['run'], '/home/user');
  return {
    pid: entry.pid,
    command: 'opencode run',
    stageSpec: {
      mode: 'oneshot',
      argv: ['run'],
      env: {},
      cwd: '/home/user',
      cred: entry.cred,
      stdin: '',
      vfsBundle: '{}',
      vfsManifest: '{}',
      vfsMetadata: '{}',
    },
  };
};
await manager.execStagedArtifact('ignored-by-test', {
  argv: ['run'],
  env: {},
  cwd: '/home/user',
});
assert.equal(retired.length, 2, 'keyed staged one-shot execution retires its writer');
assert.equal(stagedEntrypoints[0].props.supervisor.writerId, retired[1].writerId);
assert.deepEqual(activated[1], retired[1]);

console.log('facet-append-writer-lifecycle: all assertions passed');
