#!/usr/bin/env bun
// RuntimeManager is the workspace's one installer: a RuntimeSource decides
// where bytes come from, the runner table is per-instance, and installs
// singleflight on the canonical home/name/version key. These assertions pin
// the behaviors the brief calls out: alias installs share one payload pass,
// failures are forgotten, an interrupted manifest-first tree is repaired
// rather than trusted, an explicit install refuses a runner it cannot bind,
// and uninstall leaves reinstall able to write again.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { RuntimeManager } from '../../packages/core/src/runtime/runtime-manager.ts';
import { ExecutionFs } from '../../packages/core/src/shell/execution-fs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { suppliedRuntimeSource } from '../../packages/core/src/runtime/runtime-package.ts';

const KERNEL = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
const HOME = '/home/user';
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
    blobs,
  };
}

const openVfs = () => {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  return new SqliteVFS(harness.sql, harness.ctx);
};

const makeRegistry = () => {
  const commands = new Map();
  return {
    commands,
    register: (name, command) => commands.set(name, command),
    unregister: (name) => commands.delete(name),
    has: (name) => commands.has(name),
    resolve: async (name) => commands.get(name),
  };
};

const makeManager = (vfs, source) => {
  const registry = makeRegistry();
  const manager = new RuntimeManager({
    vfs: new ExecutionFs(new SqliteFilesystemAuthority(vfs).openHost(KERNEL).fs),
    registry,
    getHome: () => HOME,
    source,
  });
  return { manager, registry };
};

const toyRunner = () => async () => 0;

// ── A spec resolves to one install, whatever name reaches it ─────────────
{
  const vfs = openVfs();
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  const { manager, registry } = makeManager(vfs, suppliedRuntimeSource([pkg]));
  manager.registerRunner('toy-runner', toyRunner);

  const seeded = await manager.install('toy');
  assert.equal(seeded.written, true);
  assert.deepEqual(seeded.bins, ['toy']);
  assert.ok(registry.commands.has('toy'));

  const again = await manager.install('toy');
  assert.equal(again.written, false, 'a complete install was rewritten');

  await assert.rejects(() => manager.install('nope'), /'nope' is not in catalog/);
}

// ── Concurrent alias + explicit installs share one payload pass ───────────
{
  const vfs = openVfs();
  const pkg = fakePackage(
    { 'bin/toy': '# t\n', 'bin/toy-alias': '# a\n', 'share/toy/x.txt': 'x\n' },
    { bins: ['toy', 'toy-alias'] },
  );
  let blobReads = 0;
  const counting = {
    manifest: pkg.manifest,
    readBlob: (file) => { blobReads++; return pkg.readBlob(file); },
  };
  const { manager } = makeManager(vfs, suppliedRuntimeSource([counting]));
  manager.registerRunner('toy-runner', toyRunner);

  // 'toy-alias' resolves by bin name to the same canonical key as 'toy'.
  const [a, b] = await Promise.all([manager.install('toy'), manager.install('toy-alias')]);
  assert.equal(blobReads, pkg.manifest.files.length,
    `concurrent installs read the payload ${blobReads} times, not ${pkg.manifest.files.length}`);
  assert.deepEqual(a.bins.sort(), b.bins.sort());
}

// ── A failed digest is forgotten; the retry installs ─────────────────────
{
  const vfs = openVfs();
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  let calls = 0;
  const flaky = {
    manifest: pkg.manifest,
    readBlob: (file) => {
      calls++;
      return calls === 1 ? new Uint8Array([0]) : pkg.readBlob(file);
    },
  };
  const { manager } = makeManager(vfs, suppliedRuntimeSource([flaky]));
  manager.registerRunner('toy-runner', toyRunner);

  await assert.rejects(() => manager.install('toy'), /sha256 mismatch/);
  assert.equal((await manager.list()).length, 0, 'a failed install lists as installed');
  const ok = await manager.install('toy');
  assert.equal(ok.written, true, 'the retry hit a memo instead of writing');
}

