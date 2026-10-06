#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';

const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-pure-builtin-permissions-'));

try {
  const build = await Bun.build({
    entrypoints: [
      './packages/worker/src/session/nimbus-session.ts',
      './packages/worker/src/session/supervisor-rpc.ts',
      './packages/worker/src/hosted/services.ts',
    ],
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        // cloudflare:sockets too: SupervisorRPC.connect loads it, and nothing here calls that.
        builder.onResolve({ filter: /^cloudflare:(workers|sockets)$/ }, () => ({
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
  const servicesEntry = build.outputs.find((output) => output.path.endsWith('/services.js'));
  assert.ok(servicesEntry, 'the shared runtime services entry was emitted');
  const { bindRuntimeServices } = await import(pathToFileURL(servicesEntry.path).href);

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
  rootVfs.mkdir('home', { mode: 0o755 });
  rootVfs.mkdir('home/user', { mode: 0o755 });
  rootVfs.chown('home/user', 1000, 1000);
  rootVfs.writeFile('home/user/shell-secret.txt', 'SHELL-SECRET\n', { mode: 0o000 });
  rootVfs.writeFile('home/user/private.sh', 'echo PRIVATE-SCRIPT\n', { mode: 0o600 });

  const registry = createDefaultRegistry();
  registerUnixCommands(registry, rawVfs);
  registry.register('node', async (ctx) => {
    try {
      ctx.stdout.write(await ctx.vfs.readFileString(ctx.args[0]));
      return 0;
    } catch (error) {
      ctx.stderr.write(`node: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  });

  const processes = new SessionProcessSupervisor();
  const userParent = processes.spawn('node', ['user.js'], '/home/user');
  const rootParent = processes.spawn('node', ['root.js'], '/root', { cred: CRED_KERNEL });

  const session = Object.create(NimbusSession.prototype);
  session.ctx = { facets: {} };
  session.env = {};
  Object.assign(session, bindRuntimeServices(session, {
    ctx: session.ctx,
    env: session.env,
    notify() {},
    async requestLaunchTurn() { return true; },
  }));
  session.sqliteFs = rawVfs;
  session.processes = processes;
  // ensureFacetManager short-circuits on this — the cp verbs under test
  // never reach a real composition. `facetManager` is a derived getter now;
  // the composed field is what a preset sets.
  session.facetManagerComposed = { manager: { setVfs() {} }, apps: {}, pumpLaunches: async () => {} };
  session.facetProcessManager = null;
  session.esbuildService = null;
  session._setCpRegistry(registry);
  const shellVfs = new ProcessFiles(rawVfs);
  const terminal = {
    write() {},
    writeln() {},
    onData() {},
    cols: 80,
    rows: 24,
    focus() {},
    clear() {},
  };
  session.shell = new Shell(
    terminal,
    shellVfs,
    registry,
    { HOME: '/home/user', PATH: '/bin:/usr/bin' },
    new ProcessRegistry(),
    {
      pid: userParent.pid,
      cred: processes.cred(userParent.pid),
      setUmask: (mask) => { processes.setUmask(userParent.pid, mask); },
    },
  );
  // A child's `sh` runs on a shell of its own, as NimbusWorkspace.shellFor builds one.
  session.runtimeWorkspace = {
    shellFor(pid, state) {
      const shell = new Shell(terminal, shellVfs, registry, { ...session.shell.getEnv(), ...state.env, $: String(pid) }, new ProcessRegistry(), {
        pid, get cred() { return processes.cred(pid); }, setUmask: (mask) => processes.setUmask(pid, mask),
      });
      shell.setCwd(state.cwd);
      return shell;
    },
  };

  let supervisorSpawnRequest;
  // supervisorOp is the session's own dispatch — the stub re-expresses the
  // same surface: the shared handler over the real fs + process table, with
  // cpSpawn recorded by the stub method.
  const sessionStub = {
    ensureSqliteFs() {},
    sqliteFs: rawVfs,
    processes,
    _rpcStdout() {},
    _rpcStderr() {},
    async _rpcCpSpawn(request) {
      supervisorSpawnRequest = request;
      return { childPid: 99 };
    },
  };
  attachSupervisorOps(sessionStub);
  // Routed the way a facet's binding routes: the entrypoint resolves the
  // session by the doId it was given, once per call.
  const sessionBinding = {
    NIMBUS_SESSION: { idFromName: (name) => name, idFromString: (id) => id, get: () => sessionStub },
  };
  const supervisor = Object.create(SupervisorRPC.prototype);
  supervisor.ctx = { props: { pid: userParent.pid, doId: 'session-do', writerId: 'builtin-run' } };
  supervisor.env = sessionBinding;
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
  identitylessSupervisor.ctx = { props: { pid: 0, doId: 'session-do' } };
  identitylessSupervisor.env = sessionBinding;
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

  const facetReadable = await spawnCommandAndCollect(userParent.pid, 'node', ['readable.txt']);
  assert.deepEqual(facetReadable, { exitCode: 0, stdout: 'PUBLIC\n', stderr: '' });

  const facetDenied = await spawnCommandAndCollect(userParent.pid, 'node', ['secret.txt']);
  assert.equal(facetDenied.exitCode, 1);
  assert.equal(facetDenied.stdout, '');
  assert.match(facetDenied.stderr, /EACCES|Permission denied/);

  const facetRoot = await spawnCommandAndCollect(rootParent.pid, 'node', ['secret.txt']);
  assert.deepEqual(facetRoot, { exitCode: 0, stdout: 'SECRET\n', stderr: '' });

  const scriptDenied = await spawnCommandAndCollect(userParent.pid, 'sh', ['private.sh'], '/home/user');
  assert.notEqual(scriptDenied.exitCode, 0);
  assert.equal(scriptDenied.stdout, '');
  assert.match(scriptDenied.stderr, /EACCES|Permission denied/);

  assert.deepEqual(
    await spawnCommandAndCollect(rootParent.pid, 'sh', ['private.sh'], '/home/user'),
    { exitCode: 0, stdout: 'PRIVATE-SCRIPT\n', stderr: '' },
  );

  const shellDenied = await spawnCommandAndCollect(userParent.pid, 'sh', ['-c', 'cat shell-secret.txt'], '/home/user');
  assert.equal(shellDenied.exitCode, 1);
  assert.equal(shellDenied.stdout, '');
  assert.match(shellDenied.stderr, /EACCES|Permission denied/);

  assert.deepEqual(
    await spawnCommandAndCollect(rootParent.pid, 'sh', ['-c', 'cat shell-secret.txt'], '/home/user'),
    { exitCode: 0, stdout: 'SHELL-SECRET\n', stderr: '' },
  );

  async function spawnAndCollect(parentPid, path, command = 'cat') {
    return spawnCommandAndCollect(parentPid, command, command === 'sudo' ? ['cat', path] : [path]);
  }

  async function spawnCommandAndCollect(parentPid, command, args, cwd = '/') {
    const { childPid } = await session._rpcCpSpawn({
      command,
      args,
      env: {},
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      parentPid,
    });
    await session._rpcCpStdinEnd(childPid);
    const waited = await session._rpcCpWait(childPid, 2_000);
    assert.equal(waited.done, true, `${command} ${args.join(' ')} completed`);
    // The child ring carries bytes; this test reads it as text.
    const output = await session._rpcCpDrainOutput(childPid);
    return {
      exitCode: waited.exitCode,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  }
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

console.log('session pure builtin permissions: ok');
