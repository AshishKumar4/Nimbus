// The shallow clone pipeline (git/pack/clone.ts) against a real git server
// (`git http-backend`), checked against host git:
//   - prepare fetches the commit and its trees with blob:none and plans the
//     checkout; K batches fetch the blobs by id; finish writes the index;
//   - every pack the clone stored has the idx git index-pack writes for it;
//   - the worktree, modes and symlinks equal `git clone --depth 1`'s, and
//     git fsck finds the repository whole;
//   - the index is git's for that tree, every entry carrying the stat the
//     session reported (git status --porcelain is clean without a refresh).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { cloneBatch, cloneFast, cloneFinish } from '../../packages/worker/src/git/pack/clone.ts';
import { startGitHttpServer } from './lib/git-http-server.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-pack-clone-'));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: work, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, env, maxBuffer: 1 << 28 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.toString();
}

/** The session's filesystem as the facet reaches it: ranged writes, reads, renames; files and links by path. */
function fakeSession() {
  const files = new Map();
  const links = new Map();
  const dirs = new Set();
  let ino = 100;
  const stats = new Map();
  const counters = { fsWriteRange: 0, fsReadRange: 0, rename: 0, waves: 0 };
  const strip = (path) => (path.startsWith('/') ? path.slice(1) : path);
  const supervisor = {
    async fsWriteRange(path, offset, bytes) {
      counters.fsWriteRange++;
      const key = strip(path);
      const prior = files.get(key) ?? new Uint8Array(0);
      const next = new Uint8Array(Math.max(prior.byteLength, offset + bytes.byteLength));
      next.set(prior);
      next.set(bytes, offset);
      files.set(key, next);
    },
    async fsTruncate(path, size) { files.set(strip(path), files.get(strip(path)).slice(0, size)); },
    async fsReadRange(path, offset, length) {
      counters.fsReadRange++;
      const bytes = files.get(strip(path));
      return bytes === undefined ? null : bytes.slice(offset, offset + length);
    },
    async rename(from, to) {
      counters.rename++;
      files.set(strip(to), files.get(strip(from)));
      files.delete(strip(from));
    },
  };
  const writer = (base, onReceipts) => ({
    async file(path, mode, bytes) {
      const key = strip(base + '/' + path);
      // The writer owns what it is given: W7 transfers it, detaching the
      // buffer. A caller still holding it (a cached delta base, a blob's
      // other path) would then hold a detached buffer.
      assert.equal(bytes.buffer.detached, false, path + ': handed a detached buffer');
      files.set(key, bytes.slice());
      if (bytes.buffer.byteLength > 0) structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      stats.set(key, { ino: ino++, mode, size: bytes.byteLength, mtimeMs: 1_790_000_000_123, ctimeMs: 1_790_000_000_456, uid: 1000, gid: 1000, dev: 7 });
      this.pending.push(key);
    },
    async symlink(path, target) {
      const key = strip(base + '/' + path);
      links.set(key, target);
      stats.set(key, { ino: ino++, mode: 0o777, size: target.length, mtimeMs: 1_790_000_000_123, ctimeMs: 1_790_000_000_456, uid: 1000, gid: 1000, dev: 7 });
      this.pending.push(key);
    },
    async directory(path) { dirs.add(strip(base + '/' + path)); },
    async remove(path) {
      const key = strip(base + '/' + path);
      for (const name of [...files.keys()]) if (name === key || name.startsWith(key + '/')) files.delete(name);
    },
    setPin() {},
    pending: [],
    async flush() {
      counters.waves++;
      onReceipts?.(this.pending.map((path) => ({ path: '/' + path, ...stats.get(path) })));
      this.pending = [];
    },
  });
  return { files, links, dirs, stats, supervisor, writer, counters };
}

