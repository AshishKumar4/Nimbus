#!/usr/bin/env bun
// The filesystem backends a workspace mounts, each through a CompositeVFS
// the way a shell reaches it: SQLite at the root (credentialed, revisioned,
// synchronous), /proc (generated for the reader), /dev (devices), /tmp in
// memory. Each is checked on what its consumers depend on: permissions and
// ownership per principal, revisions that move on a change, POSIX errors as
// VfsError codes, devices that answer bounded reads only, and the sync view.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { ProcVFS, standardProc } from '../../packages/core/src/vfs/proc-vfs.ts';
import { DevVFS } from '../../packages/core/src/vfs/dev-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { isVfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { readText, writeText } from '../../packages/core/src/vfs/vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const OTHER = { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 };
const enc = new TextEncoder();
const dec = new TextDecoder();

async function code(run) {
  try { await run(); return 'ok'; } catch (e) { return isVfsError(e) ? e.code : `not a VfsError: ${e}`; }
}

function workspace() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', 1000, 1000);
  kernel.mkdir('etc', { mode: 0o755 });
  kernel.writeFile('etc/hostname', 'nimbus\n');
  kernel.chmod('etc/hostname', 0o644);
  const proc = new ProcVFS();
  proc.register('whoami', (cred) => `${cred?.uid ?? 'embedder'}\n`);
  proc.register('net/info', () => 'net\n');
  const vfs = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
  vfs.mount('/proc', proc);
  vfs.mount('/dev', new DevVFS());
  vfs.mount('/tmp', new MemoryVFS());
  return { engine, vfs };
}

// ── SQLite at the root, per principal ─────────────────────────────────────
{
  const { vfs } = workspace();
  const user = vfs.as(USER);
  const other = vfs.as(OTHER);
  await writeText(user, '/home/user/a.txt', 'mine');
  const st = await user.stat('/home/user/a.txt');
  assert.deepEqual([st.type, st.uid, st.gid, (st.mode & 0o777).toString(8)], ['file', 1000, 1000, '644']);
  assert.equal(typeof st.revision, 'number', 'SQLite stats carry a revision');
  const before = st.revision;
  await writeText(user, '/home/user/a.txt', 'changed');
  assert.ok((await user.stat('/home/user/a.txt')).revision > before, 'a write moves it');
  assert.equal(await readText(other, '/home/user/a.txt'), 'changed', 'others may read a 0644 file');
  assert.equal(await code(() => writeText(other, '/home/user/b.txt', 'x')), 'EACCES', "not write in another's directory");
  assert.equal(await code(() => writeText(user, '/etc/hostname', 'x')), 'EACCES', 'nor a root-owned file');
  assert.equal(await code(() => user.chmod('/etc/hostname', 0o777)), 'EPERM');
  assert.equal(await user.stat('/home/user/nope'), null);
  assert.equal(await code(() => user.readFile('/home/user/nope')), 'ENOENT');
  assert.equal(await code(() => user.readdir('/home/user/a.txt')), 'ENOTDIR');
  // The engine's own operations, through the interface.
  await user.mkdir('/home/user/d/e', { recursive: true });
  await user.rename('/home/user/a.txt', '/home/user/d/e/a.txt');
  assert.deepEqual((await user.readdir('/home/user/d/e')).map((e) => e.name), ['a.txt']);
  assert.equal(dec.decode(await user.readRange('/home/user/d/e/a.txt', 2, 3)), 'ang');
  // Compare-and-write on the row's revision.
  const rev = (await user.stat('/home/user/d/e/a.txt')).revision;
  assert.equal((await user.writeFileIfRevision('/home/user/d/e/a.txt', enc.encode('cas'), rev)).ok, true);
  assert.equal((await user.writeFileIfRevision('/home/user/d/e/a.txt', enc.encode('stale'), rev)).ok, false);
  assert.equal(await readText(user, '/home/user/d/e/a.txt'), 'cas');
  // Links are the engine's: followed, readlink'd, and ELOOP when they cycle.
  await user.symlink('/home/user/d/e/a.txt', '/home/user/ln');
  assert.equal(await readText(user, '/home/user/ln'), 'cas');
  assert.equal((await user.stat('/home/user/ln', { follow: false })).type, 'symlink');
  assert.equal(await user.readlink('/home/user/ln'), '/home/user/d/e/a.txt');
  await user.symlink('/home/user/loop2', '/home/user/loop1');
  await user.symlink('/home/user/loop1', '/home/user/loop2');
  assert.equal(await code(() => user.readFile('/home/user/loop1')), 'ELOOP');
  // Copy is rows, not bytes; the copy is independent.
  assert.equal(await user.copy('/home/user/d', '/home/user/d2', { recursive: true }) > 0, true);
  await writeText(user, '/home/user/d2/e/a.txt', 'copied');
  assert.equal(await readText(user, '/home/user/d/e/a.txt'), 'cas');
  assert.equal(await code(() => user.copy('/home/user/d', '/tmp/d', { recursive: true })), 'EXDEV', 'cp copies bytes across');
  assert.equal(await code(() => user.copy('/tmp/s', '/tmp/s2')), 'ENOTSUP', 'a backend without its own copy');
  await user.removeRecursive('/home/user/d');
  assert.equal(await user.stat('/home/user/d'), null);
  // Across the root and a mount: EXDEV.
  await writeText(user, '/home/user/x', 'x');
  assert.equal(await code(() => user.rename('/home/user/x', '/tmp/x')), 'EXDEV');
  // The sync view reaches SQLite and memory without waiting.
  user.sync.writeFile('/tmp/s', enc.encode('sync'));
  assert.equal(dec.decode(user.sync.readFile('/tmp/s')), 'sync');
  assert.equal(user.sync.stat('/home/user/x').type, 'file');
}

