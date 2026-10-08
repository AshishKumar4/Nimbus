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
// the store a session composes: its database, its storage ledger, its
// transform host's identity, and the launch's pacer.
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { EsbuildService, TRANSFORM_SLICE_SOURCE_BYTES } from '../../packages/core/src/runtime/esbuild-service.ts';
import { transformEntryScript } from '../../packages/core/src/runtime/bundle-cell-transform.ts';
import { esModuleSource } from '../../packages/core/src/runtime/module-format.ts';
import { TransformStore, transformStoreStats } from '../../packages/worker/src/facets/transform-store.ts';
import { TRANSFORM_PIPELINE_ID } from '../../packages/core/src/runtime/transform-pipeline.generated.ts';
import { LEDGER_ROW_BYTES, StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { MAX_TX_BLOB_BYTES } from '../../packages/platform/src/limits.ts';
import { TurnBudget } from '../../packages/fabric/src/turn-budget.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { launchFs } from './lib/launch-fs.mjs';

const HOST = 'test-host/1';
const APP = 'home/user/app';

// A program with a cell down every branch of the pipeline: an ES module, a
// TypeScript source (its emit goes beside it), CommonJS whose dynamic
// import() is rewritten, a module esbuild rejects, and a bundled ES module
// large enough for the session's bounded rewrite.
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
function recordingHost(calls, { reject = (code) => code.includes('BROKEN') } = {}) {
  return async (requests) => {
    calls.push(requests.map(({ code }) => code));
    return requests.map(({ code, options }) => {
      if (reject(code)) return { error: 'Unexpected ";"' };
      if (options?.rewriteOnly) return { code: `/* rewritten */\n${code}`, map: '', warnings: [] };
      return { code: `/* cjs ${options?.loader} */\n${code.replace(/(^|;)export (const|default) /gm, '$1exports.$2 ')}`, map: '', warnings: [] };
    });
  };
}

/** The store a session composes, over `db`. */
function storeOver(db, { host = HOST, ledger, ...options } = {}) {
  const harness = createSqliteVfsTestHarness(db);
  return { harness, store: new TransformStore(harness.sql, harness.ctx.storage, ledger ?? new StorageLedger(harness.sql), host, options) };
}

/** A launch's pacer, recording each turn it ends into `events`. */
function pacer(events = [], chunk = 2_000_000) {
  return new TurnBudget({ nextTurn: async () => { events.push('turn'); } }, chunk);
}

async function build(files, store, { calls = [], host = recordingHost(calls), paced = pacer() } = {}) {
  const esbuild = new EsbuildService(undefined, { transformHost: host });
  const entry = `${APP}/cli.mjs`;
  const state = await buildPrefetchBundle(
    launchFs(files).fs, { scriptPath: `/${entry}`, cwd: 'home/user', entryCode: files[entry], esbuild, pacer: paced, transformStore: store ?? undefined },
  );
  return {
    calls,
    stats: state.transforms,
    // What each path runs: its emit, or the file when no transform changed it.
    cells: Object.fromEntries(Object.keys(state.bundle).filter((path) => path.startsWith(APP)).sort()
      .map((path) => [path, state.emits?.get(path) ?? state.bundle[path]])),
    emits: Object.fromEntries([...(state.emits ?? new Map())].sort()),
    lowered: [...(state.lowered ?? new Set())].sort(),
  };
}

const partsOf = (db) => db.query('SELECT COUNT(*) AS n FROM nimbus_transform_result_parts').get().n;
const orphansOf = (db) => db.query('SELECT COUNT(*) AS n FROM nimbus_transform_result_parts WHERE write_id NOT IN (SELECT write_id FROM nimbus_transform_results WHERE write_id IS NOT NULL)').get().n;
const chargeOf = (db) => db.query('SELECT charge FROM nimbus_transform_store WHERE slot = 1').get().charge;
const heldCharge = (db) => db.query('SELECT COALESCE(SUM(charge), 0) AS c FROM nimbus_transform_results').get().c;

// ── A restarted session object, in a process of its own ────────────────────
if (process.argv[2] === '--restarted') {
  const [, , , dbPath, outPath] = process.argv;
  const db = new Database(dbPath);
  const orphansBefore = orphansOf(db);
  const result = await build(program(), storeOver(db).store);
  writeFileSync(outPath, JSON.stringify({ ...result, orphansBefore, orphansAfter: orphansOf(db) }));
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
    const { store } = storeOver(new Database(':memory:'));
    const launch = async (source, calls) => {
      const files = { 'home/user/package.json': '{}', [`${APP}/tok.mjs`]: source };
      const esbuild = new EsbuildService(undefined, { transformHost: recordingHost(calls) });
      const state = await buildPrefetchBundle(launchFs(files).fs, { scriptPath: `/${APP}/tok.mjs`, cwd: 'home/user', entryCode: source, esbuild, pacer: pacer(), transformStore: store });
      return state.emits?.get(`${APP}/tok.mjs`);
    };
    const firstCalls = [];
    assert.match(await launch(first, firstCalls), /00001unw/);
    const secondCalls = [];
    const cell = await launch(second, secondCalls);
    assert.match(cell, /0000ywba/, `the edited module must run its own code, not the previous one's: ${JSON.stringify(cell)}`);
    assert.equal(secondCalls.flat().length, 1, 'a different source is a different address, so it is transformed');
  }

  // ── A rejection is never stored: a crashed host must not outlive itself ──
  // The facet reports every exception inside a request as a rejection, esbuild
  // crashing mid-slice included ("The service was stopped").
  {
    const { store } = storeOver(new Database(':memory:'));
    const crashed = await build(program(), store, { host: recordingHost([], { reject: () => true }) });
    assert.match(crashed.cells[`${APP}/lib.mjs`], /esbuild transform failed for .*lib\.mjs/, 'premise: the crashed launch staged shims');
    const healthy = await build(program(), store);
    assert.doesNotMatch(healthy.cells[`${APP}/lib.mjs`], /esbuild transform failed/, 'the next launch against a healthy host transforms again');
    assert.match(healthy.cells[`${APP}/lib.mjs`], /exports\.const lib = 1/);
    assert.equal(healthy.stats.failed, 1, 'and only the genuinely broken module is a shim');
  }

  // ── A miss transforms and stores; a hit is the same bytes, with no transform ──
  const dbPath = join(dir, 'session.sqlite');
  const cold = await build(program(), storeOver(new Database(dbPath)).store);
  assert.ok(cold.calls.flat().length >= 4, `the cold launch transforms its cells (${cold.calls.flat().length} requests)`);
  assert.deepEqual(
    { stored: cold.stats.stored, failed: cold.stats.failed, storeErrors: cold.stats.storeErrors },
    { stored: 0, failed: 1, storeErrors: 0 },
    `the cold launch finds nothing stored, and esbuild rejects one module: ${JSON.stringify(cold.stats)}`,
  );
  assert.ok(cold.emits[`${APP}/util.ts`], 'the TypeScript source has its emit');
  assert.ok(cold.lowered.includes(`${APP}/lib.mjs`), 'the ES module is lowered');
  assert.match(cold.cells[`${APP}/broken.mjs`], /esbuild transform failed for .*broken\.mjs: Unexpected/);

  const warm = await build(program(), storeOver(new Database(dbPath)).store);
  // An ES module reaches the host as one (module-format.ts esModuleSource).
  assert.deepEqual(warm.calls.flat(), [esModuleSource(program()[`${APP}/broken.mjs`])], 'a warm launch sends the host only the rejected module');
  assert.equal(warm.stats.stored, cold.stats.cells - 1, 'every other cell is answered from the store');
  assert.deepEqual(warm.cells, cold.cells, 'a hit stages byte-identical cells');
  assert.deepEqual(warm.emits, cold.emits, 'and byte-identical emits');
  assert.deepEqual(warm.lowered, cold.lowered, 'and the same lowered cells');

  // ── It persists across a restarted session object ────────────────────────
  // A write cut short by a reset leaves parts no row names; the next isolate
  // deletes them before it writes.
  {
    const db = new Database(dbPath);
    db.run('INSERT INTO nimbus_transform_result_parts (write_id, n, data) VALUES (?, ?, ?)', ['interrupted', 0, new Uint8Array(16)]);
    db.close();
  }
  const outPath = join(dir, 'restarted.json');
  const child = Bun.spawnSync([process.execPath, import.meta.path, '--restarted', dbPath, outPath], { stdout: 'inherit', stderr: 'inherit' });
  assert.equal(child.exitCode, 0, 'the restarted session object ran');
  const restarted = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.deepEqual(restarted.calls.flat(), [esModuleSource(program()[`${APP}/broken.mjs`])], 'a restarted session object transforms nothing its predecessor stored');
  assert.deepEqual(restarted.cells, cold.cells, 'and stages the same bytes');
  assert.deepEqual(restarted.emits, cold.emits);
  assert.deepEqual(restarted.lowered, cold.lowered);
  assert.equal(restarted.orphansBefore, 1, 'premise: an interrupted write left a part behind');
  assert.equal(restarted.orphansAfter, 0, 'the restarted isolate deleted it');

  // ── The key covers every input the output is a function of ──────────────
  {
    const { store } = storeOver(new Database(dbPath));
    const base = await store.key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n');
    assert.match(base, /^[0-9a-f]{64}$/, 'a sha256');
    assert.equal(await storeOver(new Database(dbPath)).store.key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n'), base,
      'the same inputs have the same address in any store instance');
    const variants = {
      source: await store.key('cell', `${APP}/lib.mjs`, 'export const a = 2;\n'),
      path: await store.key('cell', `${APP}/lib2.mjs`, 'export const a = 1;\n'),
      kind: await store.key('entry', `${APP}/lib.mjs`, 'export const a = 1;\n'),
      // Its package scope's "type" decides whether a .js file is an ES module.
      packageType: await store.key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n', 'module'),
      host: await storeOver(new Database(':memory:'), { host: 'test-host/2' }).store.key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n'),
      pipeline: await storeOver(new Database(':memory:'), { pipeline: `${TRANSFORM_PIPELINE_ID}-next` }).store.key('cell', `${APP}/lib.mjs`, 'export const a = 1;\n'),
      // A field boundary cannot be moved to make two inputs one.
      boundary: await store.key('cell', `${APP}/lib.mjs\0export`, ' const a = 1;\n'),
    };
    for (const [input, key] of Object.entries(variants)) assert.notEqual(key, base, `a different ${input} is a different address`);
    assert.equal(new Set(Object.values(variants)).size, Object.keys(variants).length);

    // Through a launch: an edited module is transformed, alone.
    const edited = await build(program('export const lib = 2;\n'), storeOver(new Database(dbPath)).store);
    assert.deepEqual(edited.calls.flat().sort(), [esModuleSource('export const lib = 2;\n'), esModuleSource(program()[`${APP}/broken.mjs`])].sort(),
      'only the edited module (and the rejected one) is transformed');
    assert.match(edited.cells[`${APP}/lib.mjs`], /exports\.const lib = 2/);
    // Another transform host, or another pipeline: a deploy that changed
    // either drops the older generation's results and transforms everything.
    for (const other of [{ host: 'test-host/2' }, { pipeline: `${TRANSFORM_PIPELINE_ID}-next` }]) {
      const copy = join(dir, `other-${Object.keys(other)[0]}.sqlite`);
      copyFileSync(dbPath, copy);
      const db = new Database(copy);
      assert.ok(heldCharge(db) > 0, 'premise: the copy holds the older generation');
      const again = await build(program(), storeOver(db, other).store);
      assert.equal(again.calls.flat().length, cold.calls.flat().length, `a store of another ${Object.keys(other)[0]} transforms everything again`);
      assert.deepEqual(again.cells, cold.cells);
      const rows = db.query('SELECT COUNT(*) AS n FROM nimbus_transform_results').get().n;
      assert.equal(rows, cold.stats.transformed, 'and holds only its own generation: the older rows were dropped');
      assert.equal(chargeOf(db), heldCharge(db));
    }
  }

  // ── Per-slice pacing: no turn waits on more than a slice of the host ─────
  {
    const files = {
      'home/user/package.json': '{}',
      [`${APP}/cli.mjs`]: Array.from({ length: 12 }, (_, i) => `import "./m${i}.mjs";`).join('\n') + '\nexport const cli = 1;\n',
    };
    for (let i = 0; i < 12; i++) files[`${APP}/m${i}.mjs`] = `export const m${i} = "${String(i).repeat(60_000)}";\n`;
    const events = [];
    const host = recordingHost([]);
    const esbuild = new EsbuildService(undefined, {
      transformHost: async (requests) => {
        events.push(`host:${requests.reduce((n, { code }) => n + code.length, 0)}`);
        return host(requests);
      },
    });
    const { store } = storeOver(new Database(':memory:'));
    await buildPrefetchBundle(launchFs(files).fs, { scriptPath: `/${APP}/cli.mjs`, cwd: 'home/user', entryCode: files[`${APP}/cli.mjs`], esbuild, pacer: pacer(events, 256 * 1024), transformStore: store });
    const calls = events.filter((e) => e.startsWith('host:'));
    assert.ok(calls.length > 1, `the launch's transforms span several host calls: ${calls}`);
    for (const call of calls) assert.ok(Number(call.slice(5)) <= TRANSFORM_SLICE_SOURCE_BYTES, `a host call carries at most a slice: ${call}`);
    const at = events.flatMap((event, i) => (event.startsWith('host:') ? [i] : []));
    for (let i = 0; i < at.length - 1; i++) {
      assert.ok(events.slice(at[i] + 1, at[i + 1]).includes('turn'), `the launch yields its turn between host calls ${i} and ${i + 1}: ${events.join(' ')}`);
    }
  }

  // ── Store failures: full is counted and survived; anything else is loud ──
  {
    const full = new Error('database or disk is full: SQLITE_FULL');
    const { harness, store } = storeOver(new Database(':memory:'));
    harness.setFaultInjector((statement) => (statement.sql.startsWith('INSERT INTO nimbus_transform_results') ? full : null));
    const launch = await build(program(), store);
    assert.ok(launch.stats.storeErrors > 0 && /SQLITE_FULL/.test(launch.stats.storeError),
      `a full database is counted with its reason: ${JSON.stringify(launch.stats)}`);
    assert.match(launch.cells[`${APP}/lib.mjs`], /exports\.const lib = 1/, 'and the launch still has its results');
    const stats = transformStoreStats(harness.sql, harness.ctx.storage);
    assert.ok(stats.storeErrors > 0 && /SQLITE_FULL/.test(stats.storeError), `and reported: ${JSON.stringify(stats)}`);
    assert.equal(stats.entries, 0);

    // The ledger's admission comes first: a session at its storage limit keeps nothing.
    const refusing = { admit() { throw new VfsError('ENOSPC', 'the session is full'); }, reserve() { throw new VfsError('ENOSPC', 'the session is full'); }, draw() { return 0; }, release() {} };
    const admitted = storeOver(new Database(':memory:'), { ledger: refusing });
    const refused = await build(program(), admitted.store);
    assert.equal(refused.stats.storeErrors, refused.stats.transformed, 'every result is refused by the ledger, and counted');
    assert.match(refused.stats.storeError, /session is full/);
    assert.equal(transformStoreStats(admitted.harness.sql, admitted.harness.ctx.storage).entries, 0, 'nothing is written past the ledger');

    // A store that cannot work at all is not a store with nothing in it.
    const drifted = storeOver(new Database(':memory:'));
    drifted.harness.setFaultInjector((statement) => (statement.sql.includes('nimbus_transform_results') ? new Error('no such column: lowered') : null));
    await assert.rejects(build(program(), drifted.store), /no such column: lowered/);
  }

  // ── Bounded: least recently used leave first; nothing over the entry bound ──
  {
    const db = new Database(':memory:');
    const maxBytes = 64 * 1024;
    const { store } = storeOver(db, { maxBytes, maxEntryBytes: 16 * 1024 });
    const result = (i, bytes = 4096) => ({ code: String(i).padEnd(bytes, '.'), lowered: i % 2 === 0 });
    const keys = [];
    for (let i = 0; i < 40; i++) {
      keys.push(await store.key('cell', `m${i}.mjs`, String(i)));
      assert.equal(await store.put(keys[i], result(i)), null);
      assert.ok(chargeOf(db) <= maxBytes, `after put ${i} the store is charged ${chargeOf(db)}, over ${maxBytes}`);
      assert.equal(chargeOf(db), heldCharge(db), 'the charge is exactly what the rows hold');
      // Recency is use, kept to the hour: an hour on, the result read again
      // survives every put, and the ones nobody read leave first.
      if (i >= 1) db.run('UPDATE nimbus_transform_results SET used = used - 1');
      if (i >= 1) assert.ok(store.getMany([keys[1]]).has(keys[1]), `the result read after every put survives put ${i}`);
    }
    const held = store.getMany(keys);
    assert.ok(held.size >= Math.floor(maxBytes / (4096 + LEDGER_ROW_BYTES)) - 1, `the bound is used, not just enforced (${held.size} held)`);
    assert.ok(!held.has(keys[0]), 'the least recently used result left');
    assert.ok(held.has(keys[39]), 'the newest is kept');
    assert.deepEqual(held.get(keys[38]), result(38), 'a kept result is the bytes and flag that were put');
    const oversized = await store.key('cell', 'huge.mjs', 'huge');
    assert.equal(await store.put(oversized, result(0, 16 * 1024 + 1)), null);
    assert.equal(store.getMany([oversized]).size, 0, 'a result over the entry bound is not kept');
  }

  // ── Large results go down in parts; a failed write takes them with it ────
  {
    const db = new Database(':memory:');
    const { store } = storeOver(db);
    // Multi-byte text, so a part boundary falls inside a character.
    const code = '"use strict";\n' + 'ü€𝄞'.repeat(300_000);
    const bytes = new TextEncoder().encode(code).byteLength;
    const key = await store.key('cell', 'big.mjs', 'source');
    const spent = [];
    // A launch killed while the result is being written stops the write.
    await assert.rejects(store.put(key, { code, lowered: true }, async (n) => { spent.push(n); throw new Error('process gone'); }), /process gone/);
    assert.equal(store.getMany([key]).size, 0, 'a write cut short is no result');
    assert.equal(partsOf(db), 0, 'and leaves no parts behind');
    assert.equal(chargeOf(db), 0, 'and no charge');

    // Two launches write the same result at once: one becomes it, and neither
    // destroys the other's complete result.
    spent.length = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = store.put(key, { code, lowered: true }, async (n) => { spent.push(n); await gate; });
    assert.equal(await store.put(key, { code, lowered: true }, async (n) => { spent.push(n); }), null);
    assert.deepEqual(store.getMany([key]).get(key), { code, lowered: true }, 'the first to finish is read back exactly');
    release();
    assert.equal(await slow, null);
    assert.deepEqual(store.getMany([key]).get(key), { code, lowered: true }, 'and survives the second finishing');
    assert.equal(partsOf(db), Math.ceil(bytes / MAX_TX_BLOB_BYTES), 'only the result\'s own parts remain');
    assert.ok(spent.every((n) => n <= MAX_TX_BLOB_BYTES), `written in parts of at most ${MAX_TX_BLOB_BYTES} bytes`);

    // A part that went missing makes the row no result, and the row goes.
    db.run('DELETE FROM nimbus_transform_result_parts WHERE n = 1');
    assert.equal(store.getMany([key]).size, 0, 'parts that come up short are not served');
    assert.equal(db.query('SELECT COUNT(*) AS n FROM nimbus_transform_results').get().n, 0, 'and their row is forgotten');
    assert.equal(partsOf(db), 0);
    assert.equal(chargeOf(db), 0);
  }

  // ── The entry script: read back by content, and never kept when it fails ──
  {
    const { store } = storeOver(new Database(':memory:'));
    const calls = [];
    const host = new EsbuildService(undefined, { transformHost: recordingHost(calls) });
    const code = 'import("./x.mjs");\n';
    const spent = [];
    const first = await transformEntryScript(code, 'file:///home/user/[eval]', { host, store, pacer: { spend: async (n) => { spent.push(n); } } });
    assert.deepEqual(spent, [new TextEncoder().encode(first).byteLength], 'its write is accounted to the launch pacer, like a cell\'s');
    assert.equal(await transformEntryScript(code, 'file:///home/user/[eval]', { host, store }), first);
    assert.equal(calls.length, 1, 'the second run is read back');
    const broken = new EsbuildService(undefined, { transformHost: recordingHost([], { reject: () => true }) });
    await assert.rejects(transformEntryScript('import("./y.mjs");\n', 'file:///home/user/[eval]', { host: broken, store }), /entry dynamic import transform failed/);
    const later = [];
    await transformEntryScript('import("./y.mjs");\n', 'file:///home/user/[eval]', { host: new EsbuildService(undefined, { transformHost: recordingHost(later) }), store });
    assert.equal(later.length, 1, 'a failed entry rewrite was not kept');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('transform-results: a launch\'s transforms are kept by content, survive a restart, stay bounded, and fail loudly');
