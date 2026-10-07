#!/usr/bin/env bun
// A W7 directory record never replaces a symbolic link (Main's rule for
// every producer): unless the same batch removes the link, the batch fails
// with ENOTDIR and commits nothing; it never follows the link and never
// replaces it. A producer that means to replace one (git's checkout, over a
// link in a leading path) removes it first: in the same batch (writeBatch),
// or in a wave before (a W7 wave names a path once).
//
// Red before: a wave with root .git, writing .git/objects/ab/x where
// .git/objects is a link to the real objects, replaced the link with an
// empty directory (cutting the repository off from its objects and refs'
// targets) and then failed with ENOENT after committing three paths.
//
//   (1) a stream (writeStream, as every wave goes): refused, ENOTDIR, with
//       nothing committed: the removals and directories before the refused
//       one, and the files after it, are all as they were;
//   (2) the link removed by a wave before: the next wave's directory
//       replaces it, and the file lands in it;
//   (3) a batch (writeBatch): refused alike, nothing changed; allowed with
//       the link among its removals;
//   (4) the wave writer, as git add used it (root .git): refused, the link
//       and its target untouched;
//   (5) holding the leading section loses no bound: a removal and 301
//       directories (with a file each) commit, the directories in batches a
//       transaction takes (they failed E2BIG when the removal flushed them
//       all at once).

import assert from 'node:assert/strict';

import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createWaveWriter } from '../../packages/platform/src/wave-writer.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const REPO = 'home/user/repo';

/** A repository whose .git/objects links to the real objects, beside a file and a directory a batch removes. */
function setup() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir(`${REPO}/.git`, { recursive: true });
  kernel.mkdir('home/user/real-objects/ab', { recursive: true });
  kernel.writeFile('home/user/real-objects/ab/existing', 'old');
  kernel.symlink('../../real-objects', `${REPO}/.git/objects`);
  kernel.writeFile(`${REPO}/stale.txt`, 'stale');
  kernel.mkdir(`${REPO}/gone/deep`, { recursive: true });
  return { raw, kernel };
}

/** Every path under home/user, with its type and (for a file or link) what it holds. */
function snapshot(kernel) {
  const out = {};
  const walk = (dir) => {
    for (const entry of kernel.readdir(dir)) {
      const path = `${dir}/${entry.name}`;
      const st = kernel.lstat(path);
      out[path] = st.type === 'file' ? `file ${new TextDecoder().decode(kernel.readFile(path))}`
        : st.type === 'symlink' ? `link ${kernel.readlink(path)}` : st.type;
      if (st.type === 'directory') walk(path);
    }
  };
  walk('home/user');
  return out;
}

const dir = (path) => ({ path, parentPath: path.slice(0, path.lastIndexOf('/')), kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });
const file = (path, text) => {
  const data = enc.encode(text);
  return { inode: { path, parentPath: path.slice(0, path.lastIndexOf('/')), kind: 'file', isDir: false, size: data.byteLength, mtime: 1, mode: 0o444, chunkCount: 1 }, chunk: { path, chunkId: 0, data } };
};

/** A wave as an encoder sends it: removals, then directories (the link's among them), then a file under the link. */
function wave() {
  const x = file(`${REPO}/.git/objects/ab/x`, 'new object');
  return {
    deletePaths: [`${REPO}/stale.txt`, `${REPO}/gone`],
    inodes: [dir(`${REPO}/fresh`), dir(`${REPO}/.git/objects`), dir(`${REPO}/.git/objects/ab`), x.inode],
    chunks: [x.chunk],
  };
}

// ── (1) a stream: refused, nothing committed ───────────────────────────────
{
  const { kernel } = setup();
  const before = snapshot(kernel);
  const result = await kernel.writeStream(encodeWriteBatchStream(wave()));
  assert.equal(result.ok, false, 'a directory record over a link the wave does not remove is refused');
  assert.match(result.error.message, /^ENOTDIR: home\/user\/repo\/\.git\/objects: a directory record never replaces a symbolic link/);
  assert.equal(result.committedPathCount, 0, 'nothing committed');
  assert.deepEqual(snapshot(kernel), before, 'every path as it was: the removals, the directories and the file all undone or never made');
  console.log('  ok  (1) a wave whose directory would replace a link is refused, every path unchanged');
}

