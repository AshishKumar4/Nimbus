// The streaming pack processor against git itself (host git 2.x):
//   - its .idx is byte-identical to `git index-pack`'s for the same pack:
//     a recorded GitHub pack, and packs git builds here with ofs-deltas,
//     ref-deltas, entries longer than the first inflate attempt, and >64 KiB
//     objects;
//   - the pack it stores is the stream's bytes, whatever the chunking;
//   - stopped at its work budget after any entry and resumed from the stored
//     pack, it ends with the same idx;
//   - a thin pack is completed (index-pack --fix-thin): git verifies the
//     result and indexes it to the same idx;
//   - a wrong trailer, junk after the trailer, and an overflowing size are refused.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PackStreamProcessor } from '../../packages/worker/src/git/pack/processor.ts';
import { encodeIdxV2 } from '../../packages/worker/src/git/pack/idx.ts';
import { PackFormatError, oidToHex } from '../../packages/worker/src/git/pack/format.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = mkdtempSync(join(tmpdir(), 'nimbus-pack-stream-'));

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, maxBuffer: 1 << 30, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: work } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.error ?? ''} ${result.signal ?? ''} ${result.stderr}`);
  return result.stdout;
}

/** The pack's bytes as a stream of pieces whose sizes come from `sizes`, cycled. */
async function* chunked(bytes, sizes) {
  let i = 0;
  for (let at = 0; at < bytes.byteLength;) {
    const size = sizes[i++ % sizes.length];
    yield bytes.slice(at, at + size);
    at += size;
  }
}

function memoryStore() {
  let bytes = new Uint8Array(1 << 16);
  let size = 0;
  return {
    get bytes() { return bytes.subarray(0, size); },
    async append(piece) {
      if (size + piece.byteLength > bytes.byteLength) {
        const grown = new Uint8Array(Math.max(bytes.byteLength * 2, size + piece.byteLength));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(piece, size);
      size += piece.byteLength;
    },
    async writeAt(offset, piece) {
      assert.ok(offset + piece.byteLength <= size, 'writeAt past the end');
      bytes.set(piece, offset);
    },
    async truncate(to) {
      assert.ok(to <= size, 'truncate past the end');
      size = to;
    },
    async read(offset, length) {
      assert.ok(offset + length <= size, `read ${offset}+${length} past ${size}`);
      return bytes.slice(offset, offset + length);
    },
  };
}

async function idxOf(result) {
  const pieces = [];
  for await (const piece of encodeIdxV2(result.objects, result.packSha, async function* () { yield result.entries; })) pieces.push(piece);
  return Buffer.concat(pieces);
}

async function processWhole(pack, options = {}) {
  const store = memoryStore();
  const result = await new PackStreamProcessor({ store, ...options }).run(chunked(pack, options.sizes ?? [65516]));
  return { store, result };
}

/** Process with a budget that stops after every few entries, resuming until done. */
async function processResumed(pack, budgetUnits, options = {}) {
  const store = memoryStore();
  let result = await new PackStreamProcessor({ store, budgetUnits, ...options }).run(chunked(pack, [7, 4096, 65516]));
  let invocations = 1;
  while (result.checkpoint !== null) {
    result = await new PackStreamProcessor({ store, budgetUnits, ...options }).resume(result.checkpoint, result.packBytes);
    invocations++;
  }
  return { store, result, invocations };
}

function gitIndexPack(pack, extraArgs = []) {
  const dir = mkdtempSync(join(work, 'ip-'));
  // Inside a repository: git 2.53's index-pack --strict segfaults outside one.
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'in.pack'), pack);
  git(dir, ['index-pack', ...extraArgs, '-o', join(dir, 'out.idx'), join(dir, 'in.pack')]);
  return readFileSync(join(dir, 'out.idx'));
}

function packOf(repo) {
  const dir = join(repo, '.git/objects/pack');
  const name = readdirSync(dir).find((file) => file.endsWith('.pack'));
  return { pack: readFileSync(join(dir, name)), idx: readFileSync(join(dir, name.replace(/\.pack$/, '.idx'))) };
}

/** A repository with history, similar files (deltas), a large text and a binary. */
function makeRepo(name) {
  const repo = join(work, name);
  git(work, ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const words = Array.from({ length: 400 }, (_, i) => 'word' + i.toString(36));
  const text = (n) => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(' ') + '\n';
  for (let commit = 0; commit < 6; commit++) {
    for (let f = 0; f < 30; f++) writeFileSync(join(repo, `f${f}.txt`), text(200 + f * 20 + commit * 5) + `rev ${commit}\n`);
    writeFileSync(join(repo, 'large.txt'), text(60_000) + `rev ${commit}\n`);
    const binary = new Uint8Array(300_000);
    for (let i = 0; i < binary.length; i++) binary[i] = Math.floor(random() * 256);
    writeFileSync(join(repo, 'random.bin'), binary);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `c${commit}`]);
  }
  return repo;
}

try {
  // A recorded GitHub pack.
  {
    const pack = readFileSync(join(repoRoot, 'tests/fixtures/cf-git-indexer/real.pack'));
    const expected = gitIndexPack(pack);
    const { store, result } = await processWhole(pack, { sizes: [1, 13, 65516, 4096] });
    assert.deepEqual(Buffer.from(store.bytes), pack, 'stored pack equals the stream');
    assert.deepEqual(await idxOf(result), expected, 'recorded pack: idx equals git index-pack');
  }

  // git-built packs: ofs-deltas, then ref-deltas.
  const repo = makeRepo('history');
  git(repo, ['repack', '-adf', '-q', '--depth=20', '--window=20']);
  const { pack: ofsPack, idx: ofsIdx } = packOf(repo);
  {
    const { store, result } = await processWhole(ofsPack, { sizes: [3, 65516, 100_000, 17] });
    assert.deepEqual(Buffer.from(store.bytes), ofsPack);
    assert.deepEqual(await idxOf(result), ofsIdx, 'ofs-delta pack: idx equals git');
    assert.ok(result.work.deltaBytes > 0, 'the fixture has deltas');
  }
  {
    // A cache too small for any base: every delta re-reads its chain from the stored pack.
    const { result } = await processWhole(ofsPack, { cacheBytes: 2 });
    assert.deepEqual(await idxOf(result), ofsIdx, 'with no cache: idx equals git');
    assert.ok(result.work.baseRereads > 0);
  }
  {
    const refPack = git(repo, ['pack-objects', '--stdout', '--no-delta-base-offset', '--all', '--window=20', '--depth=20'], '');
    const { result } = await processWhole(refPack, { cacheBytes: 2 });
    assert.deepEqual(await idxOf(result), gitIndexPack(refPack), 'ref-delta pack: idx equals git');
  }

  // Stopped at the budget after (nearly) every entry, resumed from the store.
  {
    const { result, invocations } = await processResumed(ofsPack, 1);
    assert.deepEqual(await idxOf(result), ofsIdx, 'resumed every entry: idx equals git');
    assert.ok(invocations > 100, 'it stopped at every entry: ' + invocations);
    const { result: halves } = await processResumed(ofsPack, 2_000_000);
    assert.deepEqual(await idxOf(halves), ofsIdx);
  }

  // A thin pack: deltas against objects the receiver already has.
  {
    const thinRepo = makeRepo('thin');
    const old = git(thinRepo, ['rev-parse', 'HEAD~2']).toString().trim();
    const thin = git(thinRepo, ['pack-objects', '--stdout', '--thin', '--revs'], `HEAD\n^${old}\n`);
    const objects = new Map();
    const external = {
      async read(oid) {
        const hex = oidToHex(oid);
        const type = spawnSync('git', ['cat-file', '-t', hex], { cwd: thinRepo });
        if (type.status !== 0) return null;
        objects.set(hex, true);
        return { type: type.stdout.toString().trim(), data: new Uint8Array(git(thinRepo, ['cat-file', type.stdout.toString().trim(), hex])) };
      },
    };
    const { store, result } = await processWhole(thin, { external });
    assert.ok(result.appendedBases > 0, 'the thin pack needed bases');
    assert.equal(result.appendedBases, objects.size);
    const completed = Buffer.from(store.bytes);
    assert.deepEqual(await idxOf(result), gitIndexPack(completed), 'completed thin pack: git indexes it to the same idx');
    const resumed = await processResumed(thin, 1, { external });
    assert.deepEqual(await idxOf(resumed.result), await idxOf(result), 'thin, resumed: same idx');
  }

  // Refusals.
  {
    const wrongTrailer = Buffer.from(ofsPack);
    wrongTrailer[wrongTrailer.length - 1] ^= 1;
    await assert.rejects(processWhole(wrongTrailer), (error) => error instanceof PackFormatError && /trailer/.test(error.message));
    const junk = Buffer.concat([ofsPack.subarray(0, ofsPack.length - 20), Buffer.from('junk'), ofsPack.subarray(ofsPack.length - 20)]);
    await assert.rejects(processWhole(junk), PackFormatError);
    const overflow = Buffer.from(ofsPack);
    overflow.set([0x9f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], 12);
    await assert.rejects(processWhole(overflow), (error) => error instanceof PackFormatError && /overflow/.test(error.message));
  }

  console.log('git-pack-stream: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
