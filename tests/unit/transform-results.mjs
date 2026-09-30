#!/usr/bin/env bun
// A launch's transform results are kept by content in the session's SQLite
// (facets/transform-store.ts), so a launch after a reset, an eviction or a
// re-drive reads them back instead of transforming again.
//
// They were kept in the isolate's heap under a 32-bit FNV-1a key of the
// source and its URL, whose comment called a collision harmless. It is not:
// two sources that share the key get each other's code. And every teardown
// took them with it — session zealous-pangolin-6268 was torn down five times
// in 4.4 h and paid 33-45 s of esbuild CPU for the same transforms each time.
//
// Driven through buildPrefetchBundle, the launch's module-map builder, with
// the esbuild service a session composes: a transform host and a store over
// the session's database.
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { TransformStore, transformStoreStats } from '../../packages/worker/src/facets/transform-store.ts';
import { TRANSFORM_PIPELINE_ID } from '../../packages/worker/src/transform-pipeline.generated.ts';
import { LEDGER_ROW_BYTES } from '../../packages/core/src/runtime/storage-ledger.ts';
import { MAX_TX_BLOB_BYTES } from '../../packages/platform/src/limits.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { launchFs } from './lib/launch-fs.mjs';

const HOST = 'test-host/1';
const APP = 'home/user/app';

// A program with a cell down every branch of the pipeline: an ES module, a
// TypeScript source (its emit goes beside it), CommonJS whose dynamic
// import() is rewritten, a module esbuild rejects (its verdict is kept), and a
// bundled ES module large enough for the session's bounded rewrite.
const program = (lib = 'export const lib = 1;\nexport default function where() { return import.meta.url; }\n') => ({
  'home/user/package.json': JSON.stringify({ name: 'app' }),
  [`${APP}/package.json`]: JSON.stringify({ name: 'app', type: 'module' }),
  [`${APP}/cli.mjs`]: 'import "./lib.mjs";\nimport "./util.ts";\nimport "./legacy.cjs";\nimport "./broken.mjs";\nimport "./big.mjs";\nexport const cli = true;\n',
  [`${APP}/lib.mjs`]: lib,
  [`${APP}/util.ts`]: 'export const n: number = 2;\n',
  [`${APP}/legacy.cjs`]: 'module.exports = () => import("./lib.mjs");\n',
  [`${APP}/broken.mjs`]: 'export const BROKEN = ;\n',
  [`${APP}/big.mjs`]: `const payload = "${'x'.repeat(600_000)}";\nexport{payload};\n`,
});

/** A transform host whose output is a function of its input, so a wrong result is visible. */
function recordingHost(calls) {
  return async (requests) => requests.map(({ code, options }) => {
    calls.push({ code, options });
    if (code.includes('BROKEN')) return { error: 'Unexpected ";"' };
    if (options?.rewriteOnly) return { code: `/* rewritten */\n${code}`, map: '', warnings: [] };
    return { code: `/* cjs ${options?.loader} */\n${code.replace(/^export (const|default) /gm, 'exports.$1 ')}`, map: '', warnings: [] };
  });
}

function storeOver(db, host = HOST, options = {}) {
  const harness = createSqliteVfsTestHarness(db);
  return new TransformStore(harness.sql, harness.ctx.storage, host, options);
}

async function build(files, store, calls = []) {
  const esbuild = new EsbuildService(undefined, { transformHost: recordingHost(calls), ...(store ? { results: store } : {}) });
  const entry = `${APP}/cli.mjs`;
  const state = await buildPrefetchBundle(launchFs(files).fs, `/${entry}`, 'home/user', files[entry], esbuild);
  return {
    calls,
    stats: state.transforms,
    cells: Object.fromEntries(Object.entries(state.bundle).filter(([path]) => path.startsWith(APP)).sort()),
    emits: Object.fromEntries([...(state.emits ?? new Map())].sort()),
    lowered: [...(state.lowered ?? new Set())].sort(),
  };
}

