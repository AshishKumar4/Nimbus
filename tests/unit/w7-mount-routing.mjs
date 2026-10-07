#!/usr/bin/env bun
/**
 * w7-mount-routing — a W7 wave's records land where the namespace puts the
 * same names for a single operation: on a mount, a record is that mount's
 * (by the namespace's own operation), never SQLite's under the mount point.
 *
 * Every wave reaches SqliteVFS.writeStream: a process's binding (npm's batch
 * facet, git's network facet, a WaveWriter in any facet, a delegation's
 * holder) through the writeBatchStream op, and in-session commands (git's
 * object writer, npm's bin links) holding the engine. Red before:
 * - a mount over a directory the session has: the wave answered ok and its
 *   file went to SQLite under the mount point, where the mount hides it;
 * - a mount over no directory: the wave was refused ENOENT where writeFile
 *   writes the file.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createWaveWriter } from '../../packages/platform/src/wave-writer.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { HELD_FILE_BYTES, STAGED_LINK_STALE_MS } from '../../packages/core/src/runtime/wave-router.ts';
import { seedBaseFilesystem } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { seedProject } from '../../packages/core/src/vfs/seed-project.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

function session({ underneath = true } = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  if (underneath) {
    // The directory a mount is made over, as the session had it.
    kernel.mkdir('shared', { mode: 0o755 });
    kernel.chown('shared', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }
  const files = new ProcessFiles(engine);
  const shared = new MemoryVFS();
  files.vfs.mount('/shared', shared);
  const readOnly = new MemoryVFS();
  readOnly.writeFile('/kept', enc.encode('kept'));
  files.vfs.mount('/ro', readOnly, { readOnly: true });
  const op = createSupervisorOpHandler({ vfs: engine, filesystem: files });
  /** A wave as a process's binding sends it. */
  const send = (payload) => op({ op: 'writeBatchStream', args: [], cred: CRED_SESSION_USER, stream: encodeWriteBatchStream(payload) });
  const inMount = (vfs, path) => { try { return dec.decode(vfs.readFile(path)); } catch { return null; } };
  const inSqlite = (key) => { try { return dec.decode(kernel.readFile(key)); } catch { return null; } };
  const sqliteNames = (key) => { try { return kernel.readdir(key).map((entry) => entry.name).sort(); } catch { return null; } };
  return { engine, kernel, files, shared, readOnly, op, send, inMount, inSqlite, sqliteNames };
}

function file(path, text, mode = 0o644) {
  const data = typeof text === 'string' ? enc.encode(text) : text;
  const chunks = [];
  for (let at = 0, id = 0; at < data.byteLength || id === 0; at += 65_536, id++) {
    if (data.byteLength === 0) break;
    chunks.push({ path, chunkId: id, data: data.subarray(at, at + 65_536) });
  }
  return {
    inode: { path, parentPath: path.slice(0, path.lastIndexOf('/')), kind: 'file', isDir: false, size: data.byteLength, mtime: 1_700_000_000_000, mode, chunkCount: chunks.length },
    chunks,
  };
}
const dir = (path, mode = 0o755) => ({ path, parentPath: path.slice(0, path.lastIndexOf('/')), kind: 'directory', isDir: true, size: 0, mtime: 1_700_000_000_000, mode, chunkCount: 0 });
function wave(...parts) {
  const inodes = [];
  const chunks = [];
  for (const part of parts) {
    if ('inode' in part) { inodes.push(part.inode); chunks.push(...part.chunks); } else inodes.push(part);
  }
  return { inodes, chunks };
}

// ── A mount over a directory the session has: the file is the mount's ───
{
  const s = session();
  const result = await s.send(wave(file('shared/by-wave', 'hello')));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(s.inMount(s.shared, '/by-wave'), 'hello', 'the wave did not land in the mount');
  assert.deepEqual(s.sqliteNames('shared'), [], 'the wave wrote SQLite under the mount point, where the mount hides it');
}

