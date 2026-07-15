#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cfGitDir = resolve(repoRoot, 'packages/worker/node_modules/isomorphic-git');
const sourcePath = resolve(process.env.CF_GIT_SOURCE || join(cfGitDir, 'index.js'));
const patchPath = resolve(
  repoRoot,
  'packages/worker/patches/@ashishkumar472+cf-git+1.0.5.patch',
);
const fixturePath = resolve(repoRoot, 'tests/fixtures/cf-git-indexer/real.pack');
const temporaryPaths = [];

function pristineSourceFromPatch(source) {
  const directory = mkdtempSync(join(tmpdir(), 'nimbus-cf-git-pristine-'));
  temporaryPaths.push(directory);
  writeFileSync(join(directory, 'index.js'), source);
  const result = spawnSync(
    'git',
    ['apply', '--no-index', '--unidiff-zero', '--reverse', patchPath],
    { cwd: directory, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `could not reconstruct pristine cf-git: ${result.stderr || result.stdout}`,
  );
  return readFileSync(join(directory, 'index.js'), 'utf8');
}

async function loadInternals(source, label) {
  const instrumentedPath = join(
    cfGitDir,
    `.nimbus-indexer-${label}-${process.pid}-${randomUUID()}.mjs`,
  );
  temporaryPaths.push(instrumentedPath);
  writeFileSync(
    instrumentedPath,
    `${source}\nexport { GitPackIndex, pako };\n`,
  );
  return import(`${pathToFileURL(instrumentedPath).href}?v=${randomUUID()}`);
}

const optimizedSource = readFileSync(sourcePath, 'utf8');
const optimized = await loadInternals(optimizedSource, 'optimized');
const pristine = await loadInternals(
  pristineSourceFromPatch(optimizedSource),
  'pristine',
);

function encodePackObjectHeader(type, size) {
  const bytes = [(type << 4) | (size & 0x0f)];
  size >>>= 4;
  if (size > 0) bytes[0] |= 0x80;
  while (size > 0) {
    const byte = size & 0x7f;
    size >>>= 7;
    bytes.push(size > 0 ? byte | 0x80 : byte);
  }
  return Buffer.from(bytes);
}

function encodeDeltaSize(size) {
  const bytes = [];
  do {
    let byte = size & 0x7f;
    size >>>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  } while (size > 0);
  return Buffer.from(bytes);
}

function encodeOfsDistance(distance) {
  const bytes = [distance & 0x7f];
  while ((distance >>>= 7) > 0) {
    distance -= 1;
    bytes.unshift(0x80 | (distance & 0x7f));
  }
  return Buffer.from(bytes);
}

function objectOid(type, object) {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${object.length}\0`))
    .update(object)
    .digest('hex');
}

function literalDelta(base, target) {
  assert.ok(target.length > 0 && target.length < 128);
  return Buffer.concat([
    encodeDeltaSize(base.length),
    encodeDeltaSize(target.length),
    Buffer.from([target.length]),
    target,
  ]);
}

function finishPack(entries) {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function buildStandalonePack() {
  const objects = [
    ['commit', 1, Buffer.from('tree 0000000000000000000000000000000000000000\n')],
    ['tree', 2, Buffer.from('100644 fixture.txt\0fixture-tree-bytes')],
    ['blob', 3, Buffer.from('standalone blob')],
    ['tag', 4, Buffer.from('object 0000000000000000000000000000000000000000\n')],
  ];
  return finishPack(objects.map(([, packType, object]) => Buffer.concat([
    encodePackObjectHeader(packType, object.length),
    deflateSync(object),
  ])));
}

function buildDeepDeltaPack(deltaType) {
  const entries = [];
  const offsets = [];
  const objects = [];
  let currentOffset = 12;

  const push = (entry) => {
    offsets.push(currentOffset);
    entries.push(entry);
    currentOffset += entry.length;
  };

  let previous = Buffer.from(`${deltaType}-base`);
  objects.push(previous);
  push(Buffer.concat([
    encodePackObjectHeader(3, previous.length),
    deflateSync(previous),
  ]));

  for (let depth = 1; depth <= 8; depth++) {
    const target = Buffer.from(`${deltaType}-delta-${depth}`);
    const delta = literalDelta(previous, target);
    const reference = deltaType === 'ofs'
      ? encodeOfsDistance(currentOffset - offsets.at(-1))
      : Buffer.from(objectOid('blob', previous), 'hex');
    push(Buffer.concat([
      encodePackObjectHeader(deltaType === 'ofs' ? 6 : 7, delta.length),
      reference,
      deflateSync(delta),
    ]));
    objects.push(target);
    previous = target;
  }

  return { pack: finishPack(entries), objects };
}

function buildExternalRefDeltaPack() {
  const base = Buffer.from('external-base');
  const target = Buffer.from('external-target');
  const delta = literalDelta(base, target);
  return {
    base,
    baseOid: objectOid('blob', base),
    pack: finishPack([Buffer.concat([
      encodePackObjectHeader(7, delta.length),
      Buffer.from(objectOid('blob', base), 'hex'),
      deflateSync(delta),
    ])]),
    target,
  };
}

function buildDuplicateRepresentationPack() {
  const base = Buffer.from('duplicate-base');
  const target = Buffer.from('duplicate-target');
  const baseEntry = Buffer.concat([
    encodePackObjectHeader(3, base.length),
    deflateSync(base),
  ]);
  const delta = literalDelta(base, target);
  const deltaOffset = 12 + baseEntry.length;
  const deltaEntry = Buffer.concat([
    encodePackObjectHeader(6, delta.length),
    encodeOfsDistance(deltaOffset - 12),
    deflateSync(delta),
  ]);
  const duplicateEntry = Buffer.concat([
    encodePackObjectHeader(3, target.length),
    deflateSync(target),
  ]);
  return finishPack([baseEntry, deltaEntry, duplicateEntry]);
}

function snapshot(index) {
  return {
    hashes: [...index.hashes],
    offsets: index.hashes.map((hash) => [hash, index.offsets.get(hash)]),
    crcs: index.hashes.map((hash) => [hash, index.crcs[hash]]),
    packfileSha: index.packfileSha,
  };
}

async function assertPackMatchesPristine(pack, options = {}) {
  const pristineIndex = await pristine.GitPackIndex.fromPack({ pack, ...options });
  const optimizedIndex = await optimized.GitPackIndex.fromPack({ pack, ...options });

  assert.deepEqual(snapshot(optimizedIndex), snapshot(pristineIndex));
  assert.deepEqual(await optimizedIndex.toBuffer(), await pristineIndex.toBuffer());

  for (const oid of pristineIndex.hashes) {
    const pristineObject = await pristineIndex.read({ oid });
    const optimizedObject = await optimizedIndex.read({ oid });
    assert.equal(optimizedObject.type, pristineObject.type, oid);
    assert.deepEqual(optimizedObject.object, pristineObject.object, oid);
  }

  return { optimizedIndex, pristineIndex };
}

function deterministicHashes(count) {
  let state = 0x9e3779b9;
  const hashes = new Set();
  while (hashes.size < count) {
    const bytes = Buffer.alloc(20);
    for (let i = 0; i < bytes.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[i] = state & 0xff;
    }
    hashes.add(bytes.toString('hex'));
  }
  return [...hashes].sort();
}

function syntheticIndex(Module, hashes) {
  const crcs = Object.fromEntries(hashes.map((hash, index) => [hash, index * 17]));
  const offsets = new Map(hashes.map((hash, index) => [hash, 12 + index * 31]));
  return new Module.GitPackIndex({
    crcs,
    hashes,
    offsets,
    packfileSha: 'ab'.repeat(20),
  });
}

async function countSecondPassInflations(Module, pack) {
  const originalInflate = Module.pako.inflate;
  let count = 0;
  Module.pako.inflate = (...args) => {
    count++;
    return originalInflate(...args);
  };
  try {
    await Module.GitPackIndex.fromPack({ pack });
  } finally {
    Module.pako.inflate = originalInflate;
  }
  return count;
}

const cases = [
  ['captured real Git pack is byte-exact to pristine', async () => {
    await assertPackMatchesPristine(readFileSync(fixturePath));
  }],
  ['non-delta object types are byte-exact and avoid second-pass inflation', async () => {
    const pack = buildStandalonePack();
    await assertPackMatchesPristine(pack);
    assert.equal(await countSecondPassInflations(pristine, pack), 4);
    assert.equal(await countSecondPassInflations(optimized, pack), 0);
  }],
  ['deep ofs-delta and ref-delta chains are byte-exact to pristine', async () => {
    for (const deltaType of ['ofs', 'ref']) {
      const fixture = buildDeepDeltaPack(deltaType);
      const { optimizedIndex } = await assertPackMatchesPristine(fixture.pack);
      const target = fixture.objects.at(-1);
      const result = await optimizedIndex.read({ oid: objectOid('blob', target) });
      assert.deepEqual(result.object, target);
    }
  }],
  ['external ref-delta resolution remains byte-exact to pristine', async () => {
    const fixture = buildExternalRefDeltaPack();
    const getExternalRefDelta = async (oid) => {
      assert.equal(oid, fixture.baseOid);
      return { type: 'blob', object: fixture.base };
    };
    const { optimizedIndex } = await assertPackMatchesPristine(
      fixture.pack,
      { getExternalRefDelta },
    );
    const result = await optimizedIndex.read({ oid: objectOid('blob', fixture.target) });
    assert.deepEqual(result.object, fixture.target);
  }],
  ['duplicate delta and non-delta representations preserve pack-order metadata', async () => {
    await assertPackMatchesPristine(buildDuplicateRepresentationPack());
  }],
  ['fanout is byte-exact to pristine and scans hashes once', async () => {
    for (const count of [1, 17, 257, 1024]) {
      const hashes = deterministicHashes(count);
      const optimizedIndex = syntheticIndex(optimized, hashes);
      const pristineIndex = syntheticIndex(pristine, hashes);
      const originalParseInt = globalThis.parseInt;
      let prefixParses = 0;
      globalThis.parseInt = (...args) => {
        prefixParses++;
        return originalParseInt(...args);
      };
      let optimizedBuffer;
      try {
        optimizedBuffer = await optimizedIndex.toBuffer();
      } finally {
        globalThis.parseInt = originalParseInt;
      }
      assert.ok(
        prefixParses <= hashes.length,
        `fanout parsed ${prefixParses} prefixes for ${hashes.length} hashes`,
      );
      assert.deepEqual(optimizedBuffer, await pristineIndex.toBuffer());
    }
  }],
];

const failures = [];
try {
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`cf-git-indexer: ${name}: ok`);
    } catch (error) {
      failures.push(new Error(name, { cause: error }));
      console.error(`cf-git-indexer: ${name}: failed: ${error.message}`);
    }
  }
} finally {
  for (const path of temporaryPaths.reverse()) rmSync(path, { force: true, recursive: true });
}

if (failures.length > 0) {
  throw new AggregateError(failures, `${failures.length} cf-git indexer test(s) failed`);
}