// ── An interrupted manifest-first tree is repaired, not trusted ───────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'bin/toy': '# t\n', 'share/toy/x.txt': 'payload\n' });
  const root = 'home/user/.nimbus/runtimes/toy/1.0.0';
  // The legacy R2 installer wrote manifest.json first: a crash here used to
  // report "already installed" over a payload that never arrived.
  fs.mkdir(root, { recursive: true });
  fs.writeFile(`${root}/manifest.json`, JSON.stringify(pkg.manifest, null, 2));

  const { manager } = makeManager(vfs, suppliedRuntimeSource([pkg]));
  manager.registerRunner('toy-runner', toyRunner);
  const seeded = await manager.install('toy');
  assert.equal(seeded.written, true, 'a manifest-only tree was trusted as installed');
  assert.equal(fs.readFileString(`${root}/share/toy/x.txt`), 'payload\n');
}

// ── Explicit install refuses a runner it cannot bind, before any write ────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  const { manager } = makeManager(vfs, suppliedRuntimeSource([pkg]));

  await assert.rejects(() => manager.install('toy'), /runner 'toy-runner' not registered/);
  assert.ok(!fs.exists('home/user/.nimbus'), 'a refused install still wrote payload');

  // Provisioning is not the command: installPackage seeds the filesystem and
  // the bins simply never bind until a runner exists.
  const seeded = await manager.installPackage(pkg);
  assert.equal(seeded.written, true);
  assert.equal((await manager.list()).length, 1);
  manager.registerRunner('toy-runner', toyRunner);
  assert.deepEqual((await manager.rehydrate()).bins, ['toy']);
}

// ── A shared source's default is not always a build this workspace binds ──
// A runtime rebuilt against a new runner contract publishes under a new
// version and runner key; the source keeps offering the old default to the
// deployments that still bind it. A bare name resolves to the newest version
// whose runners are registered here; an explicit version is never substituted.
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const oldBuild = fakePackage({ 'bin/toy': '# v1\n' }, { version: '1.0.0', runner: 'toy-runner' });
  const newBuild = fakePackage({ 'bin/toy': '# v2\n' }, { version: '1.0.0-2', runner: 'toy-runner@2' });
  const shared = {
    async list() {
      return [{
        name: 'toy', abi: 'wasm32-wasi-nimbus', defaultVersion: '1.0.0',
        versions: [oldBuild, newBuild].map((p) => ({ version: p.manifest.version, sizeBytes: 1, license: 'MIT' })),
      }];
    },
    async resolve(spec) {
      if (spec === 'toy' || spec === 'toy@1.0.0') return oldBuild;
      if (spec === 'toy@1.0.0-2') return newBuild;
      return null;
    },
  };
  const { manager } = makeManager(vfs, shared);
  manager.registerRunner('toy-runner@2', toyRunner);

  const seeded = await manager.install('toy');
  assert.equal(seeded.version, '1.0.0-2', 'the default was installed although this workspace cannot bind it');
  assert.equal(fs.readFileString(`${seeded.root}/bin/toy`), '# v2\n');
  await assert.rejects(() => manager.install('toy@1.0.0'), /toy@1\.0\.0: runner 'toy-runner' not registered/);

  const { manager: older } = makeManager(openVfs(), shared);
  older.registerRunner('toy-runner', toyRunner);
  assert.equal((await older.install('toy')).version, '1.0.0', 'a workspace that binds the default must keep it');
}

// ── Reopen: a fresh manager over the same disk rehydrates every bin ───────
{
  const vfs = openVfs();
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  const first = makeManager(vfs, suppliedRuntimeSource([pkg]));
  first.manager.registerRunner('toy-runner', toyRunner);
  await first.manager.install('toy');

  const second = makeManager(vfs, suppliedRuntimeSource([]));
  second.manager.registerRunner('toy-runner', toyRunner);
  assert.deepEqual((await second.manager.rehydrate()).bins, ['toy']);
  assert.ok(second.registry.commands.has('toy'), 'rehydrate did not rebind the bin');
}

