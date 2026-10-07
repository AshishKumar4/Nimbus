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
import { MAX_DELEGATIONS_PER_PROCESS } from '../../packages/core/src/_shared/process-fs-client.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

function session() {
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

console.log('wasi delegation holder: ok');