try {
  // The remote: a tree with nested directories, an executable, a symlink, a
  // blob at two paths, and a file large enough for several pieces.
  const source = join(work, 'source');
  git(work, ['init', '-q', '-b', 'main', source]);
  mkdirSync(join(source, 'src/deep/er'), { recursive: true });
  for (let i = 0; i < 300; i++) writeFileSync(join(source, `src/f${i}.txt`), `file ${i}\n` + 'shared line\n'.repeat(i % 7));
  writeFileSync(join(source, 'src/deep/er/same-a.txt'), 'same\n');
  writeFileSync(join(source, 'src/deep/same-b.txt'), 'same\n');
  writeFileSync(join(source, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(join(source, 'run.sh'), 0o755);
  symlinkSync('src/f1.txt', join(source, 'link'));
  const big = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
  writeFileSync(join(source, 'big.bin'), big);
  git(source, ['add', '-A']);
  git(source, ['commit', '-q', '-m', 'one']);
  writeFileSync(join(source, 'src/f2.txt'), 'changed\n');
  git(source, ['commit', '-q', '-am', 'two']);
  const served = join(work, 'served');
  mkdirSync(served);
  git(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  const head = git(source, ['rev-parse', 'HEAD']).trim();

  const server = startGitHttpServer(served);
  try {
    const session = fakeSession();
    const dir = '/home/user/repo';
    const context = {
      supervisor: session.supervisor,
      writer: (onReceipts) => session.writer(dir, onReceipts),
      dir,
      url: server.url + '/repo.git',
      marker: { path: '.git/nimbus-clone-job', text: '{}' },
    };
    const prepared = await cloneFast(context, { depth: 1, jobId: 'job', blobsPerBatch: 50 });
    assert.equal(prepared.unsupported, undefined, prepared.unsupported);
    assert.equal(prepared.commit, head);
    assert.equal(prepared.headRef, 'refs/heads/main');
    assert.equal(prepared.batches.length, 7, '305 paths at 50 per batch');
    const results = await Promise.all(prepared.batches.map((batch) => {
      const bytes = session.files.get('home/user/repo/.git/nimbus-clone/batch-' + batch.index).byteLength;
      return cloneBatch(context, { jobId: 'job', index: batch.index, batchBytes: bytes, capabilities: prepared.capabilities });
    }));
    const shares = [
      { name: 'index-gitlinks', bytes: prepared.gitlinkIndexBytes },
      ...results.map((result) => ({ name: 'index-' + result.index, bytes: result.indexBytes })),
    ];
    const finished = await cloneFinish(context, { shares });
    assert.equal(finished.indexEntries, 305);
    assert.ok(![...session.files.keys()].some((path) => path.includes('nimbus-clone/')), 'staging removed');

    // Materialize what the session holds and compare with host git's clone.
    const out = join(work, 'out');
    for (const [path, bytes] of session.files) {
      const target = join(out, path.slice('home/user/repo/'.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      const stat = session.stats.get(path);
      if (stat && stat.mode & 0o111) chmodSync(target, 0o755);
    }
    for (const [path, target] of session.links) symlinkSync(target, join(out, path.slice('home/user/repo/'.length)));
    for (const path of session.dirs) mkdirSync(join(out, path.slice('home/user/repo/'.length)), { recursive: true });

    const packDir = join(out, '.git/objects/pack');
    const packs = readdirSync(packDir).filter((name) => name.endsWith('.pack'));
    assert.equal(packs.length, 1 + prepared.batches.length, 'one pack for the trees, one per batch');
    for (const pack of packs) {
      const check = join(work, 'check-' + pack);
      mkdirSync(check);
      git(check, ['init', '-q']);
      git(check, ['index-pack', '-o', join(check, 'x.idx'), join(packDir, pack)]);
      assert.deepEqual(readFileSync(join(check, 'x.idx')), readFileSync(join(packDir, pack.replace(/pack$/, 'idx'))), pack + ': idx equals git index-pack');
    }
    git(out, ['fsck', '--full', '--no-dangling']);

    const reference = join(work, 'reference');
    git(work, ['clone', '-q', '--depth', '1', 'file://' + join(served, 'repo.git'), reference]);
    assert.equal(git(out, ['ls-files', '-s']), git(reference, ['ls-files', '-s']), 'index entries equal git clone --depth 1');
    assert.equal(readFileSync(join(out, '.git/config'), 'utf8').replace(/url = .*/, 'url = X'), readFileSync(join(reference, '.git/config'), 'utf8').replace(/url = .*/, 'url = X'));
    assert.equal(readFileSync(join(out, '.git/shallow'), 'utf8'), readFileSync(join(reference, '.git/shallow'), 'utf8'));
    assert.equal(git(out, ['rev-parse', 'HEAD', 'origin/main', 'origin/HEAD']), git(reference, ['rev-parse', 'HEAD', 'origin/main', 'origin/HEAD']));
    for (const path of git(reference, ['ls-files']).trim().split('\n')) {
      assert.deepEqual(readFileSync(join(out, path)), readFileSync(join(reference, path)), path);
      assert.equal(statSync(join(out, path)).mode & 0o111, statSync(join(reference, path)).mode & 0o111, path + ' mode');
    }
    // Every index entry carries the stat the session reported for its path.
    const index = readFileSync(join(out, '.git/index'));
    assert.equal(index.readUInt32BE(8), 305);
    let at = 12;
    let checked = 0;
    for (let i = 0; i < 305; i++) {
      const nameLength = index.readUInt16BE(at + 60) & 0xfff;
      const path = index.subarray(at + 62, at + 62 + nameLength).toString();
      const stat = session.stats.get('home/user/repo/' + path);
      if ((index.readUInt32BE(at + 24) & 0o170000) !== 0o160000) {
        assert.ok(stat, 'a stat for ' + path);
        assert.equal(index.readUInt32BE(at + 20), stat.ino, path + ' ino');
        assert.equal(index.readUInt32BE(at + 8), Math.floor(stat.mtimeMs / 1000), path + ' mtime');
        assert.equal(index.readUInt32BE(at + 12), (stat.mtimeMs % 1000) * 1e6, path + ' mtime ns');
        assert.equal(index.readUInt32BE(at), Math.floor(stat.ctimeMs / 1000), path + ' ctime');
        assert.equal(index.readUInt32BE(at + 16), stat.dev, path + ' dev');
        assert.equal(index.readUInt32BE(at + 36), stat.size, path + ' size');
        checked++;
      }
      at += Math.ceil((62 + nameLength + 1) / 8) * 8;
    }
    assert.equal(checked, 305);
    assert.ok(session.counters.fsReadRange <= prepared.batches.length * 2 + 3, 'packs are not read back: ' + session.counters.fsReadRange);
  } finally {
    server.stop();
  }
  console.log('git-pack-clone: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