// ── A mount over no directory: the file is the mount's, not ENOENT ──────
{
  const s = session({ underneath: false });
  const result = await s.send(wave(file('shared/by-wave', 'hello')));
  assert.equal(result.ok, true, `refused where writeFile writes: ${JSON.stringify(result)}`);
  assert.equal(s.inMount(s.shared, '/by-wave'), 'hello');
}

// ── A read-only mount refuses EROFS; nothing hides under its point ──────
{
  const s = session();
  s.kernel.mkdir('ro', { mode: 0o777 });
  const result = await s.send(wave(file('home/user/before', 'b'), file('ro/denied', 'x'), file('home/user/after', 'a')));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /EROFS/, JSON.stringify(result));
  assert.equal(s.inSqlite('home/user/before'), 'b', 'what the wave wrote before the refusal is committed');
  assert.equal(result.committedPathCount, 1);
  assert.equal(s.inSqlite('home/user/after'), null, 'nothing after the refusal is written');
  assert.deepEqual(s.sqliteNames('ro'), [], 'the refused record was written under the mount point');
  assert.equal(s.inMount(s.readOnly, '/denied'), null);
  assert.equal(s.inMount(s.readOnly, '/kept'), 'kept');
}

// ── A wave spanning SQLite and a mount, applied in its order ────────────
{
  const s = session();
  s.shared.writeFile('/old', enc.encode('old'));
  const large = new Uint8Array(200_000).map((_, index) => (index * 7) & 255);
  const result = await s.send({
    ...wave(
      dir('home/user/proj'),
      file('home/user/proj/a', 'sqlite a'),
      dir('shared/pkg'),
      dir('shared/pkg/lib'),
      file('shared/pkg/lib/index.js', 'mounted'),
      file('shared/pkg/big.bin', large),
      file('home/user/proj/b', 'sqlite b', 0o755),
    ),
    deletePaths: ['shared/old'],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(s.inSqlite('home/user/proj/a'), 'sqlite a');
  assert.equal(s.inSqlite('home/user/proj/b'), 'sqlite b');
  assert.equal(s.inMount(s.shared, '/pkg/lib/index.js'), 'mounted');
  assert.deepEqual(new Uint8Array(s.shared.readFile('/pkg/big.bin')), large, 'a multi-chunk file reached the mount whole');
  assert.equal(s.inMount(s.shared, '/old'), null, 'the removal reached the mount');
  assert.deepEqual(s.sqliteNames('shared'), []);
  assert.equal(result.committedPathCount, 8, 'every record, routed or not, counts in the committed prefix');
}

// ── A name whose parent is a link into the mount lands in the mount ─────
{
  const s = session();
  s.shared.mkdir('/data');
  s.engine.as(CRED_SESSION_USER).symlink('/shared/data', 'home/user/data');
  const result = await s.send(wave(file('home/user/data/through-link', 'linked')));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(s.inMount(s.shared, '/data/through-link'), 'linked');
  assert.deepEqual(s.sqliteNames('shared'), []);
}

// ── The session's own mounts: /proc is not written under ───────────────
{
  const s = session();
  const result = await s.send(wave(file('proc/planted', 'x')));
  assert.equal(result.ok, false, 'a wave wrote under /proc');
  assert.equal(s.sqliteNames('proc'), null, 'the refused record was written to SQLite under /proc');
}

// ── A command holding the engine routes the same way ───────────────────
{
  const s = session();
  const result = await s.engine.as(CRED_SESSION_USER).writeStream(encodeWriteBatchStream(wave(file('shared/from-engine', 'engine'))));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(s.inMount(s.shared, '/from-engine'), 'engine');
  assert.deepEqual(s.sqliteNames('shared'), []);
}

// ── A WaveWriter's tree under a mount, as npm's and git's facets write ──
{
  const s = session();
  const writer = createWaveWriter({
    supervisor: { writeBatchStream: (stream) => s.op({ op: 'writeBatchStream', args: [], cred: CRED_SESSION_USER, stream }) },
    root: 'shared/node_modules',
  });
  for (let index = 0; index < 300; index++) await writer.file(`shared/node_modules/p${index % 20}/f${index}.js`, 0o644, enc.encode(`module ${index}`));
  await writer.symlink('shared/node_modules/.bin/tool', '../p0/f0.js');
  await writer.flush();
  for (let index = 0; index < 300; index++) assert.equal(s.inMount(s.shared, `/node_modules/p${index % 20}/f${index}.js`), `module ${index}`);
  assert.equal(s.shared.readlink('/node_modules/.bin/tool'), '../p0/f0.js');
  assert.deepEqual(s.sqliteNames('shared'), []);
}

// ── Review: receipts, removal reports, guards, links, spooling, re-sends, writeBatch ──

/** A MemoryVFS whose chosen operations refuse or report as `overrides` says (each called with the VFS, then its arguments). */
function scripted(overrides) {
  const inner = new MemoryVFS();
  return new Proxy(inner, {
    get(target, name) {
      if (Object.hasOwn(overrides, name)) return overrides[name] === undefined ? undefined : overrides[name].bind(target, target);
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// A routed file has a receipt, as one on SQLite does: what stat reports of it.
{
  const s = session();
  const result = await s.send(wave(file('home/user/here', 'h'), file('shared/there', 'there!', 0o640)));
  assert.equal(result.ok, true, JSON.stringify(result));
  const receipts = Object.fromEntries(result.receipts.map((receipt) => [receipt.path, receipt]));
  assert.ok(receipts['home/user/here'], 'the SQLite file lost its receipt');
  assert.ok(receipts['shared/there'], 'the routed file has no receipt');
  assert.equal(receipts['shared/there'].size, 6);
}

// A removal that keeps something is refused with what it kept, and the wave stops there.
{
  const s = session();
  const stubborn = scripted({
    removeRecursive: (_self, path) => ({ removed: [], kept: [path + '/locked'], failures: [] }),
  });
  s.files.vfs.mount('/stubborn', stubborn);
  stubborn.mkdir('/d');
  const result = await s.send({ ...wave(file('home/user/after', 'a')), deletePaths: ['stubborn/d'] });
  assert.equal(result.ok, false, 'a removal that kept a name was reported as made');
  assert.match(result.error.message, /kept 1 \(\/stubborn\/d\/locked\)/);
  assert.equal(s.inSqlite('home/user/after'), null, 'the wave went on past a removal it did not make');
}

// Admission and cancellation are checked right before each call to the backend.
{
  const s = session();
  const big = new Uint8Array(150_000).fill(9);
  let admits = 0;
  let firstRefused = 0;
  // Overtaken right before its second chunk's write: what was written stays, nothing more is.
  const result = await s.engine.as(CRED_SESSION_USER).writeStream(encodeWriteBatchStream(wave(file('shared/late', big), file('shared/after', 'a'))), {
    admit: () => {
      admits++;
      if (s.inMount(s.shared, '/late') !== null && firstRefused++ === 0) throw Object.assign(new Error('ESTALE: overtaken'), { code: 'ESTALE' });
      if (firstRefused > 0) throw Object.assign(new Error('ESTALE: overtaken'), { code: 'ESTALE' });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /ESTALE/);
  assert.ok(s.shared.readFile('/late').byteLength < big.byteLength, 'an overtaken wave went on writing its file');
  assert.equal(s.inMount(s.shared, '/after'), null, 'an overtaken wave went on to its next record');
}

// A file is written as writeFile and range writes make it: the existing
// file's inode, mode and owner kept, a link at its name followed, a file
// writable in a directory that is not. Red before: a staged file renamed
// over it (a fresh inode, 0644, the link replaced, EACCES on the rename).
{
  const s = session();
  const body = new Uint8Array(200_000).map((_, index) => (index * 3) & 255);
  s.shared.writeFile('/kept', enc.encode('old'));
  s.shared.chmod('/kept', 0o600);
  const inode = s.shared.stat('/kept').ino;
  s.shared.mkdir('/real');
  s.shared.writeFile('/real/target', enc.encode('old target'));
  s.shared.symlink('real/target', '/via-link');
  const result = await s.send(wave(file('shared/kept', body), file('shared/via-link', body)));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(s.shared.stat('/kept').mode & 0o7777, 0o600, 'the file lost its mode');
  assert.equal(s.shared.stat('/kept').ino, inode, 'the file was replaced by another inode');
  assert.deepEqual(new Uint8Array(s.shared.readFile('/kept')), body);
  assert.equal(s.shared.stat('/via-link', { follow: false }).type, 'symlink', 'the link at the name was replaced');
  assert.deepEqual(new Uint8Array(s.shared.readFile('/real/target')), body, 'the link was not followed');
}

// Every call of a record lands where it was placed: an alias repointed
// mid-file does not move the rest of the file, a directory that moves
// refuses it, and a file replaced under it refuses it (ESTALE). Red
// before: each range re-resolved the alias, and the rest of the file went
// to the new target, zero-filled up to its offset.
{
  const s = session();
  const body = new Uint8Array(200_000).map((_, index) => (index * 5) & 255);
  let ranges = 0;
  const pin = scripted({
    writeRange(self, path, offset, data) {
      if (++ranges === 1) {
        // A peer repoints the alias after the first chunk.
        s.engine.as(CRED_SESSION_USER).unlink('home/user/alias');
        s.engine.as(CRED_SESSION_USER).symlink('/pin/B', 'home/user/alias');
      }
      return self.writeRange(path, offset, data);
    },
  });
  s.files.vfs.mount('/pin', pin);
  pin.mkdir('/A');
  pin.mkdir('/B');
  s.engine.as(CRED_SESSION_USER).symlink('/pin/A', 'home/user/alias');
  const result = await s.send(wave(file('home/user/alias/f', body)));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(ranges >= 1, 'the file was not written in ranges');
  assert.deepEqual(new Uint8Array(pin.readFile('/A/f')), body, 'the file did not stay where it was placed');
  assert.equal(s.inMount(pin, '/B/f'), null, 'part of the file went to the repointed alias');

  // A directory that moves under a record refuses it.
  const moving = scripted({
    writeRange(self, path, offset, data) {
      // After the first range lands, a peer moves the directory.
      const written = self.writeRange(path, offset, data);
      if (!self.__moved) { self.__moved = true; self.rename('/D', '/E'); }
      return written;
    },
  });
  s.files.vfs.mount('/moving', moving);
  moving.mkdir('/D');
  const moved = await s.send(wave(file('moving/D/f', body)));
  assert.equal(moved.ok, false);
  assert.equal(moved.error.errno, 'ESTALE', moved.error.message);
  assert.equal(s.inMount(moving, '/D/f'), null, 'a range went to a new directory at the old name');
}

// A link's target is bounded as symlink(2) bounds it.
{
  const s = session();
  const long = enc.encode('t'.repeat(5_000));
  const result = await s.send({
    inodes: [{ path: 'shared/long', parentPath: 'shared', kind: 'symlink', isDir: false, size: long.byteLength, mtime: 1, mode: 0o777, chunkCount: 1 }],
    chunks: [{ path: 'shared/long', chunkId: 0, data: long }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.errno, 'ENAMETOOLONG');
  assert.equal(s.shared.stat('/long', { follow: false }), null);
}

// A staged link a crash left is removed: by the next wave making a link of
// that name, or, once stale, by any wave making a link in its directory.
{
  const s = session();
  s.shared.symlink('leftover', '/.tool.nimbus-wave');
  s.shared.symlink('old', '/.other.nimbus-wave');
  const target = enc.encode('bin/tool.js');
  const link = (path) => ({
    inodes: [{ path, parentPath: 'shared', kind: 'symlink', isDir: false, size: target.byteLength, mtime: 1, mode: 0o777, chunkCount: 1 }],
    chunks: [{ path, chunkId: 0, data: target }],
  });
  assert.equal((await s.send(link('shared/tool'))).ok, true);
  assert.equal(s.shared.readlink('/tool'), 'bin/tool.js');
  assert.equal(s.shared.stat('/.tool.nimbus-wave', { follow: false }), null, 'the leftover of this name stayed');
  assert.notEqual(s.shared.stat('/.other.nimbus-wave', { follow: false }), null, 'a fresh staged link of another name was swept');
  const realNow = Date.now;
  Date.now = () => realNow() + STAGED_LINK_STALE_MS + 1_000;
  try {
    assert.equal((await s.send(link('shared/tool2'))).ok, true);
  } finally {
    Date.now = realNow;
  }
  assert.equal(s.shared.stat('/.other.nimbus-wave', { follow: false }), null, 'a stale staged link stayed');
}

// A name placed on SQLite is placed again right before its commit: a peer
// that repoints its directory onto a mount in between refuses the wave
// (ESTALE), and no row is written beneath the mount. Red before: the
// cached placement committed the file to SQLite, hidden by the mount.
{
  const s = session();
  s.engine.as(CRED_SESSION_USER).mkdir('home/user/real');
  s.engine.as(CRED_SESSION_USER).symlink('real', 'home/user/alias');
  const bytes = new Uint8Array(await new Response(encodeWriteBatchStream(wave(file('home/user/alias/a', new Uint8Array(300_000).fill(4)), file('home/user/alias/b', 'b')))).arrayBuffer());
  const half = bytes.byteLength >> 1;
  let pulls = 0;
  const stream = new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      if (pulls++ === 0) { controller.enqueue(bytes.slice(0, half)); return; }
      // The engine has placed the file by now; a peer repoints the alias onto the mount.
      await new Promise((resolve) => setTimeout(resolve, 50));
      s.engine.as(CRED_SESSION_USER).unlink('home/user/alias');
      s.engine.as(CRED_SESSION_USER).symlink('/shared', 'home/user/alias');
      controller.enqueue(bytes.slice(half));
      controller.close();
    },
  });
  const result = await s.op({ op: 'writeBatchStream', args: [], cred: CRED_SESSION_USER, stream });
  assert.equal(result.ok, false, 'a placement a peer moved was committed');
  assert.equal(result.error.errno, 'ESTALE', result.error.message);
  assert.equal(s.inSqlite('home/user/real/a'), null);
  assert.deepEqual(s.sqliteNames('shared'), []);
}

// writeBatch is cancelled with its process: released mid-batch, it publishes nothing more.
{
  const s = session();
  let releaseHost;
  const slow = scripted({
    async writeFile(self, path, data, options) {
      if (path === '/first') await releaseHost();
      return self.writeFile(path, data, options);
    },
  });
  s.files.vfs.mount('/slow', slow);
  const host = s.files.openHost(CRED_SESSION_USER);
  releaseHost = () => host.dispose();
  await assert.rejects(Promise.resolve(host.fs.writeBatch(wave(file('slow/first', 'f'), file('slow/second', 's')))));
  assert.equal(slow.stat('/second'), null, 'a released process published after its release');
}

// The seeds land where the namespace puts them: the base on a mount over /etc, and no starter project beneath a mount.
{
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine);
  const etc = new MemoryVFS();
  files.vfs.mount('/etc', etc);
  await seedBaseFilesystem(files);
  assert.match(dec.decode(etc.readFile('/passwd')), /^root:x:0:0/, '/etc/passwd did not reach the mount');
  assert.equal(engine.as(CRED_KERNEL).exists('etc/passwd'), false, 'the seed wrote SQLite beneath /etc');
  const home = new MemoryVFS();
  engine.as(CRED_KERNEL).mkdir('home/user', { recursive: true });
  files.vfs.mount('/home/user', home);
  const seeded = seedProject(engine);
  assert.equal(seeded.seeded, false);
  assert.equal(engine.as(CRED_KERNEL).exists('home/user/example-app'), false, 'the starter project was written beneath a mount');
}

// A link replaces what is there only once the backend has made it.
{
  const s = session();
  const linkless = scripted({ symlink: () => { throw Object.assign(new Error('ENOTSUP: no links here'), { code: 'ENOTSUP' }); } });
  s.files.vfs.mount('/nolinks', linkless);
  linkless.writeFile('/name', enc.encode('kept'));
  const target = enc.encode('elsewhere');
  const result = await s.send({
    inodes: [{ path: 'nolinks/name', parentPath: 'nolinks', kind: 'symlink', isDir: false, size: target.byteLength, mtime: 1, mode: 0o777, chunkCount: 1 }],
    chunks: [{ path: 'nolinks/name', chunkId: 0, data: target }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.errno, 'ENOTSUP');
  assert.equal(dec.decode(linkless.readFile('/name')), 'kept', 'the old entry went before the link was made');
}

// A large file is written to a mount chunk by chunk, never held whole.
{
  const s = session();
  const large = new Uint8Array(20 * 1024 * 1024).map((_, index) => index & 255);
  const result = await s.send(wave(file('shared/large.bin', large)));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(new Uint8Array(s.shared.readFile('/large.bin')), large);
  // A backend that writes no ranges takes a file whole, up to HELD_FILE_BYTES.
  const whole = scripted({ writeRange: undefined });
  s.files.vfs.mount('/whole', whole);
  const small = await s.send(wave(file('whole/small', new Uint8Array(1024 * 1024).fill(1))));
  assert.equal(small.ok, true, JSON.stringify(small.error));
  const refused = await s.send(wave(file('whole/huge', new Uint8Array(HELD_FILE_BYTES + 1))));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.errno, 'ENOTSUP');
  assert.match(refused.error.message, new RegExp(`up to ${HELD_FILE_BYTES} bytes`));
}

// A re-sent wave applies no mounted record an earlier attempt may have applied.
{
  const s = session();
  const deliveries = new SupervisorDeliveries();
  const writer = deliveries.openWaveWriter(7, 60_000);
  // Attempt 1 removes the mounted name, then is refused (its next record).
  s.shared.writeFile('/peer', enc.encode('old'));
  const first = deliveries.admitWave(7, writer, 1, 1);
  const payload = { ...wave(file('ro/x', 'x')), deletePaths: ['shared/peer'] };
  const one = await s.engine.as(CRED_SESSION_USER).writeStream(encodeWriteBatchStream(payload), { admit: first.check, mountReach: first.reach });
  assert.equal(one.ok, false);
  // A peer makes the name again; the re-send must not remove it.
  s.shared.writeFile('/peer', enc.encode('new'));
  const second = deliveries.admitWave(7, writer, 1, 2);
  const two = await s.engine.as(CRED_SESSION_USER).writeStream(encodeWriteBatchStream(payload), { admit: second.check, mountReach: second.reach });
  assert.equal(two.ok, false);
  assert.match(two.error.message, /outcome unknown/);
  assert.equal(s.inMount(s.shared, '/peer'), 'new', 'the re-send removed what a peer made since');
  // A wave whose earlier attempt never reached its mounted record applies it.
  const third = deliveries.admitWave(7, writer, 2, 1);
  void third;
  const fourth = deliveries.admitWave(7, writer, 2, 2);
  const applied = await s.engine.as(CRED_SESSION_USER).writeStream(encodeWriteBatchStream(wave(file('shared/fresh', 'f'))), { admit: fourth.check, mountReach: fourth.reach });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(s.inMount(s.shared, '/fresh'), 'f');
}

// writeBatch lands where the namespace puts it: on a mount, record by record.
{
  const s = session();
  const host = s.files.openHost(CRED_SESSION_USER);
  await host.fs.writeBatch(wave(file('shared/batched', 'b'), file('home/user/batched', 'h')));
  await host.dispose();
  assert.equal(s.inMount(s.shared, '/batched'), 'b');
  assert.equal(s.inSqlite('home/user/batched'), 'h');
  assert.deepEqual(s.sqliteNames('shared'), []);
}

console.log('w7-mount-routing: ok');
