#!/usr/bin/env bun
/**
 * A WASI process as a delegation's holder (P4a), through the resident
 * filesystem over a real session (SqliteVFS, ProcessFiles, its bridge):
 *   - a run that makes a directory and files in its project decides them
 *     locally (no round trip each) once it holds the subtree, and the
 *     session has them, numbered as the process saw them, once its
 *     filesystem client has sent the log;
 *   - another caller's read waits for the holder to send (share), its write
 *     for the holder to send and give the subtree up (revoke), and the
 *     holder writes through after;
 *   - the home directory itself is never held, and a full set widens;
 *   - the end of the run sends everything and gives every subtree back.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { MAX_DELEGATIONS_PER_PROCESS, sqlJournal } from '../../packages/core/src/_shared/process-fs-client.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

/**
 * A process over a real session. `view`: its store is a view as a resident's
 * is, what it read of a name kept as read until a barrier reads it again
 * (`view.barrier` runs after); else the store reads the session at every
 * call. `acquired`: what the session's grant waits for. `grantBytes`: the
 * storage a grant reserves.
 */
function session({ grantInos, journal, gate, refuse, view, acquired, grantBytes, budget } = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  for (const dir of ['home/user/proj', 'home/user/other', 'tmp']) kernel.mkdir(dir, { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/proj', 1000, 1000);
  kernel.chown('home/user/other', 1000, 1000);
  kernel.chmod('tmp', 0o1777);
  for (let index = 0; index < 10; index++) {
    kernel.mkdir(`home/user/proj/d${index}`);
    kernel.chown(`home/user/proj/d${index}`, 1000, 1000);
  }
  const filesystem = new ProcessFiles(engine);
  const bridge = filesystem.bind({ pid: 7, cred: user });
  // The process's store, coherent with the session at every call: reads as the process does.
  const entryOf = (stat, target = null) => ({
    type: stat.type, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, atime: stat.atime, mtime: stat.mtime,
    ctime: stat.ctime, mode: stat.mode, uid: stat.uid, gid: stat.gid, revision: stat.revision ?? 0, target,
  });
  const device = bridge.stat('/').dev;
  const entryNow = (key) => {
    try {
      const stat = bridge.stat('/' + key, { followSymlinks: false });
      return stat === null ? null : entryOf(stat, view && stat.type === 'symlink' ? bridge.readlink('/' + key) : null);
    } catch { return null; }
  };
  const contentNow = (key) => { try { return bridge.readFile('/' + key) ?? undefined; } catch { return undefined; } };
  const cursorNow = () => ({ epoch: engine.epoch, rev: engine.revision() });
  const seen = new Map();
  let cursor = cursorNow();
  const viewed = (key) => {
    if (!seen.has(key)) seen.set(key, { entry: entryNow(key), content: contentNow(key) });
    return seen.get(key);
  };
  const store = {
    device,
    cred: user,
    ready: () => true,
    entry: (key) => (view ? viewed(key).entry : entryNow(key)),
    children: (key) => {
      try { return bridge.readdir('/' + key); } catch { return undefined; }
    },
    list: async () => true,
    lookup: async () => true,
    listTree: async () => false,
    content: (key) => (view ? viewed(key).content : contentNow(key)),
    fill: async (key) => bridge.readFile('/' + key),
    cursor: () => (view ? cursor : cursorNow()),
    barrier: async () => {
      if (!view) return true;
      for (const key of seen.keys()) seen.set(key, { entry: entryNow(key), content: contentNow(key) });
      cursor = cursorNow();
      await view.barrier?.();
      return true;
    },
    // `budget`: the bytes the process may hold outside the store, counted as they are taken and given back.
    reserve: (bytes) => {
      if (budget === undefined) return true;
      if (budget.used + bytes > budget.limit) return false;
      budget.used += bytes;
      return true;
    },
    release: (bytes) => { if (budget !== undefined) budget.used -= bytes; },
  };
  const waves = [];
  // In process: nothing between the client and the session loses a call, so it fences nothing.
  const processSession = {
    openWriter: async () => null,
    writeBatchStream: async (stream, _fence, owner) => {
      if (gate) await gate;
      // A refusal the test asks for: the whole wave refused, as a full store refuses it.
      if (refuse?.()) {
        await new Response(stream).arrayBuffer();
        return { ok: false, committedOps: 0, committedPathCount: 0, committedGroupSequence: 0, receipts: [], error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'publish', message: 'ENOSPC: no space left on device', errno: 'ENOSPC' } };
      }
      const result = await bridge.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner });
      waves.push(result);
      return result;
    },
    grants: {
      acquire: async (path, delegate) => {
        await acquired;
        return bridge.acquireExclusiveMutation(path, { delegate: grantBytes === undefined ? delegate : { ...delegate, bytes: grantBytes } });
      },
      release: async (owner) => { bridge.releaseExclusiveMutation(owner); },
      awaitRecall: (owner, waitMs) => bridge.awaitRecall(owner, waitMs),
      recalled: async (owner, kind) => { bridge.recalled(owner, kind); },
    },
  };
  // A subtree is taken at its first mutation here, as P4a did.
  const fs = residentFilesystem(bridge, store, {
    session: processSession,
    grantAfter: 1,
    ...(grantInos === undefined ? {} : { grantInos }),
    ...(journal === undefined ? {} : { journal }),
    isHomeRoot: (key) => key.startsWith('home/') && !key.slice(5).includes('/'),
  });
  return { engine, kernel, filesystem, fs, waves };
}

/** What a run does: write `text` to a new file at `path`. */
async function create(fs, path, text) {
  const handle = await fs.open(path, { write: true, create: true, truncate: true, mode: 0o644 });
  await fs.write(handle.id, null, enc.encode(text));
  await fs.close(handle.id);
}

// ── Made locally, sent as one wave, numbered as the process saw it ──
{
  const s = session();
  await s.fs.mkdir('/home/user/proj/out', { mode: 0o755 });
  for (let index = 0; index < 20; index++) await create(s.fs, `/home/user/proj/out/f${index}.txt`, `file ${index}\n`);
  const seen = await s.fs.stat('/home/user/proj/out/f3.txt');
  assert.equal(seen.size, 'file 3\n'.length);
  assert.deepEqual((await s.fs.readdir('/home/user/proj/out')).map((entry) => entry.name).length, 20);
  const stats = s.fs.stats();
  assert.equal(stats.delegated.open ?? 0, 0, `the creates went to the session: ${JSON.stringify(stats.delegated)}`);
  assert.equal(stats.delegated.write ?? 0, 0);
  // Observed: everything sent, each wave taken.
  await s.fs.flush();
  assert.ok(s.waves.length > 0);
  for (const wave of s.waves) assert.equal(wave.ok, true, JSON.stringify(wave.error));
  // The run ends: what it held is given back, and anyone reads it as decided.
  await s.fs.settle();
  assert.equal(s.filesystem.delegations.size, 0, 'the run ended holding a subtree');
  const stored = s.kernel.stat('home/user/proj/out/f3.txt');
  assert.equal(stored.ino, seen.ino, 'the session numbered the file differently from what the process saw');
  assert.equal(stored.uid, 1000);
  assert.equal(stored.mode & 0o777, 0o644);
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/out/f3.txt')), 'file 3\n');
}

