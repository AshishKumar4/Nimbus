#!/usr/bin/env bun
// The session's child_process broker, as the session composes it
// (hosted/services.ts), with children running at once. What has to hold:
//
//   (1) two `sh` children running at once, each with its own cwd and
//       environment, each see their own: a line that sleeps and then reads
//       $TAG and pwd reads its own, and the session shell's cwd and
//       variables are as they were. They used to share the session shell,
//       whose isolateShellState saves and restores rather than forks: each
//       read or restored the other's state.
//   (2) eleven `sh` children at once all run; the shared shell refused the
//       eleventh as recursion.
//   (3) killing a child runs the session's own kill of its pid (its socket
//       relay closed, its exit reported) before the broker stamps the exit,
//       and the terminal hears nothing of a child's end, which is its
//       parent's to report.
//   (4) a child killed before its program started never starts it.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { exitCodeForSignal } from '../../packages/core/src/substrate/lifo/shell/signals.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const decoder = new TextDecoder();

{
  const { NimbusSession, bindRuntimeServices } = await importWorkerBundle({
    'packages/worker/src/session/nimbus-session.ts': ['NimbusSession'],
    'packages/worker/src/hosted/services.ts': ['bindRuntimeServices'],
  });

  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const rootVfs = rawVfs.as(CRED_KERNEL);
  rootVfs.mkdir('etc', { mode: 0o755 });
  rootVfs.writeFile('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:User:/home/user:/bin/sh\n', { mode: 0o644 });
  rootVfs.writeFile('etc/group', 'root:x:0:\nuser:x:1000:user\n', { mode: 0o644 });
  for (const dir of ['home', 'home/user', 'home/user/a', 'home/user/b']) {
    rootVfs.mkdir(dir, { mode: 0o755 });
    rootVfs.chown(dir, 1000, 1000);
  }

  const registry = createDefaultRegistry();
  registerUnixCommands(registry, rawVfs);
  const launched = [];
  registry.register('node', async (ctx) => {
    launched.push(ctx.args.join(' '));
    ctx.stdout.write('node ran\n');
    return 0;
  });

  const processes = new SessionProcessSupervisor();
  const parent = processes.spawn('node', ['parent.js'], '/home/user');
  const terminalWrites = [];
  const terminal = {
    write(data) { terminalWrites.push(String(data)); },
    writeln(data) { terminalWrites.push(String(data)); },
    onData() {}, cols: 80, rows: 24, focus() {}, clear() {},
  };
  const session = Object.create(NimbusSession.prototype);
  session.ctx = { facets: {} };
  session.env = {};
  Object.assign(session, bindRuntimeServices(session, {
    ctx: session.ctx, env: session.env, notify() {}, async requestLaunchTurn() { return true; },
  }));
  session.sqliteFs = rawVfs;
  session.processes = processes;
  session.terminal = terminal;
  const closedRelays = [];
  session.webSocketRelay = { closeForPid(pid) { closedRelays.push(pid); } };
  // The session's own kill, as FacetManager.kill does it: the table, then
  // the exit report (whose cleanup closes the pid's relayed sockets).
  const sessionKills = [];
  const manager = {
    setVfs() {},
    kill(pid, signal) {
      sessionKills.push({ pid, signal, brokerStillRunning: session.facetProcessManager.isRunning(pid) });
      const code = exitCodeForSignal(signal);
      if (!processes.kill(pid, code)) return false;
      session._reportExternalExit(pid, code, `SIG${signal}`);
      return true;
    },
  };
  session.facetManagerComposed = { manager, apps: {}, pumpLaunches: async () => {} };
  session.facetProcessManager = null;
  session.esbuildService = null;
  session._setCpRegistry(registry);
  const shellVfs = new ProcessFiles(rawVfs);
  const sessionCred = processes.cred(parent.pid);
  const shellFor = (pid, state) => {
    const shell = new Shell(terminal, shellVfs, registry, { ...session.shell.getEnv(), ...state.env, $: String(pid) }, new ProcessRegistry(), {
      pid, get cred() { return processes.cred(pid); }, setUmask: (mask) => processes.setUmask(pid, mask),
    });
    shell.setCwd(state.cwd);
    return shell;
  };
  session.shell = new Shell(terminal, shellVfs, registry, { HOME: '/home/user', PATH: '/bin:/usr/bin' }, new ProcessRegistry(), {
    pid: parent.pid, cred: sessionCred, setUmask: (mask) => { processes.setUmask(parent.pid, mask); },
  });
  session.shell.setCwd('/home/user');
  // NimbusWorkspace.shellFor, over this harness's shell.
  session.runtimeWorkspace = { shellFor };

  const spawn = async (command, args, { env = {}, cwd = '/home/user' } = {}) => (await session._rpcCpSpawn({
    command, args, env, cwd, stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid,
  })).childPid;
  const collect = async (childPid) => {
    await session._rpcCpStdinEnd(childPid);
    const waited = await session._rpcCpWait(childPid, 5_000);
    assert.equal(waited.done, true, `child ${childPid} completed`);
    const output = await session._rpcCpDrainOutput(childPid);
    return { exitCode: waited.exitCode, signal: waited.signal, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
  };

  // ── (1) two sh children at once: each its own cwd and environment ────────
  {
    const a = await spawn('sh', ['-c', 'sleep 0.05; echo "$TAG"; pwd'], { env: { TAG: 'A' }, cwd: '/home/user/a' });
    const b = await spawn('sh', ['-c', 'sleep 0.2; echo "$TAG"; pwd'], { env: { TAG: 'B' }, cwd: '/home/user/b' });
    const [ra, rb] = await Promise.all([collect(a), collect(b)]);
    assert.deepEqual(ra, { exitCode: 0, signal: null, stdout: 'A\n/home/user/a\n', stderr: '' }, 'A reads its own TAG and cwd');
    assert.deepEqual(rb, { exitCode: 0, signal: null, stdout: 'B\n/home/user/b\n', stderr: '' }, 'B reads its own TAG and cwd');
    assert.equal(session.shell.getCwd(), '/home/user', "the session shell's cwd is as it was");
    assert.equal(session.shell.getEnv().TAG, undefined, "and its variables too");
  }

  // ── (2) eleven at once: all run ─────────────────────────────────────────
  {
    const pids = [];
    for (let n = 0; n < 11; n++) pids.push(await spawn('sh', ['-c', `sleep 0.1; echo ${n}`]));
    const results = await Promise.all(pids.map(collect));
    assert.deepEqual(results.map((r) => [r.exitCode, r.stdout, r.stderr]), pids.map((_, n) => [0, `${n}\n`, '']),
      'eleven sh children at once all run, none refused as recursion');
  }

  // ── (3) a kill: the session's kill first, then the broker's exit ────────
  {
    const child = await spawn('sh', ['-c', 'sleep 5']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminalWrites.length = 0;
    assert.equal(await session._rpcCpKill(child, 'SIGTERM'), true);
    assert.deepEqual(sessionKills, [{ pid: child, signal: 'TERM', brokerStillRunning: true }],
      "the session's own kill of the pid runs, before the broker stamps the exit");
    assert.deepEqual(closedRelays, [child], "its relayed sockets are closed with it (the exit report's cleanup)");
    assert.deepEqual((await session._rpcCpWait(child, 1_000)), { done: true, exitCode: null, signal: 'SIGTERM' });
    assert.deepEqual(terminalWrites, [], "the terminal hears nothing of a child's end");
  }

  // ── (4) killed before its program starts: never starts it ───────────────
  {
    launched.length = 0;
    const child = await spawn('node', ['late.js']);
    // The broker dispatches on its next turn; the kill lands first.
    assert.equal(await session._rpcCpKill(child, 'SIGKILL'), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(launched, [], 'its program never ran');
    assert.deepEqual(await session._rpcCpWait(child, 1_000), { done: true, exitCode: null, signal: 'SIGKILL' });
  }
}

console.log('ok - cp-broker-session (sh children each with their own shell, eleven at once, the full kill path, no launch after a kill)');