// ── /proc, generated for the reader ───────────────────────────────────────
{
  const { vfs } = workspace();
  assert.equal(await readText(vfs.as(USER), '/proc/whoami'), '1000\n');
  assert.equal(await readText(vfs.as(OTHER), '/proc/whoami'), '1001\n');
  assert.equal(await readText(vfs, '/proc/whoami'), 'embedder\n');
  assert.deepEqual((await vfs.readdir('/proc')).map((e) => `${e.name}:${e.type}`).sort(), ['net:directory', 'whoami:file']);
  assert.equal(await readText(vfs, '/proc/net/info'), 'net\n');
  assert.equal((await vfs.stat('/proc/whoami')).revision, undefined, 'generated: no revision, never cached');
  assert.equal(await code(() => writeText(vfs, '/proc/whoami', 'x')), 'EROFS');
  assert.equal(await code(() => vfs.readFile('/proc/nope')), 'ENOENT');
}

// The standard /proc has what the kernel's ProcProvider had.
{
  const vfs = new CompositeVFS(new MemoryVFS());
  vfs.mount('/proc', standardProc());
  assert.deepEqual((await vfs.readdir('/proc')).map((e) => e.name).sort(), ['cpuinfo', 'meminfo', 'net', 'uptime', 'version']);
  assert.match(await readText(vfs, '/proc/cpuinfo'), /^processor\t: 0/);
  assert.match(await readText(vfs, '/proc/meminfo'), /^MemTotal:/);
}

// ── the change feed a node process's staged files follow ───────────────────
{
  const { engine } = workspace();
  const files = sqliteFiles(engine, USER);
  const { changes } = files;
  const cursor = changes.revision();
  files.writeFile('/home/user/new.txt', enc.encode('n'));
  files.mkdir('/home/user/dir');
  const delta = changes.since(changes.epoch, cursor, { namespace: true });
  assert.equal(delta.poison, false);
  const named = delta.paths.map((e) => e.path);
  assert.ok(named.includes('/home/user/new.txt') && named.includes('/home/user/dir'), JSON.stringify(named));
  assert.equal(delta.paths.find((e) => e.path === '/home/user/new.txt').stat.type, 'file');
  assert.equal(changes.since('another-epoch', cursor).poison, true, 'a cursor from another epoch is a poison');
  const listed = changes.list(null, 1000).entries.map((e) => e.path);
  assert.ok(listed.includes('/home/user/new.txt'), 'listing paths are absolute too');
  // The feed is the principal's view: a file under a directory it cannot
  // search is never named to it.
  engine.as(CRED_KERNEL).mkdir('secret', { mode: 0o700 });
  engine.as(CRED_KERNEL).writeFile('secret/key', 'k');
  const since = changes.since(changes.epoch, cursor, { namespace: true }).paths.map((e) => e.path);
  assert.ok(!since.includes('/secret/key'), JSON.stringify(since));
  assert.ok(!changes.list(null, 1000).entries.some((e) => String(e.path).includes('secret/key')));
}

// ── /dev ───────────────────────────────────────────────────────────────────
{
  const { vfs } = workspace();
  const dev = vfs.as(USER);
  assert.equal((await dev.stat('/dev/null')).mode & 0o170000, 0o020000, 'a character device');
  assert.equal((await dev.readFile('/dev/null')).length, 0);
  assert.equal(await code(() => dev.readFile('/dev/zero')), 'EINVAL', 'an endless device is never read whole');
  assert.deepEqual([...(await dev.readRange('/dev/zero', 0, 4))], [0, 0, 0, 0]);
  assert.equal((await dev.readRange('/dev/urandom', 0, 16)).length, 16);
  await dev.writeFile('/dev/null', enc.encode('discarded'));
  assert.equal(await code(() => dev.writeFile('/dev/full', enc.encode('x'))), 'ENOSPC');
  assert.equal(await code(() => dev.unlink('/dev/null')), 'EPERM');
  assert.ok((await dev.readdir('/dev')).some((e) => e.name === 'urandom'));
}

// ── the mount table describes itself ──────────────────────────────────────
{
  const { vfs } = workspace();
  assert.deepEqual(vfs.mounts().map((m) => `${m.point} ${m.describe().type}`), [
    '/ nimbusfs', '/proc proc', '/dev devtmpfs', '/tmp tmpfs',
  ]);
}

console.log('vfs-backends: ok');
