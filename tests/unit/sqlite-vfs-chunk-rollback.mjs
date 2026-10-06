#!/usr/bin/env bun
/**
 * sqlite-vfs-chunk-rollback — deflated chunks under the release before them.
 * Production rolls back with `wrangler versions deploy <previous>`, which runs
 * that release's engine over the database this one wrote. Its every read of a
 * deflated chunk (whole, ranged, uncached, exported, or under a rewrite) must
 * fail, never return the deflated bytes; its own writes stay readable; and
 * rolled forward again, this engine reads everything both wrote.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { releasedCore } from './lib/released-source.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

/** The production release this change follows: the code a rollback from it runs. */
const RELEASE = '80c877f10';

const released = releasedCore(RELEASE);
const { SqliteVFS: ReleasedVFS } = await released('vfs/sqlite-vfs.ts');
const { CRED_KERNEL: RELEASED_KERNEL } = await released('runtime/os-contracts.ts');

function random(length, seed) {
  const out = new Uint8Array(length);
  let s = (Math.imul(seed, 2654435761) + 1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
  }
  return out;
}

function source(length, seed) {
  const noise = random(length, seed);
  let text = '';
  for (let i = 0; text.length < length; i++) text += `export const value_${noise[i % length]} = await node(${i});\n`;
  return new TextEncoder().encode(text.slice(0, length));
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const states = (db) => db.query('SELECT state, COUNT(*) AS n FROM vfs_chunks GROUP BY state ORDER BY state').all()
  .map((row) => `${row.state}:${row.n}`).join(' ');

const db = new Database(':memory:');
const files = {
  'p/small.js': source(8_000, 1),
  'p/large.js': source(400_000, 2),
  'p/noise.bin': random(8_000, 3),
};

// This engine writes; its compressible chunks are stored deflated.
{
  const harness = createSqliteVfsTestHarness(db);
  const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  vfs.mkdir('p');
  for (const [path, bytes] of Object.entries(files)) vfs.writeFile(path, bytes);
  assert.match(states(db), /^0:1 3:\d+$/, 'every chunk but the noise is deflated');
}

// The release before reads the same database.
{
  const harness = createSqliteVfsTestHarness(db);
  const vfs = new ReleasedVFS(harness.sql, harness.ctx).as(RELEASED_KERNEL);
  assert.deepEqual(vfs.readFile('p/noise.bin'), files['p/noise.bin'], 'it opens this database and reads a stored chunk');

  const refused = (error) => error.code === 'ENODATA';
  for (const path of ['p/small.js', 'p/large.js']) {
    assert.throws(() => vfs.readFile(path), refused, `${path}: a whole read fails`);
    assert.throws(() => vfs.readRange(path, 100, 50), refused, `${path}: a ranged read fails`);
    assert.throws(() => vfs.readRangeUncached(path, 100, 50), refused, `${path}: an uncached read fails`);
    assert.throws(() => vfs.writeRange(path, 10, new Uint8Array([65])), refused, `${path}: a rewrite reads first, and fails`);
    assert.throws(() => vfs.truncate(path, 20), refused, `${path}: a truncate reads first, and fails`);
  }
  const raw = new ReleasedVFS(harness.sql, harness.ctx);
  assert.throws(() => raw.exportChunks([sha(files['p/small.js'])]), refused, 'an export fails');

  // Its write of bytes a deflated chunk names stores them as they are, for both names.
  vfs.writeFile('p/copy.js', files['p/small.js']);
  assert.deepEqual(vfs.readFile('p/copy.js'), files['p/small.js']);
  assert.deepEqual(vfs.readFile('p/small.js'), files['p/small.js']);
  // And its own new file.
  vfs.writeFile('p/new.js', source(9_000, 4));
}

// Its cold tiering passes a deflated chunk by: it moves only chunks it can read.
{
  const harness = createSqliteVfsTestHarness(db);
  const put = [];
  const coldStore = { async put(key) { put.push(key); }, async get() { return null; }, async delete() {} };
  const raw = new ReleasedVFS(harness.sql, harness.ctx, undefined, { coldStore });
  const gone = source(7_000, 5);
  raw.as(RELEASED_KERNEL).writeFile('p/gone.js', gone);
  raw.snapshot('s');
  raw.as(RELEASED_KERNEL).unlink('p/large.js');
  raw.as(RELEASED_KERNEL).unlink('p/gone.js');
  for (let pass = 0; !(await raw.tierColdChunks()).done; pass++) assert.ok(pass < 100);
  assert.deepEqual(put, [sha(gone)], 'only its own chunk went cold');
  raw.dropSnapshot('s');
}

// Rolled forward, this engine reads what both wrote.
{
  const harness = createSqliteVfsTestHarness(db);
  const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  for (const [path, bytes] of Object.entries(files)) {
    if (path !== 'p/large.js') assert.deepEqual(vfs.readFile(path), bytes, path);
  }
  assert.deepEqual(vfs.readFile('p/copy.js'), files['p/small.js']);
  assert.deepEqual(vfs.readFile('p/new.js'), source(9_000, 4));
}

console.log('sqlite-vfs-chunk-rollback: ok');