// ── (2) the link removed by a wave before: replaced ────────────────────────
{
  const { kernel } = setup();
  const removed = await kernel.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], deletePaths: [`${REPO}/.git/objects`] }));
  assert.equal(removed.ok, true, removed.error?.message);
  const result = await kernel.writeStream(encodeWriteBatchStream(wave()));
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(kernel.lstat(`${REPO}/.git/objects`).type, 'directory', 'the link the wave removed is replaced by the directory');
  assert.equal(new TextDecoder().decode(kernel.readFile(`${REPO}/.git/objects/ab/x`)), 'new object');
  assert.equal(new TextDecoder().decode(kernel.readFile('home/user/real-objects/ab/existing')), 'old', "the link's target is left as it was");
  console.log("  ok  (2) a wave after one that removes the link replaces it");
}

// ── (3) a batch: refused alike; allowed with the link removed ──────────────
{
  const { kernel } = setup();
  const before = snapshot(kernel);
  assert.throws(() => kernel.writeBatch({ inodes: [dir(`${REPO}/fresh`), dir(`${REPO}/.git/objects`)], chunks: [], deletePaths: [`${REPO}/stale.txt`] }),
    (error) => error.code === 'ENOTDIR' && /never replaces a symbolic link/.test(error.message));
  assert.deepEqual(snapshot(kernel), before, 'a refused batch changes nothing');
  kernel.writeBatch({ inodes: [dir(`${REPO}/.git/objects`)], chunks: [], deletePaths: [`${REPO}/.git/objects`] });
  assert.equal(kernel.lstat(`${REPO}/.git/objects`).type, 'directory');
  console.log('  ok  (3) a batch is refused alike, and allowed when it removes the link');
}

// ── (5) a wave of a removal and more directories than a batch takes ────────
// The leading directories commit in the bounded batches the stream always
// cut them into, the removals first (a wave of one removal and 300 sibling
// directories with a file each: ~602 owned paths, under W7's 1024, over a
// transaction's 256 rows).
{
  const { kernel } = setup();
  const inodes = [];
  const chunks = [];
  for (let i = 0; i < 300; i++) {
    inodes.push(dir(`${REPO}/many/d${i}`));
    const f = file(`${REPO}/many/d${i}/f`, `file ${i}`);
    inodes.push(f.inode);
    chunks.push(f.chunk);
  }
  inodes.unshift(dir(`${REPO}/many`));
  const result = await kernel.writeStream(encodeWriteBatchStream({ deletePaths: [`${REPO}/stale.txt`], inodes, chunks }));
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(kernel.readdir(`${REPO}/many`).length, 300);
  assert.equal(new TextDecoder().decode(kernel.readFile(`${REPO}/many/d299/f`)), 'file 299');
  assert.throws(() => kernel.lstat(`${REPO}/stale.txt`), /ENOENT/);
  console.log('  ok  (5) a removal and 301 directories commit, the directories in bounded batches');
}

// ── (4) the wave writer, as git add used it ────────────────────────────────
{
  const { kernel } = setup();
  const before = snapshot(kernel);
  const writer = createWaveWriter({ supervisor: { writeBatchStream: (stream) => kernel.writeStream(stream) }, root: `${REPO}/.git`, mtimeMs: 1 });
  await assert.rejects(async () => {
    await writer.file(`${REPO}/.git/objects/ab/x`, 0o444, enc.encode('new object'));
    await writer.flush();
  }, /ENOTDIR: home\/user\/repo\/\.git\/objects: a directory record never replaces a symbolic link/);
  assert.deepEqual(snapshot(kernel), before, 'the link and its target untouched');
  console.log('  ok  (4) a wave writer rooted above a link is refused, the link and its target untouched');
}

console.log('sqlite-vfs-batch-directory-over-link: a directory record never replaces a symbolic link; a refused wave commits nothing');