// A changed umask is captured by each create, not by the subtree's grant.
{
  const s = session();
  await s.fs.mkdir('/home/user/proj/modes', { mode: 0o777, umask: 0 });
  const cases = [
    { name: 'private', umask: 0o077, expected: 0o600 },
    { name: 'public', umask: 0, expected: 0o666 },
    { name: 'group', umask: 0o007, expected: 0o660 },
    { name: 'normal', umask: 0o022, expected: 0o644 },
  ];
  for (const { name, umask, expected } of cases) {
    const path = `/home/user/proj/modes/${name}`;
    const handle = await s.fs.open(path, { write: true, create: true, exclusive: true, mode: 0o666, umask });
    await s.fs.write(handle.id, null, enc.encode(name));
    await s.fs.close(handle.id);
    assert.equal((await s.fs.stat(path)).mode & 0o777, expected, `${name}: the holder sees the live mask`);
  }
  assert.equal(s.fs.stats().delegated.open ?? 0, 0, 'changing masks adds no per-create round trip');
  await s.fs.settle();
  assert.equal(s.kernel.stat('home/user/proj/modes').mode & 0o777, 0o777);
  for (const { name, expected } of cases) {
    assert.equal(s.kernel.stat(`home/user/proj/modes/${name}`).mode & 0o777, expected, `${name}: the logged mask survives later changes`);
    assert.equal(s.kernel.readFileString(`home/user/proj/modes/${name}`), name);
  }
}

// ── A grant renewed mid-run (its range spent): every file lands, grown or not ──
{
  const s = session({ grantInos: 8 });
  await s.fs.mkdir('/home/user/proj/many', { mode: 0o755 });
  const big = 'y'.repeat(6000);
  for (let index = 0; index < 48; index++) {
    const handle = await s.fs.open(`/home/user/proj/many/f${index}.txt`, { write: true, create: true, truncate: true, mode: 0o644 });
    await s.fs.write(handle.id, null, enc.encode(`head ${index}\n`));
    // Grown past its first buffer while its grant may be closing.
    await s.fs.write(handle.id, null, enc.encode(big));
    await s.fs.close(handle.id);
  }
  await s.fs.settle();
  for (const index of [0, 7, 8, 31, 47]) {
    assert.equal(dec.decode(s.kernel.readFile(`home/user/proj/many/f${index}.txt`)), `head ${index}\n${big}`);
  }
}

// ── Another caller's read waits for the holder (share), its write for the
//    holder to give the subtree up (revoke); the holder writes through after ──
{
  const s = session();
  await create(s.fs, '/home/user/proj/d1/notes.txt', 'decided');
  assert.equal(s.filesystem.delegations.size, 1);
  const read = await withRecall(() => s.kernel.readFileString('home/user/proj/d1/notes.txt'));
  assert.equal(read, 'decided', "a reader did not wait for the holder's send");
  await withRecall(() => s.kernel.writeFile('home/user/proj/d1/notes.txt', 'theirs'));
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/d1/notes.txt')), 'theirs');
  // Given up; the holder may take it again for its next write, and a reader waits for that one too.
  await create(s.fs, '/home/user/proj/d1/after.txt', 'after the revoke');
  assert.equal(await withRecall(() => s.kernel.readFileString('home/user/proj/d1/after.txt')), 'after the revoke');
  await s.fs.settle();
}

// ── The home directory itself is never held: a file made in it is the session's ──
{
  const s = session();
  await create(s.fs, '/home/user/top.txt', 'in home');
  assert.equal(s.filesystem.delegations.size, 0, 'the home directory was delegated');
  // Written through the client: in the session once sent (what an output of the process waits for).
  await s.fs.flush();
  assert.equal(dec.decode(s.kernel.readFile('home/user/top.txt')), 'in home');
  await s.fs.settle();
}

// ── A full set widens two subtrees to their common ancestor ──
{
  const s = session();
  for (let index = 0; index <= MAX_DELEGATIONS_PER_PROCESS; index++) await create(s.fs, `/home/user/proj/d${index}/x.txt`, `x${index}`);
  assert.ok(s.filesystem.delegations.size <= MAX_DELEGATIONS_PER_PROCESS, `${s.filesystem.delegations.size} subtrees held`);
  await s.fs.settle();
  for (let index = 0; index <= MAX_DELEGATIONS_PER_PROCESS; index++) {
    assert.equal(dec.decode(s.kernel.readFile(`home/user/proj/d${index}/x.txt`)), `x${index}`);
  }
}

// ── A rename and an unlink decided here land as decided ──
{
  const s = session();
  await create(s.fs, '/home/user/proj/d2/a.txt', 'A');
  await s.fs.rename('/home/user/proj/d2/a.txt', '/home/user/proj/d2/b.txt');
  await create(s.fs, '/home/user/proj/d2/c.txt', 'C');
  await s.fs.unlink('/home/user/proj/d2/c.txt');
  assert.equal(await s.fs.stat('/home/user/proj/d2/a.txt'), null);
  await s.fs.settle();
  assert.equal(s.kernel.exists('home/user/proj/d2/a.txt'), false);
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/d2/b.txt')), 'A');
  assert.equal(s.kernel.exists('home/user/proj/d2/c.txt'), false);
}

