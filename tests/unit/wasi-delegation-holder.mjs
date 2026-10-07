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

function session({ grantInos, journal, gate } = {}) {
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
  const entryOf = (stat) => ({
    type: stat.type, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, atime: stat.atime, mtime: stat.mtime,
    ctime: stat.ctime, mode: stat.mode, uid: stat.uid, gid: stat.gid, revision: stat.revision ?? 0, target: null,
  });
  const device = bridge.stat('/').dev;
  const store = {
    device,
    cred: user,
    ready: () => true,
    entry: (key) => {
      try {
        const stat = bridge.stat('/' + key, { followSymlinks: false });
        return stat === null ? null : entryOf(stat);
      } catch { return null; }
    },
    children: (key) => {
      try { return bridge.readdir('/' + key); } catch { return undefined; }
    },
    list: async () => true,
    lookup: async () => true,
    listTree: async () => false,
    content: (key) => { try { return bridge.readFile('/' + key) ?? undefined; } catch { return undefined; } },
    fill: async (key) => bridge.readFile('/' + key),
    barrier: async () => true,
    reserve: () => true,
    release: () => {},
  };
  const waves = [];
  // In process: nothing between the client and the session loses a call, so it fences nothing.
  const processSession = {
    openWriter: async () => null,
    writeBatchStream: async (stream, _fence, owner) => {
      if (gate) await gate;
      const result = await bridge.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner });
      waves.push(result);
      return result;
    },
    grants: {
      acquire: async (path, delegate) => bridge.acquireExclusiveMutation(path, { delegate }),
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

// ── A resident's process logs what it sends in its own store until the session answers ──
// (process-fs-journal.ts): what it dies holding, the session drains from
// there. Red before: the holder's client was made without the journal.
{
  const journal = sqlJournal(createSqliteVfsTestHarness().sql);
  const gate = Promise.withResolvers();
  const s = session({ journal, gate: gate.promise });
  // Made beforehand: every change of the process goes through the held waves.
  s.kernel.mkdir('home/user/proj/logged', { mode: 0o755 });
  s.kernel.chown('home/user/proj/logged', 1000, 1000);
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
    await withRecall(() => s.kernel.appendFile('home/user/shared.log', enc.encode(`s${i};`)));
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

// ── Review 12: a refusal of a write through is reported at the description's next fsync ──
{
  const s = session();
  s.kernel.writeFile('home/user/ro.txt', enc.encode('ro'));
  s.kernel.chown('home/user/ro.txt', 1000, 1000);
  const fd = await s.fs.open('/home/user/ro.txt', { write: true });
  // Made read-only by the kernel after the open: the session refuses the write.
  s.kernel.chown('home/user/ro.txt', 0, 0);
  s.kernel.chmod('home/user/ro.txt', 0o444);
  await s.fs.write(fd.id, 0, enc.encode('XX'));
  await assert.rejects(async () => s.fs.fsync(fd.id), /refused/, 'a refused write through was not reported');
  await s.fs.close(fd.id);
}

console.log('wasi delegation holder: ok');
