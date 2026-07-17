#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { createDefaultRegistry } from '../../packages/worker/src/substrate/lifo/commands/registry.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-pure-builtin-permissions-'));

try {
  const build = await Bun.build({
    entrypoints: [
      './packages/worker/src/session/nimbus-session.ts',
      './packages/worker/src/session/supervisor-rpc.ts',
    ],
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: 'cloudflare-workers',
          namespace: 'test',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));

  const entry = build.outputs.find((output) => output.path.endsWith('/nimbus-session.js'));
  assert.ok(entry, 'the session entry bundle was emitted');
  const { NimbusSession } = await import(pathToFileURL(entry.path).href);
  const rpcEntry = build.outputs.find((output) => output.path.endsWith('/supervisor-rpc.js'));
  assert.ok(rpcEntry, 'the supervisor RPC entry bundle was emitted');
  const { SupervisorRPC } = await import(pathToFileURL(rpcEntry.path).href);

  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const rootVfs = rawVfs.as(CRED_KERNEL);
  rootVfs.mkdir('etc', { mode: 0o755 });
  rootVfs.writeFile(
    'etc/passwd',
    'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:User:/home/user:/bin/sh\n',
    { mode: 0o644 },
  );
  rootVfs.writeFile('etc/group', 'root:x:0:\nuser:x:1000:user\n', { mode: 0o644 });
  rootVfs.writeFile('readable.txt', 'PUBLIC\n', { mode: 0o644 });
  rootVfs.writeFile('secret.txt', 'SECRET\n', { mode: 0o000 });

  const registry = createDefaultRegistry();
  registerUnixCommands(registry, rawVfs);

  const processes = new SessionProcessSupervisor();
  const userParent = processes.spawn('node', ['user.js'], '/home/user');
  const rootParent = processes.spawn('node', ['root.js'], '/root', { cred: CRED_KERNEL });

  const session = Object.create(NimbusSession.prototype);
  session.ctx = { facets: {} };
  session.env = {};
  session.sqliteFs = rawVfs;
  session.processes = processes;
  session.facetManager = { setVfs() {} };
  session.facetProcessManager = null;
  session.esbuildService = null;
  session._setCpRegistry(registry);

  let supervisorSpawnRequest;
  const supervisor = Object.create(SupervisorRPC.prototype);
  supervisor.ctx = { props: { pid: userParent.pid } };
  supervisor._stubCache = {
    async _rpcCpSpawn(request) {
      supervisorSpawnRequest = request;
      return { childPid: 99 };
    },
  };
  assert.deepEqual(
    await supervisor.cpSpawn({
      command: 'cat',
      args: ['readable.txt'],
      env: {},
      cwd: '/',
      stdio: ['pipe', 'pipe', 'pipe'],
      parentPid: rootParent.pid,
    }),
    { childPid: 99 },
  );
  assert.equal(
    supervisorSpawnRequest.parentPid,
    userParent.pid,
    'facet input cannot replace the supervisor-bound invoking pid',
  );
  const identitylessSupervisor = Object.create(SupervisorRPC.prototype);
  identitylessSupervisor.ctx = { props: { pid: 0 } };
  identitylessSupervisor._stubCache = supervisor._stubCache;
  await assert.rejects(
    identitylessSupervisor.cpSpawn({
      command: 'cat', args: ['readable.txt'], env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'],
    }),
    /missing or invalid process pid/,
    'cpSpawn cannot infer a default credential from pid zero',
  );

  const readable = await spawnAndCollect(userParent.pid, 'readable.txt');
  assert.equal(readable.exitCode, 0);
  assert.equal(readable.stdout, 'PUBLIC\n');
  assert.equal(readable.stderr, '');

  const denied = await spawnAndCollect(userParent.pid, 'secret.txt');
  assert.equal(denied.exitCode, 1);
  assert.match(denied.stderr, /EACCES|Permission denied/);
  assert.doesNotMatch(denied.stderr, /TypeError|undefined is not an object/);

  const elevated = await spawnAndCollect(userParent.pid, 'secret.txt', 'sudo');
  assert.equal(elevated.exitCode, 0, elevated.stderr);
  assert.equal(elevated.stdout, 'SECRET\n');
  assert.equal(elevated.stderr, '');

  const inlineUser = processes.spawn('cat', ['readable.txt'], '/', { parentPid: userParent.pid });
  const inlineReadable = await session._rpcCpDispatchInline({
    command: 'cat',
    args: ['readable.txt'],
    env: {},
    cwd: '/',
    stdio: ['pipe', 'pipe', 'pipe'],
    parentPid: userParent.pid,
    processPid: inlineUser.pid,
  }, 'pure-builtin');
  assert.deepEqual(inlineReadable, { exitCode: 0, stdout: 'PUBLIC\n', stderr: '' });

  const inlineDenied = await session._rpcCpDispatchInline({
    command: 'cat',
    args: ['secret.txt'],
    env: {},
    cwd: '/',
    stdio: ['pipe', 'pipe', 'pipe'],
    parentPid: userParent.pid,
    processPid: inlineUser.pid,
  }, 'pure-builtin');
  assert.equal(inlineDenied.exitCode, 1);
  assert.match(inlineDenied.stderr, /EACCES|Permission denied/);
  assert.doesNotMatch(inlineDenied.stderr, /TypeError|undefined is not an object/);

  const missingInlineIdentity = await session._rpcCpDispatchInline({
    command: 'cat',
    args: ['readable.txt'],
    env: {},
    cwd: '/',
    stdio: ['pipe', 'pipe', 'pipe'],
    parentPid: userParent.pid,
  }, 'pure-builtin');
  assert.equal(missingInlineIdentity.exitCode, 1);
  assert.match(missingInlineIdentity.stderr, /broker-assigned process pid/);

  const inlineRoot = processes.spawn('cat', ['secret.txt'], '/', { parentPid: rootParent.pid });
  const inlineElevated = await session._rpcCpDispatchInline({
    command: 'cat',
    args: ['secret.txt'],
    env: {},
    cwd: '/',
    stdio: ['pipe', 'pipe', 'pipe'],
    parentPid: rootParent.pid,
    processPid: inlineRoot.pid,
  }, 'pure-builtin');
  assert.deepEqual(inlineElevated, { exitCode: 0, stdout: 'SECRET\n', stderr: '' });

  async function spawnAndCollect(parentPid, path, command = 'cat') {
    const { childPid } = await session._rpcCpSpawn({
      command,
      args: command === 'sudo' ? ['cat', path] : [path],
      env: {},
      cwd: '/',
      stdio: ['pipe', 'pipe', 'pipe'],
      parentPid,
    });
    await session._rpcCpStdinEnd(childPid);
    const waited = await session._rpcCpWait(childPid, 2_000);
    assert.equal(waited.done, true, `cat ${path} completed`);
    const output = await session._rpcCpDrainOutput(childPid);
    return {
      exitCode: waited.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  }
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

console.log('session pure builtin permissions: ok');