/** Resolves once `ready()` answers, polling. */
async function until(ready, what) {
  for (let i = 0; i < 400; i++) {
    const value = ready();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never: ${what}`);
}

// ── A copy decides with the view's bytes only where the view vouches for them ──
// The source cached, a peer rewrites it after the view's last barrier and
// before the grant is recorded: the session copies what it has, the rewrite.
// Red before: the holder copied the view's bytes, the source before it.
{
  const grant = Promise.withResolvers();
  let afterBarrier = null;
  const s = session({ view: { barrier: () => afterBarrier?.() }, acquired: grant.promise });
  s.kernel.writeFile('home/user/proj/d3/src.txt', enc.encode('OLD'));
  s.kernel.chown('home/user/proj/d3/src.txt', 1000, 1000);
  assert.equal(dec.decode(await s.fs.readFile('/home/user/proj/d3/src.txt')), 'OLD');
  // The session's: the subtree is asked for, and its grant waits.
  await s.fs.copyFile('/home/user/proj/d3/src.txt', '/home/user/proj/d3/first.txt');
  afterBarrier = async () => {
    afterBarrier = null;
    s.kernel.writeFile('home/user/proj/d3/src.txt', enc.encode('NEW'));
    grant.resolve();
    await until(() => s.filesystem.delegations.size === 1, 'the grant');
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await s.fs.copyFile('/home/user/proj/d3/src.txt', '/home/user/proj/d3/second.txt');
  await s.fs.settle();
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/d3/first.txt')), 'OLD');
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/d3/second.txt')), 'NEW', 'the copy took the view\'s bytes from before the grant');
}

// ── A decision reads only rows its view has as the session does, or its own ──
// A peer makes the destination, not writable to the process, after the
// view's last barrier and before the grant; the process then makes its own
// source under that grant. The copy is the session's, which refuses it.
// Red before: the holder judged the destination by the view's stale
// absence and answered the copy, which the session then refused.
{
  const grant = Promise.withResolvers();
  let afterBarrier = null;
  const s = session({ view: { barrier: () => afterBarrier?.() }, acquired: grant.promise });
  // Asked for once: the process's view has it absent.
  assert.equal(await s.fs.stat('/home/user/proj/d7/dst.txt'), null);
  // The session's: the subtree is asked for, and its grant waits.
  await create(s.fs, '/home/user/proj/d7/warm.txt', 'w');
  afterBarrier = async () => {
    afterBarrier = null;
    s.kernel.writeFile('home/user/proj/d7/dst.txt', enc.encode('THEIRS'), { mode: 0o444 });
    grant.resolve();
    await until(() => s.filesystem.delegations.size === 1, 'the grant');
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await create(s.fs, '/home/user/proj/d7/src.txt', 'MINE');
  await assert.rejects(async () => s.fs.copyFile('/home/user/proj/d7/src.txt', '/home/user/proj/d7/dst.txt'), { code: 'EACCES' });
  await s.fs.settle().catch(() => {});
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/d7/dst.txt')), 'THEIRS');
}

// ── A copy is decided only where every name its walks cross is guarded ──
// The destination a link outside the held subtree names, into it: a peer
// retargets the link (no grant recalled), and the copy lands where the
// caller's name leads now. Red before: the holder wrote the old target.
{
  const s = session({ view: {} });
  s.kernel.writeFile('home/user/proj/d5/moved.txt', enc.encode('THEIRS'));
  s.kernel.chown('home/user/proj/d5/moved.txt', 1000, 1000);
  s.kernel.symlink('/home/user/proj/d4/target.txt', 'home/user/other/link');
  await create(s.fs, '/home/user/proj/d4/src.txt', 'MINE');
  await until(() => s.filesystem.delegations.size === 1, 'the grant');
  await create(s.fs, '/home/user/proj/d4/src.txt', 'MINE');
  await s.fs.flush();
  assert.equal(await s.fs.readlink('/home/user/other/link'), '/home/user/proj/d4/target.txt');
  s.kernel.unlink('home/user/other/link');
  s.kernel.symlink('/home/user/proj/d5/moved.txt', 'home/user/other/link');
  await s.fs.copyFile('/home/user/proj/d4/src.txt', '/home/user/other/link');
  await s.fs.settle();
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/d5/moved.txt')), 'MINE', 'the copy did not land where the link leads');
  assert.equal(s.kernel.exists('home/user/proj/d4/target.txt'), false, 'the copy wrote the link\'s old target');
}

// ── A decided copy's bytes are drawn from what its grant reserved ──
// The grant holds the source and one copy: the second copy is the session's.
// Red before: every copy was held here, past the grant's reservation.
{
  const s = session({ grantBytes: 13_000 });
  const big = 'b'.repeat(6000);
  await create(s.fs, '/home/user/proj/d6/warm.txt', 'w');
  await until(() => s.filesystem.delegations.size === 1, 'the grant');
  await create(s.fs, '/home/user/proj/d6/big.bin', big);
  const before = s.fs.stats().delegated.copyFile ?? 0;
  await s.fs.copyFile('/home/user/proj/d6/big.bin', '/home/user/proj/d6/c1.bin');
  assert.equal((s.fs.stats().delegated.copyFile ?? 0) - before, 0, 'a copy the grant has room for went to the session');
  await s.fs.copyFile('/home/user/proj/d6/big.bin', '/home/user/proj/d6/c2.bin');
  assert.equal((s.fs.stats().delegated.copyFile ?? 0) - before, 1, 'a copy past the grant\'s reservation was held here');
  await s.fs.settle();
  for (const name of ['c1.bin', 'c2.bin']) assert.equal(dec.decode(s.kernel.readFile(`home/user/proj/d6/${name}`)), big);
}

// ── A synchronous write no held subtree decides takes the process's budget ──
// Decided provisionally, its bytes are charged to the store's budget; one the
// budget has no room for is refused ENOSPC before anything changes; and what
// the cells took goes back once the view has them. Past the client's cap on
// synchronous bytes it is refused as the client refuses one (ENOMEM).
{
  const budget = { used: 0, limit: 64 * 1024 };
  // No grant comes: the writes stay provisional.
  const s = session({ budget, acquired: new Promise(() => {}) });
  const sync = s.fs.synchronous;
  await s.fs.readdir('/home/user/other');
  sync.writeFile('/home/user/other/a.bin', new Uint8Array(20 * 1024));
  assert.ok(budget.used >= 20 * 1024, `the write took ${budget.used} bytes of the budget`);
  assert.throws(() => sync.writeFile('/home/user/other/b.bin', new Uint8Array(60 * 1024)), { code: 'ENOSPC' });
  assert.equal(sync.stat('/home/user/other/b.bin'), null, 'a refused write changed the view');
  await s.fs.flush();
  // The view has it once a barrier lands: what its cell took goes back.
  s.fs.inbound();
  assert.equal((await s.fs.stat('/home/user/other/a.bin')).size, 20 * 1024);
  assert.equal(budget.used, 0, `${budget.used} bytes still taken after the view had them`);
}
{
  const s = session();
  const sync = s.fs.synchronous;
  await s.fs.readdir('/home/user/other');
  const chunk = new Uint8Array(1024 * 1024);
  let refused;
  let written = 0;
  for (; written < 300 && refused === undefined; written++) {
    try { sync.writeFile(`/home/user/other/f${written}.bin`, chunk); } catch (error) { refused = error; }
  }
  assert.equal(refused?.code, 'ENOMEM', `${written} synchronous MiB without a yield: ${refused?.message ?? 'all answered'}`);
  assert.equal(sync.stat(`/home/user/other/f${written - 1}.bin`), null, 'the refused write changed the view');
  assert.equal(sync.stat(`/home/user/other/f${written - 2}.bin`).size, chunk.byteLength);
  // Once it yields, what it logged is sent, and it writes again.
  await s.fs.flush();
  sync.writeFile(`/home/user/other/after.bin`, chunk);
}

// ── A caller that cannot wait: its provisional decisions (provisional.ts) ──
// The session grants no subtree here (it refuses each asked for, as one
// another holds): what the process decides synchronously outside a held
// subtree is answered from its view, logged as it made it, and the session's
// to refuse. `control`: the session's waves wait while it holds them, and are
// refused or accepted in turn as `verdicts` says (true: refused).
function provisionalSession(options = {}) {
  const control = { held: false, entered: 0, verdicts: [], acquires: 0 };
  let opened = Promise.withResolvers();
  control.hold = () => { control.held = true; control.entered = 0; opened = Promise.withResolvers(); };
  control.open = () => { control.held = false; opened.resolve(); };
  const s = session({
    ...options,
    acquired: { then: (_resolve, reject) => { control.acquires++; reject(Object.assign(new Error('EBUSY: another holds it'), { code: 'EBUSY' })); } },
    gate: { then: (resolve, reject) => { control.entered++; return (control.held ? opened.promise : Promise.resolve()).then(resolve, reject); } },
    refuse: () => control.verdicts.shift() ?? false,
  });
  return { s, control, sync: s.fs.synchronous };
}
const OTHER = '/home/user/other';
const other = (name) => `${OTHER}/${name}`;
/** A file the session has, the process's (uid 1000), its bytes resident in the view. */
async function resident(s, name, text) {
  s.kernel.writeFile(`home/user/other/${name}`, enc.encode(text));
  s.kernel.chown(`home/user/other/${name}`, 1000, 1000);
  await s.fs.readdir(OTHER);
  assert.equal(dec.decode(await s.fs.readFile(other(name))), text);
}
/** The view brought to the session's: a barrier taken, what was answered before it retired. */
async function caughtUp(s) {
  await s.fs.flush().catch(() => {});
  s.fs.inbound();
  await s.fs.stat(OTHER);
}

// A descriptor is its file's: once its name leads to another file, it reads
// and changes nothing of that one (ESTALE). Red before: an inode descriptor
// read the name's new file's row, and fchmod changed the new file.
{
  const { s, sync } = provisionalSession();
  await resident(s, 'id.txt', 'AAAA');
  const fd = sync.open(other('id.txt'), { read: true }).id;
  s.kernel.unlink('home/user/other/id.txt');
  s.kernel.writeFile('home/user/other/id.txt', enc.encode('BBBBBBBB'));
  s.kernel.chown('home/user/other/id.txt', 1000, 1000);
  assert.throws(() => sync.read(fd, 0, 16), { code: 'ESTALE' });
  const before = s.kernel.stat('home/user/other/id.txt').mode;
  assert.throws(() => sync.fchmod(fd, 0o600), { code: 'ESTALE' });
  assert.equal(s.kernel.stat('home/user/other/id.txt').mode, before, 'a descriptor changed another file\'s mode');
  sync.close(fd);
}

// The overlay is the log: a refused operation leaves it, and what remains is
// folded again from the view's bytes; what is logged is what the process
// did, by its descriptors. Red before: the refused append stayed in the cell,
// and the session was sent the cell's snapshot.
{
  const { s, control, sync } = provisionalSession();
  await resident(s, 'f.txt', 'ab');
  const appender = sync.open(other('f.txt'), { write: true, append: true }).id;
  const writer = sync.open(other('f.txt'), { read: true, write: true }).id;
  await s.fs.flush();
  control.hold();
  sync.write(appender, null, enc.encode('X'));
  const sent = s.fs.flush().catch(() => {});
  await until(() => control.entered > 0, 'the append on its way');
  sync.write(writer, 0, enc.encode('Y'));
  assert.equal(dec.decode(sync.readFile(other('f.txt'))), 'YbX');
  control.verdicts.push(true);
  control.open();
  await sent;
  await s.fs.flush().catch(() => {});
  assert.equal(dec.decode(sync.readFile(other('f.txt'))), 'Yb', 'a refused append stayed in the view');
  assert.equal(dec.decode(s.kernel.readFile('home/user/other/f.txt')), 'Yb');
  sync.close(appender);
  sync.close(writer);
}

// A file's first change by a descriptor is what its name shows: a stat by
// name and the descriptor's agree. Red before: the name kept the view's size.
{
  const { s, sync } = provisionalSession();
  await resident(s, 'g.txt', 'ab');
  const fd = sync.open(other('g.txt'), { write: true }).id;
  sync.write(fd, 2, enc.encode('cd'));
  assert.equal(Number(sync.stat(other('g.txt')).size), 4);
  assert.equal(Number(sync.fstat(fd).size), 4);
  sync.close(fd);
}

// Once the view has the session's version of a file this process changed,
// that version is what every descriptor of it reads: a peer's rewrite after
// it, too. Red before: an open descriptor kept the process's bytes.
{
  const { s, sync } = provisionalSession();
  await resident(s, 'r.txt', 'OLD');
  const fd = sync.open(other('r.txt'), { read: true }).id;
  sync.writeFile(other('r.txt'), enc.encode('OWN'));
  assert.equal(dec.decode(sync.read(fd, 0, 16)), 'OWN');
  await caughtUp(s);
  s.kernel.writeFile('home/user/other/r.txt', enc.encode('THEIRS'));
  s.fs.inbound();
  await s.fs.stat(other('r.txt'));
  assert.equal(dec.decode(sync.read(fd, 0, 16)), 'THEIRS', 'the descriptor kept the process\'s bytes after the view had the session\'s');
  sync.close(fd);
}

// fsync of a descriptor the process closed is EBADF. Red before: answered.
{
  const { s, sync } = provisionalSession();
  await resident(s, 'c.txt', 'c');
  const fd = sync.open(other('c.txt'), { read: true }).id;
  sync.close(fd);
  assert.throws(() => sync.fsync(fd), { code: 'EBADF' });
}

// A change a caller that cannot wait does not make counts toward taking no
// subtree. Red before: a refused mkdir asked for a grant.
{
  const { s, control, sync } = provisionalSession();
  s.kernel.mkdir('home/user/other/d');
  await s.fs.readdir(OTHER);
  await s.fs.stat(other('d'));
  const before = control.acquires;
  assert.throws(() => sync.mkdir(other('d')), { code: 'EEXIST' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(control.acquires, before, 'a refused change asked for a grant');
}

// A file made here is the session's file once its creating open is answered:
// its number is the session's. Red before: it kept a number of its own.
{
  const { s, sync } = provisionalSession();
  await s.fs.readdir(OTHER);
  sync.writeFile(other('made.txt'), enc.encode('M'));
  await s.fs.flush();
  const fd = sync.open(other('made.txt'), { read: true }).id;
  assert.equal(Number(sync.fstat(fd).ino), s.kernel.stat('home/user/other/made.txt').ino);
  sync.close(fd);
}

// What a decision keeps of the process's budget is admitted before it is
// made, its records too, and the file an unlink leaves to its descriptors:
// refused ENOSPC, nothing changed. Red before: neither was admitted.
{
  const budget = { used: 0, limit: 100 };
  const { s, sync } = provisionalSession({ budget });
  await s.fs.readdir(OTHER);
  assert.throws(() => sync.mkdir(other('tiny')), { code: 'ENOSPC' });
  assert.equal(sync.stat(other('tiny')), null);
}
{
  const budget = { used: 0, limit: 4096 };
  const { s, sync } = provisionalSession({ budget });
  await resident(s, 'big.bin', 'x'.repeat(10_000));
  const fd = sync.open(other('big.bin'), { read: true }).id;
  assert.throws(() => sync.unlink(other('big.bin')), { code: 'ENOSPC' });
  assert.equal(Number(sync.stat(other('big.bin')).size), 10_000, 'a refused unlink changed the view');
  sync.close(fd);
}

// A descriptor's rights are the open's: one that made its file 0444 writes
// it (creat(2)); a reopen that empties a file it may not write is refused,
// no descriptor made and nothing emptied; and a write by a descriptor lands
// in its file under the name a rename since gave it.
{
  const { s, sync } = provisionalSession();
  await s.fs.readdir(OTHER);
  const made = sync.open(other('ro-made.txt'), { write: true, create: true, mode: 0o444 }).id;
  assert.equal(sync.write(made, null, enc.encode('MINE')), 4);
  sync.close(made);
  assert.equal(dec.decode(sync.readFile(other('ro-made.txt'))), 'MINE');
  await resident(s, 'locked.txt', 'KEEP');
  s.kernel.chmod('home/user/other/locked.txt', 0o444);
  await caughtUp(s);
  const reader = sync.open(other('locked.txt'), { read: true }).id;
  assert.throws(() => sync.reopen({ handle: reader }, { write: true, truncate: true }), { code: 'EACCES' });
  assert.equal(dec.decode(sync.readFile(other('locked.txt'))), 'KEEP');
  sync.close(reader);
  await resident(s, 'from.txt', 'abc');
  const fd = sync.open(other('from.txt'), { read: true, write: true }).id;
  sync.rename(other('from.txt'), other('to.txt'));
  sync.write(fd, 0, enc.encode('X'));
  assert.equal(dec.decode(sync.readFile(other('to.txt'))), 'Xbc');
  assert.equal(sync.stat(other('from.txt')), null);
  sync.close(fd);
  await s.fs.flush();
  assert.equal(dec.decode(s.kernel.readFile('home/user/other/to.txt')), 'Xbc');
}

// What a decision kept goes back once the view has it, whatever became of
// its name since. Red before: a renamed file's cell was never given back.
{
  const budget = { used: 0, limit: 1 << 20 };
  const { s, sync } = provisionalSession({ budget });
  await s.fs.readdir(OTHER);
  sync.writeFile(other('moving.bin'), new Uint8Array(10_000));
  sync.rename(other('moving.bin'), other('moved.bin'));
  await caughtUp(s);
  await caughtUp(s);
  assert.equal(budget.used, 0, `${budget.used} bytes still taken after the view had them`);
  assert.equal(Number(sync.stat(other('moved.bin')).size), 10_000);
}

// ── A resident's process logs what it sends in its own store until the session answers ──
// (process-fs-journal.ts): what it dies holding, the session drains from
// there. Red before: the holder's client was made without the journal.
{
  const journal = sqlJournal(createSqliteVfsTestHarness().sql);
  const gate = Promise.withResolvers();
  // The session's waves are held from the second file on: the first takes the subtree.
  let holding = false;
  const s = session({ journal, gate: { then: (resolve, reject) => (holding ? gate.promise : Promise.resolve()).then(resolve, reject) } });
  // Made beforehand: every change of the process goes through the held waves.
  s.kernel.mkdir('home/user/proj/logged', { mode: 0o755 });
  s.kernel.chown('home/user/proj/logged', 1000, 1000);
  await create(s.fs, '/home/user/proj/logged/first.txt', 'first\n');
  holding = true;
  for (let index = 0; index < 20; index++) await create(s.fs, `/home/user/proj/logged/f${index}.txt`, `file ${index}\n`);
  const flushed = s.fs.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(journal.entries().length > 0, 'what the process sent was not in its journal while unanswered');
  gate.resolve();
  await flushed;
  assert.equal(journal.entries().length, 0, 'answered changes stayed in the journal');
  await s.fs.settle();
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/logged/f19.txt')), 'file 19\n');
}

// ── Review 6: O_CREAT without O_TRUNC keeps an existing file's bytes ──
// Red before: the holder emptied it, as if O_TRUNC had been asked.
{
  const s = session();
  await s.fs.mkdir('/home/user/proj/keep', { mode: 0o755 });
  await create(s.fs, '/home/user/proj/keep/f', 'abc');
  const handle = await s.fs.open('/home/user/proj/keep/f', { write: true, create: true, mode: 0o644 });
  await s.fs.write(handle.id, 0, enc.encode('X'));
  await s.fs.close(handle.id);
  await s.fs.settle();
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/keep/f')), 'Xbc');
}

// ── Review 7: an unlinked file's open descriptions keep its bytes; no name is written with them ──
// Red before: a write through a descriptor of an unlinked file wrote its name again.
{
  const s = session();
  await s.fs.mkdir('/home/user/proj/gone', { mode: 0o755 });
  const old = await s.fs.open('/home/user/proj/gone/f', { read: true, write: true, create: true, truncate: true, mode: 0o644 });
  await s.fs.write(old.id, null, enc.encode('1'));
  await s.fs.unlink('/home/user/proj/gone/f');
  await s.fs.write(old.id, null, enc.encode('2'));
  // Still readable through the description, as POSIX has it.
  assert.equal(dec.decode(await s.fs.read(old.id, 0, 10)), '12');
  await s.fs.flush();
  assert.equal(await withRecall(() => s.kernel.exists('home/user/proj/gone/f')), false, 'a write through a description of an unlinked file made its name again');
  // A new file of that name is not the old description's.
  await create(s.fs, '/home/user/proj/gone/f', 'new');
  await s.fs.write(old.id, null, enc.encode('zz'));
  await s.fs.close(old.id);
  await s.fs.settle();
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/gone/f')), 'new');
}

// ── Review A6 (recheck): an existing file opened to read and write needs read permission too ──
// Red before: only write permission was checked, so a 0200 file the holder
// made opened O_RDWR (truncating or not) and read, instead of EACCES.
{
  const s = session();
  await s.fs.mkdir('/home/user/proj/wonly', { mode: 0o755 });
  const made = await s.fs.open('/home/user/proj/wonly/f', { write: true, create: true, truncate: true, mode: 0o200 });
  await s.fs.write(made.id, null, enc.encode('secret'));
  await s.fs.close(made.id);
  await assert.rejects(async () => s.fs.open('/home/user/proj/wonly/f', { read: true, write: true, create: true }), { code: 'EACCES' }, 'O_RDWR without O_TRUNC of a write-only file');
  await assert.rejects(async () => s.fs.open('/home/user/proj/wonly/f', { read: true, write: true, create: true, truncate: true }), { code: 'EACCES' }, 'O_RDWR|O_TRUNC of a write-only file');
  const writeOnly = await s.fs.open('/home/user/proj/wonly/f', { write: true, create: true });
  await s.fs.close(writeOnly.id);
  await s.fs.settle();
}

// ── Review A7 (recheck): fstat of a description answers from its own file, its name gone or reused ──
// Red before: fstat looked the description's pathname up: EBADF once the
// name was unlinked, and the replacement's stat once a rename reused it.
{
  const s = session();
  await s.fs.mkdir('/home/user/proj/fst', { mode: 0o755 });
  const a = await s.fs.open('/home/user/proj/fst/a', { read: true, write: true, create: true, truncate: true, mode: 0o644 });
  await s.fs.write(a.id, null, enc.encode('aaaa'));
  const ino = (await s.fs.fstat(a.id)).ino;
  await s.fs.unlink('/home/user/proj/fst/a');
  const gone = await s.fs.fstat(a.id);
  assert.equal(gone.ino, ino, 'fstat of an unlinked description named another file');
  assert.equal(gone.nlink, 0);
  assert.equal(gone.size, 4);
  const b = await s.fs.open('/home/user/proj/fst/b', { read: true, write: true, create: true, truncate: true, mode: 0o644 });
  await s.fs.write(b.id, null, enc.encode('bb'));
  const bIno = (await s.fs.fstat(b.id)).ino;
  await create(s.fs, '/home/user/proj/fst/c', 'replacement');
  await s.fs.rename('/home/user/proj/fst/c', '/home/user/proj/fst/b');
  const replaced = await s.fs.fstat(b.id);
  assert.equal(replaced.ino, bIno, 'fstat of a replaced description answered the replacement');
  assert.equal(replaced.size, 2);
  await s.fs.close(a.id);
  await s.fs.close(b.id);
  await s.fs.settle();
}

// ── Review 8: a description whose grant is given back writes through, never its whole held copy ──
// The review's sequence: holder-made file abcd; the grant is revoked (a
// peer writes Z at 2); the old description writes X at 0. The file is XbZd.
// Red before: the drain wrote the description's whole held copy, Xbcd,
// over the peer's Z.
{
  const s = session();
  await s.fs.mkdir('/home/user/proj/through', { mode: 0o755 });
  const fd = await s.fs.open('/home/user/proj/through/f', { read: true, write: true, create: true, truncate: true, mode: 0o644 });
  await s.fs.write(fd.id, null, enc.encode('abcd'));
  // A peer's write recalls (revokes) the grant: what was decided is sent first.
  await withRecall(() => s.kernel.writeRange('home/user/proj/through/f', 2, enc.encode('Z')));
  assert.equal(await withRecall(() => s.kernel.readFileString('home/user/proj/through/f')), 'abZd');
  await s.fs.write(fd.id, 0, enc.encode('X'));
  await s.fs.fsync(fd.id);
  assert.equal(await withRecall(() => s.kernel.readFileString('home/user/proj/through/f')), 'XbZd', 'the description overwrote what the peer wrote');
  // Its own reads are the session's, its writes included.
  assert.equal(dec.decode(await s.fs.read(fd.id, 0, 10)), 'XbZd');
  await s.fs.close(fd.id);
  await s.fs.settle();
}

// ── Review 12: a file opened to write outside any held subtree is written through the client ──
// One open call, then writes by number in the waves: no descriptor RPC per
// write, and an O_APPEND write from two writers interleaves whole writes
// (each at the end of the file as the session has it then).
{
  const s = session();
  s.kernel.writeFile('home/user/shared.log', enc.encode(''));
  s.kernel.chown('home/user/shared.log', 1000, 1000);
  const callsBefore = { ...s.fs.stats().delegated };
  const log = await s.fs.open('/home/user/shared.log', { write: true, append: true });
  for (let i = 0; i < 5; i++) {
    await s.fs.write(log.id, null, enc.encode(`p${i};`));
    // A shell >> between the process's appends.
    await withRecall(() => s.kernel.writeRange('home/user/shared.log', s.kernel.stat('home/user/shared.log').size, enc.encode(`s${i};`)));
    await s.fs.fsync(log.id);
  }
  await s.fs.close(log.id);
  await s.fs.settle();
  const text = await withRecall(() => s.kernel.readFileString('home/user/shared.log'));
  assert.equal(text.length, 'p0;s0;'.length * 5, `an append overwrote another: ${text}`);
  for (let i = 0; i < 5; i++) {
    assert.ok(text.includes(`p${i};`) && text.includes(`s${i};`), `a write was lost: ${text}`);
  }
  const after = s.fs.stats().delegated;
  assert.equal((after.write ?? 0) - (callsBefore.write ?? 0), 0, 'a write through a description was a session call');
  assert.equal(s.fs.stats().client.ops > 0, true, 'the writes did not go through the client');
}

// ── Review D (FilthySwordtail): a file written through is read by name as the session has it ──
// Red before: the holder answered its empty buffer for the file's content,
// so readFile returned nothing and a pin, after the close, pinned nothing.
{
  const s = session();
  s.kernel.writeFile('home/user/through.txt', enc.encode(''));
  s.kernel.chown('home/user/through.txt', 1000, 1000);
  const fd = await s.fs.open('/home/user/through.txt', { write: true });
  await s.fs.write(fd.id, null, enc.encode('through bytes'));
  assert.equal(dec.decode(await s.fs.readFile('/home/user/through.txt')), 'through bytes', 'readFile of a file written through');
  await s.fs.close(fd.id);
  assert.equal(dec.decode(await s.fs.readFile('/home/user/through.txt')), 'through bytes', 'and after its close');
  const st = await s.fs.stat('/home/user/through.txt');
  const pinned = await s.fs.pinContent('/home/user/through.txt', st);
  if (pinned !== null) {
    assert.equal(dec.decode(pinned.bytes), 'through bytes', 'a pin of a file written through');
    pinned.release();
  }
  await s.fs.settle();
}

// ── Review D (POSIX): an open description's access is fixed at its open ──
// A chmod and chown after the open leave its writes allowed; an O_RDWR of a
// write-only file is EACCES at the open. Red before: each write rechecked
// the name's permission (EACCES at the next fsync), and the open asked only
// for write.
{
  const s = session();
  s.kernel.writeFile('home/user/kept.txt', enc.encode(''));
  s.kernel.chown('home/user/kept.txt', 1000, 1000);
  const fd = await s.fs.open('/home/user/kept.txt', { write: true });
  s.kernel.chown('home/user/kept.txt', 0, 0);
  s.kernel.chmod('home/user/kept.txt', 0o444);
  await s.fs.write(fd.id, 0, enc.encode('still mine'));
  await s.fs.fsync(fd.id);
  await s.fs.close(fd.id);
  await s.fs.settle();
  assert.equal(await withRecall(() => s.kernel.readFileString('home/user/kept.txt')), 'still mine', 'a chmod after the open stopped its writes');
  s.kernel.writeFile('home/user/wonly.txt', enc.encode('secret'));
  s.kernel.chown('home/user/wonly.txt', 1000, 1000);
  s.kernel.chmod('home/user/wonly.txt', 0o200);
  await assert.rejects(async () => s.fs.open('/home/user/wonly.txt', { read: true, write: true }), { code: 'EACCES' }, 'O_RDWR of a write-only file opened');
}

// ── Review D: reads, fstat and writes go through the description's own file ──
// Red before: the first read reopened the old name (the replacement's bytes,
// or ENOENT), fstat by name said nlink 0 after a rename, and a write after
// an unlink was dropped.
{
  const s = session();
  s.kernel.writeFile('home/user/rr.txt', enc.encode(''));
  s.kernel.chown('home/user/rr.txt', 1000, 1000);
  const fd = await s.fs.open('/home/user/rr.txt', { read: true, write: true });
  await s.fs.write(fd.id, 0, enc.encode('mine'));
  const ino = (await s.fs.fstat(fd.id)).ino;
  // Renamed away, and the name reused for another file.
  await withRecall(() => s.kernel.rename('home/user/rr.txt', 'home/user/rr.old'));
  await withRecall(() => s.kernel.writeFile('home/user/rr.txt', enc.encode('other')));
  assert.equal(dec.decode(await s.fs.read(fd.id, 0, 10)), 'mine', 'a read reopened the name, not the description\'s file');
  const renamed = await s.fs.fstat(fd.id);
  assert.equal(renamed.ino, ino);
  assert.equal(renamed.nlink, 1, 'fstat of a renamed description said it has no name');
  // Unlinked: still its file, still writable, until its close.
  await withRecall(() => s.kernel.unlink('home/user/rr.old'));
  await s.fs.write(fd.id, 4, enc.encode('+more'));
  await s.fs.fsync(fd.id);
  assert.equal(dec.decode(await s.fs.read(fd.id, 0, 20)), 'mine+more', 'a write after an unlink was dropped');
  assert.equal((await s.fs.fstat(fd.id)).nlink, 0);
  await s.fs.close(fd.id);
  await s.fs.settle();
  assert.equal(await withRecall(() => s.kernel.readFileString('home/user/rr.txt')), 'other');
}

// ── Review D (41b-2): a write past a piece goes through its description, every piece ──
// Red before: the client split a 6 MiB write into pieces and only the first
// kept the description; the rest went by inode or name, dropped after an
// unlink (no name has the file) and refused after a chmod (EACCES).
{
  const s = session();
  const big = new Uint8Array(6 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const tail = (bytes) => Array.from(bytes.subarray(bytes.length - 8));
  s.kernel.writeFile('home/user/gone.bin', enc.encode(''));
  s.kernel.chown('home/user/gone.bin', 1000, 1000);
  const gone = await s.fs.open('/home/user/gone.bin', { read: true, write: true });
  await withRecall(() => s.kernel.unlink('home/user/gone.bin'));
  await s.fs.write(gone.id, 0, big);
  await s.fs.fsync(gone.id);
  assert.equal((await s.fs.fstat(gone.id)).size, big.length, 'the pieces after the first were dropped after an unlink');
  assert.deepEqual(Array.from(await s.fs.read(gone.id, big.length - 8, 8)), tail(big), 'the last piece is not what was written');
  await s.fs.close(gone.id);
  s.kernel.writeFile('home/user/locked.bin', enc.encode(''));
  s.kernel.chown('home/user/locked.bin', 1000, 1000);
  const locked = await s.fs.open('/home/user/locked.bin', { read: true, write: true });
  await withRecall(() => s.kernel.chmod('home/user/locked.bin', 0o000));
  await s.fs.write(locked.id, 0, big);
  await s.fs.fsync(locked.id);
  await s.fs.close(locked.id);
  await s.fs.settle();
  const stored = await withRecall(() => s.kernel.readFile('home/user/locked.bin'));
  assert.equal(stored.length, big.length, 'the pieces after the first were refused after a chmod');
  assert.deepEqual(tail(stored), tail(big));
}

// ── Review D (41b-3): a held description keeps the access its open had when it goes through ──
// Red before: going through opened each description anew by its name after
// the process's own chmod 000 (or a mode its creating open never needed),
// so the open was refused (EACCES), and the description's later writes and
// reads had nothing at the session.
{
  const s = session();
  await s.fs.mkdir('/home/user/proj/acc', { mode: 0o755 });
  const revoke = (name) => withRecall(() => s.kernel.writeFile(`home/user/proj/acc/${name}`, enc.encode('p')));
  for (const how of ['fchmod', 'chmod']) {
    const path = `/home/user/proj/acc/${how}`;
    const fd = await s.fs.open(path, { read: true, write: true, create: true, truncate: true, mode: 0o644 });
    await s.fs.write(fd.id, null, enc.encode('held'));
    if (how === 'fchmod') await s.fs.fchmod(fd.id, 0o000);
    else await s.fs.chmod(path, 0o000);
    await revoke(`peer-${how}`);
    await s.fs.write(fd.id, null, enc.encode('+more'));
    await s.fs.fsync(fd.id);
    assert.equal(dec.decode(await s.fs.read(fd.id, 0, 20)), 'held+more', `after a ${how} 000 and a revoke, its read`);
    await s.fs.close(fd.id);
    await s.fs.settle();
    assert.equal(dec.decode(await withRecall(() => s.kernel.readFile(`home/user/proj/acc/${how}`))), 'held+more', `after a ${how} 000 and a revoke, its writes`);
  }
  // creat(2) of 0444: its creating descriptor writes it, held or through.
  const ro = await s.fs.open('/home/user/proj/acc/ro', { read: true, write: true, create: true, exclusive: true, mode: 0o444 });
  await s.fs.write(ro.id, null, enc.encode('mine'));
  await revoke('peer-ro');
  await s.fs.write(ro.id, null, enc.encode('+too'));
  await s.fs.fsync(ro.id);
  assert.equal(dec.decode(await s.fs.read(ro.id, 0, 20)), 'mine+too', 'a creating descriptor of 0444 lost its access');
  await s.fs.close(ro.id);
  await s.fs.settle();
  const made = s.kernel.stat('home/user/proj/acc/ro');
  assert.equal(made.mode & 0o777, 0o444);
  assert.equal(dec.decode(s.kernel.readFile('home/user/proj/acc/ro')), 'mine+too');
}

// ── Merged gate: a file written through reads back what it was given, at once ──
// Red before (live, python): written through (a shared directory is never
// held), closed, then stat'd and read by name, the file was what the session
// had before its write was sent: size 0, no bytes.
{
  const s = session();
  const fd = await s.fs.open('/tmp/through.txt', { write: true, create: true, truncate: true, mode: 0o644 });
  await s.fs.write(fd.id, null, enc.encode('abc'));
  await s.fs.close(fd.id);
  assert.equal((await s.fs.stat('/tmp/through.txt')).size, 3, 'a stat after the close missed the write');
  const again = await s.fs.open('/tmp/through.txt', { read: true });
  assert.equal(dec.decode(await s.fs.read(again.id, 0, 10)), 'abc', 'a read after the close missed the write');
  await s.fs.close(again.id);
  await s.fs.settle();
}

// ── Review D8 (race): what a description writes while its grant's recall is sent goes through ──
// Red before: the description went on deciding while the recall's flush
// waited, and the drain after it replayed the whole file over the peer's write.
{
  const gate = Promise.withResolvers();
  let holding = false;
  const s = session({ gate: { then: (resolve, reject) => (holding ? gate.promise : Promise.resolve()).then(resolve, reject) } });
  await s.fs.mkdir('/home/user/proj/race', { mode: 0o755 });
  const fd = await s.fs.open('/home/user/proj/race/f', { read: true, write: true, create: true, truncate: true, mode: 0o644 });
  await s.fs.write(fd.id, null, enc.encode('abcd'));
  holding = true;
  const peer = withRecall(() => s.kernel.writeRange('home/user/proj/race/f', 2, enc.encode('Z')));
  await until(() => s.fs.stats().client.recalls >= 1, 'the recall');
  // The recall's send is held: the description writes meanwhile.
  await s.fs.write(fd.id, 0, enc.encode('X'));
  holding = false;
  gate.resolve();
  await peer;
  await s.fs.fsync(fd.id);
  assert.equal(await withRecall(() => s.kernel.readFileString('home/user/proj/race/f')), 'XbZd', 'a write during the recall replayed the whole file over the peer');
  await s.fs.close(fd.id);
  await s.fs.settle();
}

// ── Review D8 (recheck): a refusal recorded is the next sync's answer, however that sync is reached, and a close's ──
// Red before: syncInode reported nothing once nothing was pending, and a
// close never reported a refusal of what its description wrote.
{
  let failNext = false;
  const s = session({ refuse: () => { const now = failNext; failNext = false; return now; } });
  s.kernel.writeFile('home/user/full.txt', enc.encode(''));
  s.kernel.chown('home/user/full.txt', 1000, 1000);
  const fd = await s.fs.open('/home/user/full.txt', { write: true });
  failNext = true;
  await s.fs.write(fd.id, 0, enc.encode('lost'));
  // Sent (the client sends on its own) and refused: nothing is pending, the refusal recorded.
  await until(() => s.fs.holding() === false, 'the refused write sent');
  const st = await s.fs.fstat(fd.id);
  await assert.rejects(async () => s.fs.syncInode(st.dev, st.ino), (error) => typeof error?.code === 'string', 'a sync of the file did not report the recorded refusal');
  await s.fs.close(fd.id);
  // Another write refused, then a close: the close reports it.
  const again = await s.fs.open('/home/user/full.txt', { write: true });
  failNext = true;
  await s.fs.write(again.id, 0, enc.encode('lost too'));
  await until(() => s.fs.holding() === false, 'the second refused write sent');
  await assert.rejects(async () => s.fs.close(again.id), (error) => typeof error?.code === 'string', 'a close did not report the recorded refusal');
  await s.fs.settle();
}

// ── Review D: O_APPEND set on a write-through description is the description's ──
// Red before: setStatus of the holder's descriptor went to the session (EBADF).
{
  const s = session();
  s.kernel.writeFile('home/user/st.log', enc.encode('a;'));
  s.kernel.chown('home/user/st.log', 1000, 1000);
  const fd = await s.fs.open('/home/user/st.log', { write: true });
  await s.fs.setStatus(fd.id, { append: true });
  await s.fs.write(fd.id, null, enc.encode('b;'));
  await s.fs.fsync(fd.id);
  await s.fs.close(fd.id);
  await s.fs.settle();
  assert.equal(await withRecall(() => s.kernel.readFileString('home/user/st.log')), 'a;b;');
}

console.log('wasi delegation holder: ok');
