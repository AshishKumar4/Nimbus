#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

import { resolvePackageDir } from '../../packages/worker/scripts/resolve-package-dir.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cfGitDir = resolvePackageDir('isomorphic-git', { start: join(repoRoot, 'packages/worker') });
const sourcePath = resolve(process.env.CF_GIT_SOURCE || join(cfGitDir, 'index.js'));
const source = readFileSync(sourcePath, 'utf8');
const hasSeedHelper = /function seedPackfileCache\(/.test(source);
const instrumentedPath = join(
  cfGitDir,
  `.nimbus-checkout-repairs-${process.pid}-${randomUUID()}.mjs`,
);
const internalExports = [
  'GitPackIndex',
  'GitWalkerFs',
  'PackfileCache',
  'batchAllSettled',
  'readObjectPacked',
  'worthWalking',
];
if (hasSeedHelper) internalExports.push('seedPackfileCache');

writeFileSync(
  instrumentedPath,
  `${source}\nexport { ${internalExports.join(', ')}, updateIndex as updateIndexInternal };\n`,
);

let internals;
try {
  internals = await import(`${pathToFileURL(instrumentedPath).href}?v=${randomUUID()}`);
} finally {
  rmSync(instrumentedPath, { force: true });
}

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

function blobOid(content) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${content.length}\0`))
    .update(content)
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

function buildDeepDeltaPack(deltaType) {
  const entries = [];
  const offsets = [];
  const contents = [Buffer.from('delta-base')];
  let currentOffset = 12;

  const pushEntry = (entry) => {
    offsets.push(currentOffset);
    entries.push(entry);
    currentOffset += entry.length;
  };

  const base = contents[0];
  pushEntry(Buffer.concat([
    encodePackObjectHeader(3, base.length),
    deflateSync(base),
  ]));

  for (let depth = 1; depth <= 6; depth++) {
    const previous = contents.at(-1);
    const target = Buffer.from(`delta-${depth}`);
    const delta = literalDelta(previous, target);
    const prefix = deltaType === 'ofs'
      ? encodeOfsDistance(currentOffset - offsets.at(-1))
      : Buffer.from(blobOid(previous), 'hex');
    pushEntry(Buffer.concat([
      encodePackObjectHeader(deltaType === 'ofs' ? 6 : 7, delta.length),
      prefix,
      deflateSync(delta),
    ]));
    contents.push(target);
  }

  const shallowContents = Array.from(
    { length: 8 },
    (_, index) => Buffer.from(`standalone-${index}`),
  );
  for (const content of shallowContents) {
    pushEntry(Buffer.concat([
      encodePackObjectHeader(3, content.length),
      deflateSync(content),
    ]));
  }

  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  const trailer = createHash('sha1').update(body).digest();

  return {
    pack: Buffer.concat([body, trailer]),
    target: contents.at(-1),
    targetOid: blobOid(contents.at(-1)),
    shallowOids: shallowContents.map(blobOid),
  };
}

async function loadPackIndex(deltaType, origin) {
  const fixture = buildDeepDeltaPack(deltaType);
  const fromPack = await internals.GitPackIndex.fromPack({ pack: fixture.pack });
  let index = fromPack;
  if (origin === 'fromIdx') {
    index = await internals.GitPackIndex.fromIdx({ idx: await fromPack.toBuffer() });
    await index.load({ pack: Promise.resolve(fixture.pack) });
  }
  index.offsetCache = {};
  return { fixture, index };
}

async function assertDeepCacheBehavior(deltaType, origin) {
  const { fixture, index } = await loadPackIndex(deltaType, origin);
  const result = await index.read({ oid: fixture.targetOid });
  assert.deepEqual(result.object, fixture.target);
  assert.equal(
    Object.keys(index.offsetCache).length,
    4,
    `${origin} ${deltaType} read did not cache only stack depths greater than three`,
  );

  await Promise.all(
    fixture.shallowOids.map((oid) => index.read({ oid })),
  );
  assert.equal(
    Object.keys(index.offsetCache).length,
    4,
    `${origin} ${deltaType} shallow reads polluted the resolved-delta cache`,
  );
}

const cases = [
  ['deep delta caching uses per-read stack state', async () => {
    for (const deltaType of ['ofs', 'ref']) {
      for (const origin of ['fromPack', 'fromIdx']) {
        await assertDeepCacheBehavior(deltaType, origin);
      }
    }
  }],
  ['batchAllSettled rejects incomplete work', async () => {
    await assert.rejects(
      () => internals.batchAllSettled(
        'Checkout files',
        [() => Promise.resolve('ok'), () => Promise.reject(new Error('write failed'))],
        undefined,
        2,
      ),
      (error) => error?.code === 'InternalError'
        && error.data?.message.includes('1 of 2')
        && error.data.message.includes('write failed'),
    );
  }],
  ['index insertion failures propagate', async () => {
    const failure = new Error('index insert failed');
    await assert.rejects(
      () => internals.updateIndexInternal({
        index: { insert: () => { throw failure; } },
        fullpath: 'file.txt',
        stats: {},
        oid: '0'.repeat(40),
      }),
      (error) => error === failure,
    );
  }],
  ['fetched pack index seed matches packed-object lookup', async () => {
    assert.equal(hasSeedHelper, true, 'cf-git does not expose the _fetch cache seed seam');
    const gitdir = '/repo/.git';
    const fixture = buildDeepDeltaPack('ofs');
    const index = await internals.GitPackIndex.fromPack({ pack: fixture.pack });
    const cache = {};
    internals.seedPackfileCache({
      cache,
      gitdir,
      packfileSha: index.packfileSha,
      index,
    });

    let packReloads = 0;
    const result = await internals.readObjectPacked({
      fs: {
        readdir: async () => [`pack-${index.packfileSha}.idx`],
        read: async () => {
          packReloads++;
          throw new Error('seeded pack must not be reloaded');
        },
      },
      cache,
      gitdir,
      oid: fixture.targetOid,
    });

    assert.deepEqual(result.object, fixture.target);
    assert.equal(packReloads, 0);
  }],
  ['checkout filepath pruning is path-component safe', () => {
    assert.equal(internals.worthWalking('foo', 'foobar'), false);
    assert.equal(internals.worthWalking('foobar', 'foo'), false);
    assert.equal(internals.worthWalking('foo', 'foo/bar'), true);
    assert.equal(internals.worthWalking('foo/bar', 'foo'), true);
  }],
  ['workdir walker prunes .git directories', async () => {
    const walker = new internals.GitWalkerFs({
      fs: { readdir: async () => ['.git', 'src'] },
      dir: '/repo',
      gitdir: '/repo/.git',
      cache: {},
    });
    const names = await walker.readdir(new walker.ConstructEntry('.'));
    assert.deepEqual(names, ['src']);
  }],
];

const failures = [];
for (const [name, run] of cases) {
  try {
    await run();
    console.log(`cf-git-checkout-repairs: ${name}: ok`);
  } catch (error) {
    failures.push(new Error(name, { cause: error }));
    console.error(`cf-git-checkout-repairs: ${name}: failed: ${error.message}`);
  }
}

if (failures.length > 0) {
  throw new AggregateError(failures, `${failures.length} cf-git checkout repair test(s) failed`);
}