// ── Uninstall, then install, actually reinstalls ──────────────────────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  const { manager, registry } = makeManager(vfs, suppliedRuntimeSource([pkg]));
  manager.registerRunner('toy-runner', toyRunner);
  await manager.install('toy');

  await manager.uninstall('toy');
  assert.equal((await manager.list()).length, 0);
  assert.ok(!registry.commands.has('toy'), 'uninstall left the bin registered');
  assert.ok(!fs.exists('home/user/.nimbus/runtimes/toy'), 'uninstall left the tree');

  const again = await manager.install('toy');
  assert.equal(again.written, true, 'reinstall answered a stale memo');
}

// ── A stub installs on first use and dispatches the real handler ──────────
{
  const vfs = openVfs();
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  const { manager, registry } = makeManager(vfs, suppliedRuntimeSource([pkg]));
  manager.registerRunner('toy-runner', (_m, _r, binName) => async (ctx) => {
    ctx.stdout.write(`ran ${binName}\n`);
    return 0;
  });
  manager.registerInstallStub('toy');

  const ctx = {
    args: [],
    stdout: { write(s) { this.buf = (this.buf ?? '') + s; } },
    stderr: { write(s) { this.buf = (this.buf ?? '') + s; } },
  };
  const exitCode = await (await registry.resolve('toy'))(ctx);
  assert.equal(exitCode, 0, ctx.stderr.buf);
  assert.equal(ctx.stdout.buf, 'ran toy\n');
  assert.equal((await manager.list()).length, 1, 'the stub never installed');
}

// ── Same-size corruption is rewritten, not trusted ──────────────────────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'bin/toy': '# t\n', 'share/toy/x.txt': 'abc\n' });
  const { manager } = makeManager(vfs, suppliedRuntimeSource([pkg]));
  manager.registerRunner('toy-runner', toyRunner);
  await manager.install('toy');

  const root = 'home/user/.nimbus/runtimes/toy/1.0.0';
  // Same length, different bytes: a size-only check would bind this.
  fs.writeFile(`${root}/share/toy/x.txt`, 'abd\n');
  const seeded = await manager.install('toy');
  assert.equal(seeded.written, true, 'a corrupted tree was trusted as installed');
  assert.equal(fs.readFileString(`${root}/share/toy/x.txt`), 'abc\n');
}

// ── Reopen skips a corrupt tree; the next install repairs it ────────────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  const { manager } = makeManager(vfs, suppliedRuntimeSource([pkg]));
  manager.registerRunner('toy-runner', toyRunner);
  await manager.install('toy');
  fs.writeFile('home/user/.nimbus/runtimes/toy/1.0.0/bin/toy', '# tampered\n');

  const second = makeManager(vfs, suppliedRuntimeSource([pkg]));
  second.manager.registerRunner('toy-runner', toyRunner);
  const rehydrated = await second.manager.rehydrate();
  assert.deepEqual(rehydrated.bins, [], 'a tampered tree was bound on reopen');
  assert.ok(!second.registry.commands.has('toy'));

  const repaired = await second.manager.install('toy');
  assert.equal(repaired.written, true, 'a corrupt tree was not repaired on next install');
}

