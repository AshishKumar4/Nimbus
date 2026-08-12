#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { installNpmBinFallbackResolver } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';
import {
  createNpmBinManifest,
  createNpmBinShim,
  npmBinManifestPath,
} from '../../packages/worker/src/npm/bin-links.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const project = 'home/user/project';
const nodeModules = `${project}/node_modules`;
const entry = {
  name: 'credential-probe',
  packageName: 'credential-probe',
  packageVersion: '1.0.0',
  packagePath: `${nodeModules}/credential-probe`,
  targetPath: `${nodeModules}/credential-probe/cli.js`,
};

vfs.mkdir(`${nodeModules}/.bin`, { recursive: true });
vfs.mkdir(entry.packagePath, { recursive: true });
vfs.writeFile(`${nodeModules}/.bin/${entry.name}`, createNpmBinShim(entry));
vfs.writeFile(npmBinManifestPath(nodeModules), JSON.stringify(createNpmBinManifest([entry])));
vfs.writeFile(entry.targetPath, 'console.log("ok")\n');

const commands = new Map();
const registry = {
  register(name, handler) {
    commands.set(name, handler);
  },
  resolve(name) {
    return commands.get(name);
  },
};
registry.register('node', async () => 0);

const processes = new SessionProcessSupervisor();
installNpmBinFallbackResolver(registry, {
  vfs,
  getCwd: () => `/${project}`,
  processes,
  getFacetManager() {
    throw new Error('unexpected staged artifact');
  },
  notifyTerminalEvent() {},
  async runtimeCommandHint() {
    return null;
  },
  emitShellExecDone() {},
});

const userParent = processes.spawn('sh', ['sh'], `/${project}`);
const rootParent = processes.spawn('sudo sh', ['sh'], `/${project}`, { cred: CRED_KERNEL });
const handler = await registry.resolve(entry.name);
assert.equal(typeof handler, 'function');

async function invoke(pid) {
  const before = new Set(processes.getAll().map((process) => process.pid));
  const exitCode = await handler({
    pid,
    args: [],
    cwd: `/${project}`,
    env: {},
    stdout: { write() {} },
    stderr: { write() {} },
  });
  assert.equal(exitCode, 0);
  const spawned = processes.getAll().filter((process) => !before.has(process.pid));
  assert.equal(spawned.length, 1);
  return spawned[0];
}

const userRuntime = await invoke(userParent.pid);
assert.equal(userRuntime.cred.uid, 1000);
assert.equal(userRuntime.cred.gid, 1000);

const rootRuntime = await invoke(rootParent.pid);
assert.equal(rootRuntime.cred.uid, 0);
assert.equal(rootRuntime.cred.gid, 0);

console.log('npm bin process credentials: ok');
