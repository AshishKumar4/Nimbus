#!/usr/bin/env bun
// The pack reader (git/pack/reader.ts) on a pack host git made with a long
// delta chain (repack --depth=50) of a large file rewritten a little at a
// time: the deepest object reads back as git cat-file has it, and its
// chain is applied one delta at a time. The walk to the base reads only
// headers; each delta's payload is inflated as it is applied and the result
// cached before the next is read, so a long chain of large deltas never
// holds more than one of them.
//
// A one-shot read (rememberTarget false, the store's) caches the chain's
// bases but not the object asked for, as git's delta_base_cache does.
//
// Red before: every delta of the chain was inflated on the way down, and
// all were applied on the way back up; and every target was cached.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PackObjectResolver, runSync } from '../../packages/worker/src/git/pack/reader.ts';
import { MAX_OBJECT_HEADER_BYTES, PACK_TRAILER_BYTES } from '../../packages/worker/src/git/pack/format.ts';
import { hostGit as hostGitIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-pack-reader-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);

try {
  const repo = join(work, 'repo');
  hostGit(work, ['init', '-q', '-b', 'main', repo]);
  let seed = 3;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} ${Math.floor(random() * 1e9).toString(36)}\n`);
  for (let rev = 0; rev < 40; rev++) {
    for (let k = 0; k < 40; k++) lines[Math.floor(random() * lines.length)] = `rev ${rev} ${k} ${Math.floor(random() * 1e9).toString(36)}\n`;
    writeFileSync(join(repo, 'big.txt'), lines.join(''));
    hostGit(repo, ['add', '-A']);
    hostGit(repo, ['commit', '-q', '-m', `r${rev}`]);
  }
  hostGit(repo, ['repack', '-adfq', '--depth=50', '--window=50']);
  const packDir = join(repo, '.git/objects/pack');
  const packName = readdirSync(packDir).find((name) => name.endsWith('.pack'));
  const pack = readFileSync(join(packDir, packName));
  const verify = spawnSync('git', ['verify-pack', '-v', join(packDir, packName.replace(/pack$/, 'idx'))], { encoding: 'utf8' }).stdout;
  // oid type size size-in-pack offset depth base
  const deepest = verify.split('\n').map((line) => line.split(/\s+/))
    .filter((f) => f.length === 7 && f[1] === 'blob')
    .sort((a, b) => Number(b[5]) - Number(a[5]))[0];
  const [oid, , , , offset, depth] = deepest;
  assert.ok(Number(depth) >= 10, 'the fixture made a chain of ' + depth);

  const events = [];
  const cache = new Map();
  const resolver = new PackObjectResolver({
    file: 'pack',
    dataEnd: pack.byteLength - PACK_TRAILER_BYTES,
    cache: {
      get: (at) => cache.get(at),
      set: (at, object) => { cache.set(at, object); events.push({ set: at }); },
    },
    refBase: () => { throw new Error('the pack has no ref-deltas'); },
  });
  const object = runSync(resolver.objectAt(Number(offset)), (range) => {
    events.push({ read: range.offset, length: range.length });
    return pack.subarray(range.offset, range.offset + range.length);
  });
  const expected = spawnSync('git', ['-C', repo, 'cat-file', 'blob', oid]).stdout;
  assert.equal(object.type, 'blob');
  assert.deepEqual(Buffer.from(object.data), expected, 'the object reads as git has it');

  // Every link of the chain is cached; between two payload reads, the earlier link was applied.
  assert.equal(events.filter((e) => 'set' in e).length, Number(depth) + 1);
  // (An entry is read once more at its deflate bound when the first read is short: one entry still.)
  const inflatedUnapplied = new Set();
  let most = 0;
  for (const event of events) {
    if ('read' in event && event.length > MAX_OBJECT_HEADER_BYTES) {
      inflatedUnapplied.add(event.read);
      most = Math.max(most, inflatedUnapplied.size);
    }
    if ('set' in event) inflatedUnapplied.clear();
  }
  assert.equal(most, 1, 'deltas inflated before the one before them was applied: ' + most);

  // A one-shot read (the store's, for a command) caches the bases it is built on, not itself.
  cache.clear();
  events.length = 0;
  const again = runSync(resolver.objectAt(Number(offset), false), (range) => pack.subarray(range.offset, range.offset + range.length));
  assert.deepEqual(Buffer.from(again.data), expected);
  assert.equal(events.filter((e) => 'set' in e).length, Number(depth), 'the requested object was cached');
  assert.equal(cache.has(Number(offset)), false);
  const plain = verify.split('\n').map((line) => line.split(/\s+/)).find((f) => f.length === 5 && f[1] === 'blob');
  events.length = 0;
  runSync(resolver.objectAt(Number(plain[4]), false), (range) => pack.subarray(range.offset, range.offset + range.length));
  assert.equal(events.filter((e) => 'set' in e).length, 0, 'a non-delta one-shot read was cached');
  console.log('git-pack-reader: ok (chain depth ' + depth + ')');
} finally {
  rmSync(work, { recursive: true, force: true });
}