// ── Host files survive a failed force retry and the manifest marker is gone ─
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'bin/toy': '# t\n', 'share/toy/x.txt': 'x\n' });
  const root = 'home/user/.nimbus/runtimes/toy/1.0.0';
  const { manager } = makeManager(vfs, suppliedRuntimeSource([pkg]));
  manager.registerRunner('toy-runner', toyRunner);
  await manager.install('toy');
  fs.mkdir(`${root}/lib/site-packages`, { recursive: true });
  fs.writeFile(`${root}/lib/site-packages/host.py`, 'host\n');

  let calls = 0;
  const flaky = {
    manifest: pkg.manifest,
    readBlob: (file) => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('readBlob down')) : pkg.readBlob(file);
    },
  };
  const retry = makeManager(vfs, suppliedRuntimeSource([flaky]));
  retry.manager.registerRunner('toy-runner', toyRunner);

  await assert.rejects(
    () => retry.manager.install('toy', { force: true }),
    /readBlob down/,
  );
  assert.equal(fs.readFileString(`${root}/lib/site-packages/host.py`), 'host\n',
    'a failed force install erased files outside the manifest');
  assert.ok(!fs.exists(`${root}/manifest.json`), 'a failed retry left the completion marker');

  const recovered = await retry.manager.install('toy', { force: true });
  assert.equal(recovered.written, true);
  assert.equal(fs.readFileString(`${root}/lib/site-packages/host.py`), 'host\n');
}

// ── reject(null) is an error, and the retry starts only after siblings settle ─
{
  const vfs = openVfs();
  const pkg = fakePackage({ 'bin/toy': '# t\n', 'share/a.txt': 'a\n', 'share/b.txt': 'b\n' });
  let siblingSettled = false;
  const nullReject = {
    manifest: pkg.manifest,
    readBlob: (file) => {
      if (file.path === 'share/a.txt' && !siblingSettled) return Promise.reject(null);
      if (file.path === 'share/b.txt') {
        return new Promise((resolve) => setTimeout(() => {
          siblingSettled = true;
          resolve(pkg.readBlob(file));
        }, 100));
      }
      return pkg.readBlob(file);
    },
  };
  const { manager } = makeManager(vfs, suppliedRuntimeSource([nullReject]));
  manager.registerRunner('toy-runner', toyRunner);

  await assert.rejects(() => manager.install('toy'));
  assert.equal(siblingSettled, true,
    'the install rejected before a started sibling write settled');
  const retried = await manager.install('toy');
  assert.equal(retried.written, true, 'the retry contended with the failed attempt');
}

// ── The home a resolution saw is the home the write lands in ────────────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  let home = '/home/user';
  let release;
  const gate = new Promise((r) => { release = r; });
  const source = {
    list: async () => [],
    resolve: async () => { await gate; return pkg; },
  };
  const registry = makeRegistry();
  const manager = new RuntimeManager({
    vfs: new ExecutionFs(new SqliteFilesystemAuthority(vfs).openHost(KERNEL).fs), registry, getHome: () => home, source,
  });
  manager.registerRunner('toy-runner', toyRunner);

  const pending = manager.install('toy');
  home = '/home/other'; // the environment shifts mid-resolve
  release();
  const seeded = await pending;
  assert.equal(seeded.root, 'home/user/.nimbus/runtimes/toy/1.0.0');
  assert.ok(!fs.exists('home/other'), 'a mid-install HOME change retargeted the write');
}

// ── Uninstall during a resolve does not wait for unrelated writes ───────────
{
  const vfs = openVfs();
  const toy = fakePackage({ 'bin/toy': '# t\n' });
  const big = fakePackage({ 'bin/big': '# b\n' }, { name: 'big', bins: ['big'] });
  let writeRelease;
  const writeGate = new Promise((r) => { writeRelease = r; });
  const slow = {
    manifest: big.manifest,
    readBlob: async (file) => { await writeGate; return big.readBlob(file); },
  };
  const source = {
    list: async () => [],
    // Resolution is fast — only big's payload write is gated.
    resolve: async (spec) => (spec === 'big' ? slow : spec === 'toy' ? toy : null),
  };
  const registry = makeRegistry();
  const manager = new RuntimeManager({ vfs: new ExecutionFs(new SqliteFilesystemAuthority(vfs).openHost(KERNEL).fs), registry, getHome: () => HOME, source });
  manager.registerRunner('toy-runner', toyRunner);
  await manager.install('toy');

  const pendingBig = manager.install('big');
  await new Promise((r) => setTimeout(r, 0)); // let big reach its writes
  const uninstalled = manager.uninstall('toy');
  const winner = await Promise.race([uninstalled.then(() => 'uninstall'), writeGate.then(() => 'big')]);
  assert.equal(winner, 'uninstall', 'uninstall waited on an unrelated payload write');
  await uninstalled;
  assert.deepEqual((await manager.list()).map((e) => e.name), []);
  writeRelease();
  await pendingBig;
  assert.deepEqual((await manager.list()).map((e) => e.name), ['big']);
}

