#!/usr/bin/env bun
// An npm bin starts its process as `node <target>` does: the bin wrapper
// reserves no pid of its own. The runtime gets the calling command's context
// untouched (its pid and credential, which the program's process inherits,
// its fds, a launcher's reservation), the bin's target and arguments, and
// the bin's launch: how it is shown and the hints that start it resident.

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
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const project = 'home/user/project';
const nodeModules = `${project}/node_modules`;
const entries = ['credential-probe', 'vite'].map((name) => ({
  name,
  packageName: name,
  packageVersion: '1.0.0',
  packagePath: `${nodeModules}/${name}`,
  targetPath: `${nodeModules}/${name}/cli.js`,
}));

vfs.mkdir(`${nodeModules}/.bin`, { recursive: true });
for (const entry of entries) {
  vfs.mkdir(entry.packagePath, { recursive: true });
  vfs.writeFile(`${entry.packagePath}/package.json`, JSON.stringify({ name: entry.name, version: '1.0.0' }));
  vfs.writeFile(`${nodeModules}/.bin/${entry.name}`, createNpmBinShim(entry, `${nodeModules}/.bin`));
  vfs.writeFile(entry.targetPath, 'console.log("ok")\n');
}
vfs.writeFile(npmBinManifestPath(nodeModules), JSON.stringify(createNpmBinManifest(entries)));

const commands = new Map();
const registry = {
  register(name, handler) { commands.set(name, handler); },
  resolve(name) { return commands.get(name); },
};
let received = null;
registry.register('node', async (ctx) => { received = ctx; return 3; });

const processes = new SessionProcessSupervisor();
const files = new ProcessFiles(rawVfs);
const learned = new Set();
installNpmBinFallbackResolver(registry, {
  filesystem: files,
  getCwd: () => `/${project}`,
  getFacetManager() { throw new Error('unexpected staged artifact'); },
  async learnedServer(server) { return learned.has(`${server.package} ${server.bin} ${server.arg0}`); },
  notifyTerminalEvent() { throw new Error('the bin wrapper reports no process lifecycle of its own'); },
  async runtimeCommandHint() { return null; },
  emitShellExecDone() { throw new Error('the bin wrapper reports no process lifecycle of its own'); },
});

const userParent = processes.spawn('sh', ['sh'], `/${project}`);
const rootParent = processes.spawn('sudo sh', ['sh'], `/${project}`, { cred: CRED_KERNEL });

async function invoke(name, parent, args = [], extra = {}) {
  const handler = await registry.resolve(name);
  assert.equal(typeof handler, 'function');
  const before = processes.getAll().length;
  const ctx = {
    pid: parent.pid,
    cred: processes.cred(parent.pid),
    vfs: files.view({ pid: parent.pid, cred: processes.cred(parent.pid) }),
    args, cwd: `/${project}`, env: {},
    stdout: { write() {} },
    stderr: { write() {} },
    ...extra,
  };
  received = null;
  assert.equal(await handler(ctx), 3, "the bin's status is its program's");
  assert.equal(processes.getAll().length, before, 'the bin wrapper starts no process of its own');
  assert.equal(received.pid, parent.pid);
  assert.equal(received.cred, ctx.cred);
  assert.equal(received.stdout, ctx.stdout);
  assert.equal(received.stderr, ctx.stderr);
  return received;
}

{
  const ctx = await invoke('credential-probe', userParent, ['--flag', 'x']);
  assert.deepEqual(ctx.args, [`/${entries[0].targetPath}`, '--flag', 'x']);
  assert.equal(ctx.__nimbusBinSpawn, undefined, 'no reservation is made for an ordinary bin');
  assert.deepEqual(ctx.__nimbusBin, {
    command: 'credential-probe --flag x',
    attachedTty: false,
    serves: false,
    server: { package: 'credential-probe@1.0.0', bin: 'credential-probe', arg0: 'x' },
  });
  assert.equal((await invoke('credential-probe', rootParent)).cred.uid, 0, "the program's process takes its caller's credential");
}

// The hints: a known server CLI serving, not asked to build; one the workspace learned.
assert.equal((await invoke('vite', userParent, ['--port', '5173'])).__nimbusBin.serves, true);
assert.equal((await invoke('vite', userParent, ['build'])).__nimbusBin.serves, false);
learned.add('credential-probe@1.0.0 credential-probe serve');
assert.equal((await invoke('credential-probe', userParent, ['serve'])).__nimbusBin.serves, true);

// A launcher's reservation (a child_process child's pid and its fd0) reaches the runtime untouched.
{
  const child = processes.spawn('credential-probe', ['credential-probe'], `/${project}`, { parentPid: userParent.pid });
  processes.openInput(child.pid);
  const reservation = { callerPid: child.pid, command: 'credential-probe', liveInput: true };
  const ctx = await invoke('credential-probe', child, [], { __nimbusBinSpawn: reservation });
  assert.equal(ctx.__nimbusBinSpawn, reservation);
}

console.log('npm bin launch: the runtime starts the process with the caller\'s context and the bin\'s launch');
