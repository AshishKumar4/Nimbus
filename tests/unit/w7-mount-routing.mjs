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
import { ROUTED_FILE_MAX, SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createWaveWriter } from '../../packages/platform/src/wave-writer.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
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

/**
 * Send `payload` as a process's binding does, in two halves: `between` runs
 * once the engine has taken the first (and placed what it names), before the
 * second.
 */
async function sendSplit(s, payload, between) {
  const bytes = new Uint8Array(await new Response(encodeWriteBatchStream(payload)).arrayBuffer());
  const half = bytes.byteLength >> 1;
  let pulls = 0;
  const stream = new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      if (pulls++ === 0) { controller.enqueue(bytes.slice(0, half)); return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
      between();
      controller.enqueue(bytes.slice(half));
      controller.close();
    },
  });
  return s.op({ op: 'writeBatchStream', args: [], cred: CRED_SESSION_USER, stream });
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
  let admits = 0;
  // Overtaken right before the file's call: nothing of it is written, nor anything after it.
  const result = await s.engine.as(CRED_SESSION_USER).writeStream(encodeWriteBatchStream(wave(file('shared/late', new Uint8Array(150_000).fill(9)), file('shared/after', 'a'))), {
    admit: () => { if (++admits >= 2) throw Object.assign(new Error('ESTALE: overtaken'), { code: 'ESTALE' }); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /ESTALE/);
  assert.equal(s.inMount(s.shared, '/late'), null, 'an overtaken wave wrote its file');
  assert.equal(s.inMount(s.shared, '/after'), null, 'an overtaken wave went on to its next record');
}

// A routed file is one whole-file writeFile, as the single call is: no
// partial content is ever there, the existing file's inode, mode and owner
// are kept, and a link at its name is followed. Red before: the file was
// written range by range (a reader saw it half written).
{
  const s = session();
  const body = new Uint8Array(200_000).map((_, index) => (index * 3) & 255);
  const calls = { writeFile: 0, writeRange: 0 };
  const counted = scripted({
    writeFile(self, path, data, options) { calls.writeFile++; return self.writeFile(path, data, options); },
    writeRange(self, path, offset, data) { calls.writeRange++; return self.writeRange(path, offset, data); },
  });
  s.files.vfs.mount('/counted', counted);
  counted.writeFile('/kept', enc.encode('old'));
  counted.chmod('/kept', 0o600);
  const inode = counted.stat('/kept').ino;
  counted.mkdir('/real');
  counted.writeFile('/real/target', enc.encode('old target'));
  counted.symlink('real/target', '/via-link');
  calls.writeFile = 0;
  const result = await s.send(wave(file('counted/kept', body), file('counted/via-link', body)));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(calls, { writeFile: 2, writeRange: 0 }, 'a file was not written in one call');
  assert.equal(counted.stat('/kept').mode & 0o7777, 0o600, 'the file lost its mode');
  assert.equal(counted.stat('/kept').ino, inode, 'the file was replaced by another inode');
  assert.deepEqual(new Uint8Array(counted.readFile('/kept')), body);
  assert.equal(counted.stat('/via-link', { follow: false }).type, 'symlink', 'the link at the name was replaced');
  assert.deepEqual(new Uint8Array(counted.readFile('/real/target')), body, 'the link was not followed');
}

// A record lands where it was placed: a directory that resolves elsewhere
// between the record's placement and its call (a link now, to another
// directory) refuses it (ESTALE) rather than writing there.
{
  const s = session();
  const moving = new MemoryVFS();
  s.files.vfs.mount('/moving', moving);
  moving.mkdir('/D');
  const result = await sendSplit(s, wave(file('moving/D/f', new Uint8Array(300_000).fill(2))), () => {
    // A peer moves the directory and leaves a link to it at its old name.
    moving.rename('/D', '/E');
    moving.symlink('E', '/D');
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.errno, 'ESTALE', result.error.message);
  assert.equal(s.inMount(moving, '/E/f'), null, 'the file went where the directory resolves now');
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

// A link is staged at the wave's own slot: another operation's slot (a
// name of the old pattern, or another wave's) is never touched, and the
// wave leaves no slot behind. Red before: a shared `.<name>.nimbus-wave`
// was removed as a leftover, whoever's it was.
{
  const s = session();
  s.shared.symlink('someone else\'s', '/.tool.nimbus-wave');
  const target = enc.encode('bin/tool.js');
  const result = await s.send({
    inodes: [{ path: 'shared/tool', parentPath: 'shared', kind: 'symlink', isDir: false, size: target.byteLength, mtime: 1, mode: 0o777, chunkCount: 1 }],
    chunks: [{ path: 'shared/tool', chunkId: 0, data: target }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(s.shared.readlink('/tool'), 'bin/tool.js');
  assert.equal(s.shared.readlink('/.tool.nimbus-wave'), 'someone else\'s', 'another operation\'s slot was removed');
  assert.deepEqual(s.shared.readdir('/').map((entry) => entry.name).filter((name) => name.includes('.nimbus-wave-')), [], 'the wave left its slot behind');
}

// A name placed on SQLite is placed again right before its commit: a peer
// that repoints its directory onto a mount in between refuses the wave
// (ESTALE), and no row is written beneath the mount. Red before: the
// cached placement committed the file to SQLite, hidden by the mount.
{
  const s = session();
  s.engine.as(CRED_SESSION_USER).mkdir('home/user/real');
  s.engine.as(CRED_SESSION_USER).symlink('real', 'home/user/alias');
  const result = await sendSplit(s, wave(file('home/user/alias/a', new Uint8Array(300_000).fill(4)), file('home/user/alias/b', 'b')), () => {
    // The engine has placed the file by now; a peer repoints the alias onto the mount.
    s.engine.as(CRED_SESSION_USER).unlink('home/user/alias');
    s.engine.as(CRED_SESSION_USER).symlink('/shared', 'home/user/alias');
  });
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
// A seed step that follows its name's link (exists, stat, readText, chown,
// chmod, writeFile, mkdir -p) is placed where the link leads. Red before:
// placed by its directory alone, /etc as a link to a mounted directory was
// the root's, so the engine followed it into its own directory beneath the
// mount point (absent: mkdir /etc EEXIST), and a link at /etc/hostname to a
// file on a mount was written beneath the mount point.
{
  const s = session();
  s.shared.mkdir('/accounts');
  s.kernel.symlink('/shared/accounts', 'etc');
  await seedBaseFilesystem(s.files);
  assert.match(dec.decode(s.shared.readFile('/accounts/passwd')), /^root:x:0:0/, '/etc/passwd did not reach the mount behind /etc');
  assert.deepEqual(s.sqliteNames('shared'), [], 'the seed wrote SQLite beneath the mount point');
}
{
  const s = session();
  s.kernel.mkdir('etc', { mode: 0o755 });
  s.kernel.symlink('/shared/hostname', 'etc/hostname');
  await seedBaseFilesystem(s.files);
  assert.equal(s.inMount(s.shared, '/hostname'), 'nimbus\n', 'the seed did not write through the link at /etc/hostname onto the mount');
  assert.deepEqual(s.sqliteNames('shared'), [], 'the seed wrote SQLite beneath the mount point');
}
{
  // Each of the project's names is placed, not only its root: a mount deep in it stops the seed.
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine);
  seedBaseFilesystem(engine);
  files.vfs.mount('/home/user/example-app/src', new MemoryVFS());
  const seeded = seedProject(engine);
  assert.equal(seeded.seeded, false, 'a project with a name on a mount was seeded');
  assert.equal(engine.as(CRED_KERNEL).exists('home/user/example-app/src'), false, 'the seed wrote SQLite beneath a mount');
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

// A file past ROUTED_FILE_MAX is refused before anything is touched, naming the limit.
{
  const s = session();
  s.shared.writeFile('/big', enc.encode('untouched'));
  const refused = await s.send(wave(file('shared/before', 'b'), file('shared/big', new Uint8Array(ROUTED_FILE_MAX + 1))));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.errno, 'ENOTSUP');
  assert.match(refused.error.message, new RegExp(`up to ${ROUTED_FILE_MAX} bytes`));
  assert.equal(s.inMount(s.shared, '/big'), 'untouched', 'a refused file touched its name');
  assert.equal(s.inMount(s.shared, '/before'), 'b');
  // One at the limit is written, in one call.
  const at = await s.send(wave(file('shared/at-limit', new Uint8Array(ROUTED_FILE_MAX).fill(7))));
  assert.equal(at.ok, true, JSON.stringify(at.error));
  assert.equal(s.shared.readFile('/at-limit').byteLength, ROUTED_FILE_MAX);
}

// Three waves at once, each with a file at ROUTED_FILE_MAX on a mount: a
// mounted record is admitted with its whole size reserved, so an admitted
// record always finishes. Red before: each wave held its file's chunks as
// they came, all three held most of the shared write credit between them,
// and each waited for more before its file-end, for good.
{
  const s = session();
  const frames = await Promise.all([0, 1, 2].map(async (i) => new Uint8Array(
    await new Response(encodeWriteBatchStream(wave(file(`shared/whole-${i}`, new Uint8Array(ROUTED_FILE_MAX).fill(i + 1))))).arrayBuffer(),
  )));
  // Each producer hands over 60% of its wave, and the rest once all three
  // were asked for it (or 300 ms on, when one never is).
  let asked = 0;
  const allAsked = Promise.withResolvers();
  const streams = frames.map((bytes) => {
    const cut = Math.floor(bytes.byteLength * 0.6);
    let pulls = 0;
    return new ReadableStream({
      type: 'bytes',
      async pull(controller) {
        if (pulls++ === 0) { controller.enqueue(bytes.slice(0, cut)); return; }
        if (++asked === 3) allAsked.resolve();
        await Promise.race([allAsked.promise, new Promise((resolve) => setTimeout(resolve, 300))]);
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
  });
  const sent = Promise.all(streams.map((stream) => s.op({ op: 'writeBatchStream', args: [], cred: CRED_SESSION_USER, stream })));
  let timer;
  const stuck = new Promise((resolve) => { timer = setTimeout(() => resolve('stuck'), 10_000); });
  const results = await Promise.race([sent, stuck]);
  clearTimeout(timer);
  assert.notEqual(results, 'stuck', 'three waves, each holding part of a mounted file, waited on each other for good');
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result.error));
  for (const i of [0, 1, 2]) assert.deepEqual(s.shared.readFile(`/whole-${i}`), new Uint8Array(ROUTED_FILE_MAX).fill(i + 1));
}

// A cached route carries the revision its lookup saw: after anything
// commits, the next record's directory is looked up again. Red before: a
// placement made from a route resolved before a peer repointed the alias
// was dated now, so its commit never rechecked it, and the file went to the
// alias's old target.
{
  const s = session();
  s.engine.as(CRED_SESSION_USER).mkdir('home/user/real');
  s.engine.as(CRED_SESSION_USER).symlink('real', 'home/user/alias');
  let repointed = false;
  // Files go in the wave's order: a (SQLite), then one on /peer, whose call repoints the alias, then b.
  const peer = scripted({
    writeFile(self, path, data, options) {
      const written = self.writeFile(path, data, options);
      if (!repointed) {
        repointed = true;
        s.engine.as(CRED_SESSION_USER).unlink('home/user/alias');
        s.engine.as(CRED_SESSION_USER).symlink('/shared', 'home/user/alias');
      }
      return written;
    },
  });
  s.files.vfs.mount('/peer', peer);
  const result = await s.send(wave(file('home/user/alias/a', 'a'), file('peer/x', 'x'), file('home/user/alias/b', 'b')));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(s.inSqlite('home/user/real/a'), 'a');
  assert.equal(s.inMount(s.shared, '/b'), 'b', 'b went where the alias pointed before it was repointed');
  assert.equal(s.inSqlite('home/user/real/b'), null);
}

// A directory above a mount point is the namespace's: removing it is EBUSY
// and a file at it EISDIR, before anything commits. Red before: the engine
// removed the session's directory under the mount point's parent.
{
  const s = session();
  s.engine.as(CRED_SESSION_USER).mkdir('home/user/proj');
  s.engine.as(CRED_SESSION_USER).writeFile('home/user/proj/kept', 'k');
  s.files.vfs.mount('/home/user/proj/pc', new MemoryVFS());
  const removal = await s.send({ ...wave(), deletePaths: ['home/user/proj'] });
  assert.equal(removal.ok, false);
  assert.equal(removal.error.errno, 'EBUSY', removal.error.message);
  assert.equal(s.inSqlite('home/user/proj/kept'), 'k', 'a directory above a mount point was removed');
  const over = await s.send(wave(file('home/user/proj', 'x')));
  assert.equal(over.ok, false);
  assert.equal(over.error.errno, 'EISDIR', over.error.message);
}

// An error binding a record fails the wave at once: nothing waits on it.
// Red before: a file larger than the wave's credit whose binding failed
// after its first chunk left the rest undrained, and the wave hung.
{
  const s = session();
  // The backend goes away once the file's first write lands.
  const failing = scripted({
    writeFile(self, path, data, options) { self.__gone = true; return self.writeFile(path, data, options); },
    stat(self, path, options) {
      if (self.__gone) throw Object.assign(new Error('EIO: the backend is gone'), { code: 'EIO' });
      return self.stat(path, options);
    },
  });
  s.files.vfs.mount('/failing', failing);
  const outcome = await Promise.race([
    s.send(wave(file('failing/f', new Uint8Array(12 * 1024 * 1024)), file('home/user/after', 'a'))),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 10_000)),
  ]);
  assert.notEqual(outcome, 'hung', 'a record whose binding failed hung the wave');
  assert.equal(outcome.ok, false);
  assert.equal(s.inSqlite('home/user/after'), null);
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

// ── P4b review B ──
/** Ops (a process's v4 records) as its binding sends them. */
const ops = (...list) => ({ inodes: [], chunks: [], ops: list });

// 4: a rename, truncate or attribute change under a mount is the mount's.
// Red before: each was applied to SQLite, under the mount point (ENOENT, or a
// change the mount hides), whatever the namespace has there.
{
  const s = session();
  s.shared.writeFile('/t', enc.encode('abcdef'));
  s.shared.writeFile('/m', enc.encode('m'));
  s.shared.writeFile('/a', enc.encode('moved'));
  const result = await s.send(ops(
    { type: 'truncate', path: 'shared/t', size: 2 },
    { type: 'setattr', path: 'shared/m', attrs: { mode: 0o600 } },
    { type: 'rename', from: 'shared/a', to: 'shared/b' },
  ));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(s.inMount(s.shared, '/t'), 'ab', 'the truncate was not the mount\'s');
  assert.equal(s.shared.stat('/m').mode & 0o777, 0o600, 'the mode change was not the mount\'s');
  assert.equal(s.inMount(s.shared, '/a'), null);
  assert.equal(s.inMount(s.shared, '/b'), 'moved', 'the rename was not the mount\'s');
  assert.deepEqual(s.sqliteNames('shared'), [], 'a change was written under the mount point');
}
// A rename between this filesystem and a mount is EXDEV, as rename(2) across mounts is; nothing moves.
{
  const s = session();
  const seeded = await s.send(wave(file('home/user/x', 'x')));
  assert.equal(seeded.ok, true);
  const result = await s.send(ops({ type: 'rename', from: 'home/user/x', to: 'shared/x' }));
  assert.equal(result.ok, false);
  assert.equal(result.error.errno, 'EXDEV', JSON.stringify(result.error));
  assert.equal(s.inSqlite('home/user/x'), 'x');
  assert.equal(s.inMount(s.shared, '/x'), null);
}

// 5: rm -r of a mounted directory is checked: what it kept or failed on is the call's error.
// Red before: the call answered as done, with names still there.
{
  const s = session();
  const stubborn = scripted({
    removeRecursive: (_self, path) => ({ removed: [], kept: [path + '/locked'], failures: [] }),
  });
  s.files.vfs.mount('/stubborn', stubborn);
  stubborn.mkdir('/d');
  const result = await s.send(ops({ type: 'call', call: { call: 'rm', path: 'stubborn/d', recursive: true } }));
  assert.equal(result.ok, false, 'an rm -r that kept a name was answered as done');
  assert.match(result.error.message, /kept 1 \(\/stubborn\/d\/locked\)/);
}

// 10: a data call's bytes stay charged while it is gathered, and a call past DATA_CALL_MAX is refused before its bytes are read.
// Red before: each chunk's credit was given back as it was copied out, so
// gathered calls held memory no credit covered; any size was gathered whole.
{
  const s = session();
  const { DATA_CALL_MAX } = await import('../../packages/core/src/vfs/sqlite-vfs.ts');
  const credits = s.engine.writeStreamCredits;
  let peak = 0;
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(7);
  const watch = setInterval(() => { peak = Math.max(peak, credits.stats.current); }, 0);
  const sent = sendSplit(s, ops({ type: 'call', call: { call: 'writeFile', path: 'home/user/big', mode: 0o644, data: bytes } }), () => {
    peak = Math.max(peak, credits.stats.current);
  });
  const result = await sent;
  clearInterval(watch);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(peak >= bytes.byteLength, `a data call of ${bytes.byteLength} bytes was gathered under ${peak} bytes of credit`);
  assert.equal(credits.stats.current, 0, 'a made call kept its credit');
  const big = await s.send(ops({ type: 'call', call: { call: 'writeFile', path: 'home/user/huge', mode: 0o644, data: new Uint8Array(DATA_CALL_MAX + 1) } }));
  assert.equal(big.ok, false);
  assert.equal(big.error.errno, 'EINVAL', JSON.stringify(big.error));
  assert.equal(s.inSqlite('home/user/huge'), null);
}

// 9 (recheck): a call's umask is the one it is made with on a mount too.
// Red before: the routed data call dropped it, mkdir went with the wave's
// credential, and a mount stores the mode it is given: 0o644 and 0o755
// after umask(0o077).
{
  const s = session();
  const result = await s.send(ops(
    { type: 'call', call: { call: 'writeFile', path: 'shared/private', mode: 0o666, umask: 0o077, data: enc.encode('p') } },
    { type: 'call', call: { call: 'mkdir', path: 'shared/secret', mode: 0o777, umask: 0o077 } },
    { type: 'call', call: { call: 'open', path: 'shared/opened', mode: 0o666, umask: 0o077, create: true } },
  ));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(s.shared.stat('/private').mode & 0o777, 0o600, 'a mounted file ignored its call\'s umask');
  assert.equal(s.shared.stat('/secret').mode & 0o777, 0o700, 'a mounted directory ignored its call\'s umask');
  assert.equal(s.shared.stat('/opened').mode & 0o777, 0o600, 'a mounted open ignored its call\'s umask');
  assert.deepEqual(s.sqliteNames('shared'), []);
}

// 10 (recheck): concurrent waves of gathered calls never wait on credit while holding their own.
// Red before: each wave queued calls of 512 KiB (under the 1 MiB group
// threshold, so not yet made, their credit held), and its next 3.5 MiB call
// waited on the 8 MiB pool the other waves' queued calls filled: every wave
// waited, for good.
{
  const s = session();
  const piece = (n) => new Uint8Array(n).fill(1);
  const waves = [];
  for (let w = 0; w < 4; w++) {
    const list = [];
    for (let i = 0; i < 3; i++) list.push({ type: 'call', call: { call: 'writeFile', path: `home/user/c${w}-${i}`, mode: 0o644, data: piece(512 * 1024) } });
    list.push({ type: 'call', call: { call: 'writeFile', path: `home/user/c${w}-big`, mode: 0o644, data: piece(3.5 * 1024 * 1024) } });
    waves.push(s.send(ops(...list)));
  }
  const outcome = await Promise.race([Promise.all(waves).then((results) => results), new Promise((resolve) => setTimeout(() => resolve('stuck'), 20_000))]);
  assert.notEqual(outcome, 'stuck', 'concurrent waves of gathered calls deadlocked on credit');
  for (const result of outcome) assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(s.engine.writeStreamCredits.stats.current, 0, 'credit was kept after the waves');
}

console.log('w7-mount-routing: ok');