// ── Uninstall during a write still removes the finished tree ────────────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'bin/toy': '# t\n', 'share/x.txt': 'x\n' });
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = {
    manifest: pkg.manifest,
    readBlob: async (file) => { await gate; return pkg.readBlob(file); },
  };
  const { manager } = makeManager(vfs, suppliedRuntimeSource([slow]));
  manager.registerRunner('toy-runner', toyRunner);

  const pending = manager.install('toy');
  await new Promise((r) => setTimeout(r, 0)); // let the install reach its writes
  const removing = manager.uninstall('toy');
  release();
  await Promise.all([pending, removing]);
  assert.equal((await manager.list()).length, 0, 'uninstall raced the in-flight write');
  assert.ok(!fs.exists('home/user/.nimbus/runtimes/toy'), 'the tree survived removal');
}

// ── Force queued behind a no-write reuse still rewrites ─────────────────────
{
  const vfs = openVfs();
  const pkg = fakePackage({ 'bin/toy': '# t\n' });
  const { manager } = makeManager(vfs, suppliedRuntimeSource([pkg]));
  manager.registerRunner('toy-runner', toyRunner);
  await manager.install('toy');

  const [joined, forced] = await Promise.all([
    manager.install('toy'),
    manager.install('toy', { force: true }),
  ]);
  assert.equal(joined.written, false, 'a verified tree was needlessly rewritten');
  assert.equal(forced.written, true, 'force joined the reuse instead of rewriting');
}

// ── Removing v2 cannot resurrect a corrupted v1; a healthy survivor rebinds ──
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const v1 = fakePackage({ 'bin/toy': '# v1\n' }, { version: '1.0.0' });
  const v2 = fakePackage({ 'bin/toy': '# v2\n' }, { version: '2.0.0' });
  const { manager, registry } = makeManager(vfs, suppliedRuntimeSource([v1, v2]));
  manager.registerRunner('toy-runner', toyRunner);
  await manager.installPackage(v1);
  await manager.installPackage(v2);
  assert.equal((await manager.list()).length, 2);

  // Corrupt v1's payload, then remove v2: the freed bin must not rebind v1.
  fs.writeFile('home/user/.nimbus/runtimes/toy/1.0.0/bin/toy', '# tampered\n');
  await manager.uninstall('toy@2.0.0');
  assert.equal((await manager.list()).length, 1);
  assert.ok(!registry.commands.has('toy'), 'removing v2 rebound a corrupted v1');

  // Same shape, healthy survivor: the bin comes back.
  const healthy = openVfs();
  const healthyFs = healthy.as(KERNEL);
  const v1ok = fakePackage({ 'bin/toy': '# v1\n' }, { version: '1.0.0' });
  const v2ok = fakePackage({ 'bin/toy': '# v2\n' }, { version: '2.0.0' });
  const second = makeManager(healthy, suppliedRuntimeSource([v1ok, v2ok]));
  second.manager.registerRunner('toy-runner', toyRunner);
  await second.manager.installPackage(v1ok);
  await second.manager.installPackage(v2ok);
  await second.manager.uninstall('toy@2.0.0');
  assert.ok(second.registry.commands.has('toy'), 'removing v2 dropped the healthy v1 bin');
}

console.log('runtime-manager: all assertions passed');