// ── A restarted session object, in a process of its own ────────────────────
if (process.argv[2] === '--restarted') {
  const [, , , dbPath, outPath] = process.argv;
  const db = new Database(dbPath);
  const orphansBefore = db.query('SELECT COUNT(*) AS n FROM nimbus_transform_parts WHERE key NOT IN (SELECT key FROM nimbus_transforms)').get().n;
  const result = await build(program(), storeOver(db));
  const orphansAfter = db.query('SELECT COUNT(*) AS n FROM nimbus_transform_parts WHERE key NOT IN (SELECT key FROM nimbus_transforms)').get().n;
  writeFileSync(outPath, JSON.stringify({ ...result, orphansBefore, orphansAfter }));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'transform-results-'));
try {
  // ── A key collision of the old cache returns another file's code ─────────
  // The old key: FNV-1a 32 of `source \0 url`, plus the length. These two
  // modules have the same length and hash, as a file edited between two
  // launches can.
  {
    const fnv1a = (s) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      return h;
    };
    const first = 'export const token = "00001unw";\n';
    const second = 'export const token = "0000ywba";\n';
    const url = `\0file:///${APP}/tok.mjs`;
    assert.equal(first.length, second.length);
    assert.equal(fnv1a(first + url), fnv1a(second + url), 'premise: the two sources share the old 32-bit key');
    const store = storeOver(new Database(':memory:'));
    const launch = async (source, calls) => {
      const files = { 'home/user/package.json': '{}', [`${APP}/tok.mjs`]: source };
      const esbuild = new EsbuildService(undefined, { transformHost: recordingHost(calls), results: store });
      const state = await buildPrefetchBundle(launchFs(files).fs, `/${APP}/tok.mjs`, 'home/user', source, esbuild);
      return state.bundle[`${APP}/tok.mjs`];
    };
    const firstCalls = [];
    assert.match(await launch(first, firstCalls), /00001unw/);
    assert.equal(firstCalls.length, 1);
    const secondCalls = [];
    const cell = await launch(second, secondCalls);
    assert.match(cell, /0000ywba/, `the edited module must run its own code, not the previous one's: ${JSON.stringify(cell)}`);
    assert.doesNotMatch(cell, /00001unw/);
    assert.equal(secondCalls.length, 1, 'a different source is a different address, so it is transformed');
  }

  // ── A miss transforms and stores; a hit is the same bytes, with no transform ──
  const dbPath = join(dir, 'session.sqlite');
  const cold = await build(program(), storeOver(new Database(dbPath)));
  assert.ok(cold.calls.length >= 4, `the cold launch transforms its cells (${cold.calls.length} requests)`);
  assert.deepEqual(
    { stored: cold.stats.stored, failed: cold.stats.failed },
    { stored: 0, failed: 1 },
    `the cold launch finds nothing stored, and esbuild rejects one module: ${JSON.stringify(cold.stats)}`,
  );
  assert.ok(cold.emits[`${APP}/util.ts`], 'the TypeScript source has its emit');
  assert.ok(cold.lowered.includes(`${APP}/lib.mjs`), 'the ES module is lowered');
  assert.match(cold.cells[`${APP}/broken.mjs`], /esbuild transform failed for .*broken\.mjs: Unexpected/);
  assert.equal(cold.cells[`${APP}/util.ts`], program()[`${APP}/util.ts`], 'a TypeScript source keeps its bytes');

  const warm = await build(program(), storeOver(new Database(dbPath)));
  assert.equal(warm.calls.length, 0, `a warm launch transforms nothing: ${JSON.stringify(warm.calls.map((c) => c.code.slice(0, 40)))}`);
  assert.equal(warm.stats.stored, cold.stats.cells, 'every cell is answered from the store');
  assert.deepEqual(warm.cells, cold.cells, 'a hit stages byte-identical cells');
  assert.deepEqual(warm.emits, cold.emits, 'and byte-identical emits');
  assert.deepEqual(warm.lowered, cold.lowered, 'and the same lowered cells');

  // ── It persists across a restarted session object ────────────────────────
  // A write cut short by a reset leaves parts no row names; the next isolate
  // deletes them before it writes.
  {
    const db = new Database(dbPath);
    db.run('INSERT INTO nimbus_transform_parts (key, n, data) VALUES (?, ?, ?)', ['interrupted', 0, new Uint8Array(16)]);
    db.close();
  }
  const outPath = join(dir, 'restarted.json');
  const child = Bun.spawnSync([process.execPath, import.meta.path, '--restarted', dbPath, outPath], { stdout: 'inherit', stderr: 'inherit' });
  assert.equal(child.exitCode, 0, 'the restarted session object ran');
  const restarted = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(restarted.calls.length, 0, 'a restarted session object transforms nothing its predecessor stored');
  assert.deepEqual(restarted.cells, cold.cells, 'and stages the same bytes');
  assert.deepEqual(restarted.emits, cold.emits);
  assert.deepEqual(restarted.lowered, cold.lowered);
  assert.equal(restarted.orphansBefore, 1, 'premise: an interrupted write left a part behind');
  assert.equal(restarted.orphansAfter, 0, 'the restarted isolate deleted it');

  // ── The key covers every input the output is a function of ──────────────
  {
    const store = storeOver(new Database(dbPath));
    const base = await store.key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n');
    assert.match(base, /^[0-9a-f]{64}$/, 'a sha256');
    assert.equal(await storeOver(new Database(dbPath)).key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n'), base,
      'the same inputs have the same address in any store instance');
    const variants = {
      source: await store.key('cell', `${APP}/lib.mjs`, 'export const a = 2;\n'),
      path: await store.key('cell', `${APP}/lib2.mjs`, 'export const a = 1;\n'),
      kind: await store.key('entry', `${APP}/lib.mjs`, 'export const a = 1;\n'),
      host: await storeOver(new Database(dbPath), 'test-host/2').key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n'),
      pipeline: await storeOver(new Database(dbPath), HOST, { pipeline: `${TRANSFORM_PIPELINE_ID}-next` }).key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n'),
      // A field boundary cannot be moved to make two inputs one.
      boundary: await store.key('cell', `${APP}/lib.mjs\0export`, ' const a = 1;\n'),
    };
    for (const [input, key] of Object.entries(variants)) assert.notEqual(key, base, `a different ${input} is a different address`);
    assert.equal(new Set(Object.values(variants)).size, Object.keys(variants).length);

    // Through a launch: an edited module is transformed, alone.
    const edited = await build(program('export const lib = 2;\n'), storeOver(new Database(dbPath)));
    assert.deepEqual(edited.calls.map((c) => c.code), ['export const lib = 2;\n'], 'only the edited module is transformed');
    assert.match(edited.cells[`${APP}/lib.mjs`], /exports\.const lib = 2/);
    // Another transform host, or another pipeline, shares none of it.
    const otherHost = await build(program(), storeOver(new Database(dbPath), 'test-host/2'));
    assert.equal(otherHost.calls.length, cold.calls.length, 'a store bound to another host transforms everything again');
    const otherPipeline = await build(program(), storeOver(new Database(dbPath), HOST, { pipeline: `${TRANSFORM_PIPELINE_ID}-next` }));
    assert.equal(otherPipeline.calls.length, cold.calls.length, 'as does another pipeline');
    // Without a store nothing is kept: a launch transforms every cell.
    const unstored = await build(program(), null);
    assert.equal(unstored.calls.length, cold.calls.length);
    assert.deepEqual(unstored.cells, cold.cells, 'and stages what the store would have served');
  }

  // ── Bounded: least recently used leave first; nothing over the entry bound ──
  {
    const harness = createSqliteVfsTestHarness(new Database(':memory:'));
    const maxBytes = 64 * 1024;
    const store = new TransformStore(harness.sql, harness.ctx.storage, HOST, { maxBytes, maxEntryBytes: 16 * 1024 });
    const result = (i, bytes = 4096) => ({ code: String(i).padEnd(bytes, '.'), lowered: i % 2 === 0, failed: false });
    const charge = (bytes) => bytes + 2 * LEDGER_ROW_BYTES;
    const keys = [];
    for (let i = 0; i < 40; i++) {
      keys.push(await store.key('cell', `m${i}.mjs`, String(i)));
      await store.put(keys[i], result(i));
      const stats = transformStoreStats(harness.sql);
      assert.ok(stats.charge <= maxBytes, `after put ${i} the store is charged ${stats.charge}, over ${maxBytes}`);
      const rows = harness.db.query('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM nimbus_transforms').get();
      assert.equal(stats.charge, rows.bytes + rows.n * 2 * LEDGER_ROW_BYTES, 'the charge is exactly what the rows hold');
      // Reading an old result keeps it: recency is use, not age.
      if (i >= 1) assert.ok(store.getMany([keys[1]]).has(keys[1]), `the result read after every put survives put ${i}`);
    }
    const held = store.getMany(keys);
    assert.ok(held.size >= Math.floor(maxBytes / charge(4096)) - 1, `the bound is used, not just enforced (${held.size} held)`);
    assert.ok(!held.has(keys[0]), 'the least recently used result left');
    assert.ok(held.has(keys[39]), 'the newest is kept');
    assert.deepEqual(held.get(keys[38]), result(38), 'a kept result is the bytes and flags that were put');
    const parts = harness.db.query('SELECT COUNT(*) AS n FROM nimbus_transform_parts').get().n;
    assert.equal(parts, held.size, 'an evicted result takes its parts with it');
    const oversized = await store.key('cell', 'huge.mjs', 'huge');
    await store.put(oversized, result(0, 16 * 1024 + 1));
    assert.equal(store.getMany([oversized]).size, 0, 'a result over the entry bound is not kept');
  }

  // ── Large results go down in parts, a turn's worth at a time ─────────────
  {
    const harness = createSqliteVfsTestHarness(new Database(':memory:'));
    const store = new TransformStore(harness.sql, harness.ctx.storage, HOST);
    // Multi-byte text, so a part boundary falls inside a character.
    const code = '"use strict";\n' + 'ü€𝄞'.repeat(300_000);
    const key = await store.key('cell', 'big.mjs', 'source');
    const spent = [];
    // A launch killed while the result is being written stops the write.
    await assert.rejects(store.put(key, { code, lowered: true, failed: false }, async (bytes) => {
      spent.push(bytes);
      throw new Error('process gone');
    }), /process gone/);
    assert.equal(store.getMany([key]).size, 0, 'a write cut short is no result');
    spent.length = 0;
    await store.put(key, { code, lowered: true, failed: false }, async (bytes) => { spent.push(bytes); });
    const bytes = new TextEncoder().encode(code).byteLength;
    assert.ok(spent.length > 1 && spent.every((n) => n <= MAX_TX_BLOB_BYTES), `written in parts of at most ${MAX_TX_BLOB_BYTES} bytes: ${spent}`);
    assert.equal(spent.reduce((a, b) => a + b, 0), bytes, 'every byte is accounted to the pacer');
    assert.deepEqual(store.getMany([key]).get(key), { code, lowered: true, failed: false }, 'and read back exactly');
    const rows = harness.db.query('SELECT COUNT(*) AS n FROM nimbus_transform_parts WHERE key = ?').get(key).n;
    assert.equal(rows, spent.length, 'the interrupted write left nothing behind');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('transform-results: a launch\'s transforms are kept by content, survive a restart, and stay bounded');
