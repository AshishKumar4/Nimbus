#!/usr/bin/env bun
// The workspace's runtime surface, end to end through the shell: on-demand
// packages install on first use through the same single path `nimbus
// install` uses, a bin the runner table cannot bind is refused before a
// byte lands, a remote source's alias resolves as a lazy command, and a
// command the host already registered is never shadowed by a stub.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';

const encoder = new TextEncoder();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fakePackage(contents, { name = 'toy', version = '1.0.0', runner = 'toy-runner', bins = ['toy'] } = {}) {
  const files = Object.entries(contents).map(([path, text], i) => {
    const bytes = encoder.encode(text);
    return {
      path,
      content: `blobs/${name}-${version}/${sha256(bytes)}/file-${i}`,
      sha256: sha256(bytes),
      size: bytes.length,
      ...(path.startsWith('bin/') ? { mode: 'exec' } : {}),
    };
  });
  const blobs = new Map(files.map((file, i) => [file.content, encoder.encode(Object.values(contents)[i])]));
  return {
    manifest: {
      name, version, license: 'MIT',
      wasi_namespace: 'wasi_snapshot_preview1',
      files,
      entrypoints: bins.map((binName) => ({ binName, runner, args: [] })),
    },
    readBlob: (file) => blobs.get(file.content),
  };
}

const openWorkspace = (options = {}) => {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  return NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, ...options });
};

// ── On-demand: nothing lands before first use; first use installs and runs ─
{
  const ws = await openWorkspace({
    runtimeInstall: 'on-demand',
    runtimes: [fakePackage({ 'bin/toy': '# t\n' })],
  });
  const fs = ws.vfs.as(CRED_KERNEL);

  assert.ok(!fs.exists('home/user/.nimbus'), 'on-demand create wrote the runtime payload');

  // The runner is registered after create — a host compositor binds runners
  // the workspace itself never had — and the stub still reaches it, because
  // the runner check happens at install time, not at stub registration.
  ws.runtimes.registerRunner('toy-runner', (_m, _r, binName) => async (ctx) => {
    ctx.stdout.write(`ran ${binName}\n`);
    return 0;
  });
  const ran = await ws.exec('toy');
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.equal(ran.stdout, 'ran toy\n');
  assert.ok(fs.exists('home/user/.nimbus/runtimes/toy/1.0.0/manifest.json'),
    'first use installed through the manager');

  // Second use dispatches the real handler the install registered — the stub
  // re-resolved its own name, it did not stay bound to itself.
  const again = await ws.exec('toy');
  assert.equal(again.stdout, 'ran toy\n');
}

// ── A bin the runner table cannot bind is refused before any write ────────
{
  const ws = await openWorkspace({
    runtimeInstall: 'on-demand',
    runtimes: [fakePackage({ 'bin/toy': '# t\n' })],
  });
  const fs = ws.vfs.as(CRED_KERNEL);

  const missing = await ws.exec('toy');
  assert.equal(missing.exitCode, 127);
  assert.match(missing.stderr, /toy-runner.*not registered|runner.*not registered/);
  assert.ok(!fs.exists('home/user/.nimbus'), 'a refused install still wrote payload');

  const listed = await ws.exec('nimbus install --list');
  assert.match(listed.stdout + listed.stderr, /no runtimes installed/i);
}

// ── A remote source's alias resolves as a lazy command ────────────────────
{
  const remote = fakePackage({ 'bin/remote-tool': '# r\n' }, {
    name: 'remote', version: '2.0.0', runner: 'remote-runner', bins: ['remote-tool'],
  });
  const ws = await openWorkspace({
    runtimeInstall: 'on-demand',
    runtimeSource: {
      list: async () => [],
      resolve: async (spec) => spec === 'remote-tool' ? remote : null,
    },
  });
  ws.runtimes.registerRunner('remote-runner', () => async (ctx) => {
    ctx.stdout.write('remote ran\n');
    return 0;
  });

  const ran = await ws.exec('remote-tool');
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.equal(ran.stdout, 'remote ran\n');
}

// ── A preexisting host command is never shadowed by a stub ────────────────
{
  const ws = await openWorkspace({
    runtimeInstall: 'on-demand',
    runtimes: [fakePackage({ 'bin/echo': '# t\n' }, { bins: ['echo'] })],
  });
  const fs = ws.vfs.as(CRED_KERNEL);
  const ran = await ws.exec('echo kept');
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.equal(ran.stdout, 'kept\n');
  assert.ok(!fs.exists('home/user/.nimbus'), 'the stub shadowed a real command');
}

// ── Host-supplied supervisor: the workspace never spawns its own ──────────
{
  const processes = new SessionProcessSupervisor();
  const spawn = processes.spawn.bind(processes);
  let spawned = 0;
  processes.spawn = (...args) => { spawned++; return spawn(...args); };

  const ws = await openWorkspace({
    processes,
    identity: { pid: 4242 },
  });
  assert.equal(ws.shellProcessPid, 4242);
  assert.equal(ws.processes, processes);
  assert.equal(spawned, 0, 'a supplied identity still spawned a shell process');

  const own = await openWorkspace({});
  assert.notEqual(own.shellProcessPid, undefined);
  assert.ok(own.processes.get(own.shellProcessPid) !== undefined,
    'the workspace\'s own shell is not in its process table');
}

// ── The shell's identity is the process table: sudo and umask both mean it ─
{
  const ws = await openWorkspace({});
  const whoami = await ws.exec('sudo whoami');
  assert.equal(whoami.exitCode, 0, whoami.stderr);
  assert.equal(whoami.stdout.trim(), 'root');

  // setUmask lands on the shell's own process-table entry — a second exec
  // (fresh snapshot) reads it back, and the table itself shows the write.
  const set = await ws.exec('umask 027');
  assert.equal(set.exitCode, 0, set.stderr);
  assert.equal(ws.processes.cred(ws.shellProcessPid).umask, 0o027);
  const umask = await ws.exec('umask');
  assert.equal(umask.stdout, '0027\n');
}

console.log('nimbus-workspace-runtimes: all assertions passed');
