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
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
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
vfs.writeFile(`${nodeModules}/.bin/${entry.name}`, createNpmBinShim(entry, `${nodeModules}/.bin`));
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
const files = new ProcessFiles(rawVfs);
installNpmBinFallbackResolver(registry, {
  filesystem: files,
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
    cred: processes.cred(pid),
    vfs: files.view({ pid, cred: processes.cred(pid) }),
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

// A reserved bin pid's foreground output has already been logged by the
// runtime. Re-appending from its launching fd feeds that same subscriber
// again; a text-only wrapper also corrupts binary output.
const raw = new Uint8Array([255, 254, 0, 128, 195, 40]);
let deliveries = 0, runtimePid;
const entered = Promise.withResolvers(), room = Promise.withResolvers();
registry.register('node', async (ctx) => {
  runtimePid = ctx.__nimbusBinSpawn.callerPid;
  const unsubscribe = processes.subscribeOutputBytes(runtimePid, (chunk) => {
    deliveries++;
    // Bound the old feedback loop so the red test fails without a stack
    // overflow or a timing-dependent runaway output buffer.
    if (deliveries > 2) return;
    return ctx.stdout.writeBytes
      ? ctx.stdout.writeBytes(chunk.data)
      : ctx.stdout.write(new TextDecoder().decode(chunk.data));
  });
  try {
    await processes.appendOutputBytes(runtimePid, 'stdout', raw);
    return 0;
  } finally { unsubscribe(); }
});
const received = [];
let finished = false;
const running = handler({
  pid: userParent.pid, cred: userParent.cred,
  vfs: files.view({ pid: userParent.pid, cred: userParent.cred }),
  args: [], cwd: `/${project}`, env: {},
  stdout: {
    write(text) { received.push(new TextEncoder().encode(text)); entered.resolve(); },
    async writeBytes(bytes) { received.push(bytes.slice()); entered.resolve(); await room.promise; },
  },
  stderr: { write() {} },
}).then((code) => { finished = true; return code; });
await entered.promise;
try {
  assert.equal(deliveries, 1, 'a foreground bin write is logged once, without feeding itself back');
  assert.deepEqual(received, [raw], 'the bin fd preserves every byte');
  for (let i = 0; i < 8; i++) await null;
  assert.equal(finished, false, 'the runtime waits for room on the bin launching fd');
} finally { room.resolve(); }
assert.equal(await running, 0);
assert.equal(processes.readLogs(runtimePid).chunks.length, 1, 'the bin log renders the output once');

const child = processes.spawn(entry.name, [entry.name], `/${project}`, { parentPid: userParent.pid });
processes.openInput(child.pid);
const countBefore = processes.getAll().length;
let binSpawn;
registry.register('node', async (ctx) => { binSpawn = ctx.__nimbusBinSpawn; return 0; });
assert.equal(await handler({
  pid: child.pid, cred: child.cred,
  vfs: files.view({ pid: child.pid, cred: child.cred }),
  args: [], cwd: `/${project}`, env: {},
  stdout: { write() {} }, stderr: { write() {} },
  __nimbusBinSpawn: { callerPid: child.pid, command: entry.name, liveInput: true },
}), 0);
assert.equal(processes.getAll().length, countBefore, 'a broker-owned bin reuses the existing child pid');
assert.equal(binSpawn.callerPid, child.pid);
assert.equal(binSpawn.liveInput, true, 'the bin runtime reads the broker child shared fd0 channel');

console.log('npm bin process credentials and byte-exact foreground relay: ok');
