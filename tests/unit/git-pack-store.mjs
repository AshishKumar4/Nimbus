// The ranged pack store (git/pack/store.ts) against git cat-file: every
// object of a repository packed by git (ofs-deltas, then ref-deltas) and of a
// thin pack completed by the stream processor (ref-deltas to bases appended
// at its end) reads back with git's type and bytes; prefixes expand as git
// disambiguates them; nothing is read whole, and no read is longer than a
// 1 MiB page, however large the object (a facet's reads cross an RPC that
// refuses large ones).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PackObjectStore } from '../../packages/worker/src/git/pack/store.ts';
import { PackStreamProcessor } from '../../packages/worker/src/git/pack/processor.ts';
import { encodeIdxV2 } from '../../packages/worker/src/git/pack/idx.ts';
import { oidToHex } from '../../packages/worker/src/git/pack/format.ts';

const work = mkdtempSync(join(tmpdir(), 'nimbus-pack-store-'));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: work, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, env, maxBuffer: 1 << 28 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function nodeFs() {
  const reads = [];
  return {
    reads,
    async readRange(path, offset, length) {
      const fd = openSync(path, 'r');
      try {
        const size = statSync(path).size;
        const n = Math.max(0, Math.min(length, size - offset));
        const out = new Uint8Array(n);
        readSync(fd, out, 0, n, offset);
        if (path.endsWith('.pack')) reads.push(n);
        return out;
      } finally { closeSync(fd); }
    },
    async readdir(dir) { try { return readdirSync(dir); } catch { return []; } },
  };
}

function makeRepo(name) {
  const repo = join(work, name);
  git(work, ['init', '-q', '-b', 'main', repo]);
  let seed = 3;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const words = Array.from({ length: 300 }, (_, i) => 'w' + i.toString(36));
  const text = (n) => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(' ') + '\n';
  for (let commit = 0; commit < 5; commit++) {
    mkdirSync(join(repo, 'd0'), { recursive: true });
    mkdirSync(join(repo, 'd1'), { recursive: true });
    for (let f = 0; f < 20; f++) writeFileSync(join(repo, `d${f % 2}/f${f}.txt`), text(300 + f * 30) + `rev ${commit}\n`);
    writeFileSync(join(repo, 'big.txt'), text(40_000) + `rev ${commit}\n`);
    if (commit === 2) writeFileSync(join(repo, 'large.bin'), Buffer.from(crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024))));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `c${commit}`]);
  }
  return repo;
}

/** Every object git has, against what the store reads. */
async function compareAll(repo, gitdir) {
  const fs = nodeFs();
  const store = new PackObjectStore(fs, gitdir, { cacheBytes: 64 * 1024 });
  const ids = git(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)']).toString().trim().split('\n');
  let largest = 0;
  for (const line of ids) {
    const [oid, type, size] = line.split(' ');
    const object = await store.read(oid);
    assert.ok(object, oid + ' is found');
    assert.equal(object.type, type, oid + ' type');
    assert.equal(object.data.byteLength, Number(size), oid + ' size');
    assert.deepEqual(Buffer.from(object.data), git(repo, ['cat-file', type, oid]), oid + ' bytes');
    largest = Math.max(largest, Number(size));
  }
  assert.equal(await store.read('0'.repeat(40)), null);
  assert.equal(await store.has(ids[0].split(' ')[0]), true);
  const prefix = ids[0].slice(0, 3);
  const expected = ids.map((line) => line.split(' ')[0]).filter((oid) => oid.startsWith(prefix)).sort();
  assert.deepEqual((await store.expand(prefix)).sort(), expected, 'expand ' + prefix);
  // A pack is read a 1 MiB page at a time, even for its 3 MiB object: never whole.
  const maxRead = Math.max(...fs.reads);
  assert.ok(largest >= 3 << 20, 'the fixture holds a large object');
  assert.ok(maxRead <= 1 << 20, `largest pack read ${maxRead}, largest object ${largest}`);
  return ids.length;
}

try {
  const repo = makeRepo('repo');
  git(repo, ['repack', '-adf', '-q', '--depth=20', '--window=20']);
  assert.ok(await compareAll(repo, join(repo, '.git')) > 100);

  // ref-deltas, in a pack git writes without offsets.
  const refRepo = join(work, 'refrepo');
  git(work, ['clone', '-q', '--bare', '--no-local', repo, refRepo]);
  for (const name of readdirSync(join(refRepo, 'objects/pack'))) rmSync(join(refRepo, 'objects/pack', name));
  git(repo, ['pack-objects', '--no-delta-base-offset', '--all', '-q', join(refRepo, 'objects/pack/pack')], '');
  await compareAll(refRepo, refRepo);

  // A thin pack completed by the processor: its ref-deltas reach bases appended at its end.
  const old = git(repo, ['rev-parse', 'HEAD~2']).toString().trim();
  const thin = git(repo, ['pack-objects', '--stdout', '--thin', '--revs'], `HEAD\n^${old}\n`);
  let stored = new Uint8Array(0);
  const store = {
    async append(piece) { const next = new Uint8Array(stored.byteLength + piece.byteLength); next.set(stored); next.set(piece, stored.byteLength); stored = next; },
    async writeAt(offset, piece) { stored.set(piece, offset); },
    async truncate(size) { stored = stored.slice(0, size); },
    async read(offset, length) { return stored.slice(offset, offset + length); },
  };
  const external = {
    async read(oid) {
      const hex = oidToHex(oid);
      const type = spawnSync('git', ['cat-file', '-t', hex], { cwd: repo, env });
      if (type.status !== 0) return null;
      const name = type.stdout.toString().trim();
      return { type: name, data: new Uint8Array(git(repo, ['cat-file', name, hex])) };
    },
  };
  async function* chunks() { yield thin; }
  const result = await new PackStreamProcessor({ store, external }).run(chunks());
  assert.ok(result.appendedBases > 0);
  const thinGitdir = join(work, 'thin.git');
  git(work, ['init', '-q', '--bare', thinGitdir]);
  const name = 'pack-' + oidToHex(result.packSha);
  writeFileSync(join(thinGitdir, 'objects/pack', name + '.pack'), stored);
  const idx = [];
  for await (const piece of encodeIdxV2(result.objects, result.packSha, async function* () { yield result.entries; })) idx.push(piece);
  writeFileSync(join(thinGitdir, 'objects/pack', name + '.idx'), Buffer.concat(idx));
  const thinStore = new PackObjectStore(nodeFs(), thinGitdir, { cacheBytes: 1024 });
  for (const line of git(thinGitdir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).toString().trim().split('\n')) {
    const [oid, type] = line.split(' ');
    const object = await thinStore.read(oid);
    assert.equal(object?.type, type, oid);
    assert.deepEqual(Buffer.from(object.data), git(thinGitdir, ['cat-file', type, oid]), oid + ' (thin)');
  }
  console.log('git-pack-store: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
