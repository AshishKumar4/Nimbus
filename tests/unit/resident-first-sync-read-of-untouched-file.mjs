#!/usr/bin/env bun
// THE constraint: a node process performing a synchronous FIRST read of a file
// it has never touched, with no error.
//
// This is the end-to-end case, not a unit of it. A real node program runs
// inside the real generated facet body, through the real 376 KB node shims,
// against a real SqliteVFS, on a facet with real SQLite storage. Nothing about
// the read path is stood in for: `fs.readFileSync` here is the shipped
// implementation, reaching the shipped `_bundleLookup`, reaching the resident
// store through the same `__vfsBundle` binding the shims have always used.
//
// The file the program reads is chosen to be one the prefetch bundle CANNOT
// contain — it is not in the require closure, nothing references it, and the
// program's first contact with it is the synchronous read. Before this store,
// that read is the EAGAIN the constraint forbids.
//
// Non-vacuity is the whole design of this test. Arm 1 asserts the read FAILS
// when the store is not filled, because a test that only showed the read
// working would pass just as well if the store were never consulted — the
// bundle might simply have contained the file. Arm 1 proves it does not.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { createFacetWorld, createFacetCtx, createProcessFacetCtx } from './facet-host-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';

/** The file nothing references, and that the bundle cannot carry. */
const UNTOUCHED = '/opt/appdata/locale/deep/never-required.json';
/**
 * Big enough that the prefetch bundle's byte cap (VFS_BUNDLE_MAX_BYTES, 24 MiB)
 * evicts it. That is not a contrivance — it is the documented failure this store
 * exists for, and the bundler says so itself when it truncates: "They still
 * exist and async reads still return them; synchronous reads raise EAGAIN."
 * It also puts the file past the 2,199,981-byte single-value ceiling, so the
 * store's chunking is on the proven path rather than beside it.
 */
const UNTOUCHED_BODY = 'N'.repeat(25 * 1024 * 1024);

const harness = createSqliteVfsTestHarness();
const sessionVfs = new SqliteVFS(harness.sql, harness.ctx);

const kfs = sessionVfs.as(CRED_KERNEL);
kfs.mkdir('home/user', { recursive: true, mode: 0o755 });
// Deliberately OUTSIDE the process's cwd. The bundler enumerates the working
// tree, so a file under /home/user is swept in by enrichment and would make
// this test prove nothing — the first draft did exactly that, and the control
// arm below is what caught it.
kfs.mkdir('opt/appdata/locale/deep', { recursive: true, mode: 0o755 });
kfs.writeFile(UNTOUCHED.replace(/^\//, ''), UNTOUCHED_BODY, { mode: 0o644 });

/**
 * Many small files, and the reason they are here.
 *
 * The batch packing obeys two bounds at once — at most
 * FS_READ_BATCH_PATH_LIMIT (128) ranges and at most
 * FS_READ_BATCH_REQUEST_BYTES (4 MiB) per call — and with the 25 MiB file
 * alone only the BYTE bound ever binds, because 1 MiB ranges fill 4 MiB after
 * four of them. Measured: breaking the path bound to 512 left this test green.
 * So the fixture carries more than 128 small files, where the PATH bound binds
 * first and a violation is rejected by the real zod schema.
 */
const SMALL_FILE_COUNT = 300;
kfs.mkdir('opt/appdata/many', { recursive: true, mode: 0o755 });
for (let i = 0; i < SMALL_FILE_COUNT; i++) {
  kfs.writeFile(`opt/appdata/many/f${i}.txt`, `small-${i}`, { mode: 0o644 });
}
/** One of them, read synchronously as the program's first contact with it. */
const UNTOUCHED_SMALL = '/opt/appdata/many/f287.txt';

/**
 * The supervisor the facet talks to.
 *
 * `fsList` and `fsReadBatch` are the REAL RPC entry points, not stand-ins.
 * That is deliberate and it is what this test learned the hard way: a
 * hand-written stub answered `{ content }` for unlimited paths with no
 * offset or length, while `_rpcFsReadBatch` answers `{ bytes }` for at most
 * FS_READ_BATCH_PATH_LIMIT ranges totalling FS_READ_BATCH_REQUEST_BYTES, with
 * both fields required and zod rejecting the whole call otherwise. A filler
 * that passed against the stub could not issue a single valid call against the
 * supervisor. Binding the proof to the real functions makes that class of
 * drift impossible rather than merely noticed.
 */
let fsReadBatchCalls = 0;
let fsListCalls = 0;
let allowFill = true;
const stdoutChunks = [];

const rpcHost = {
  sqliteFs: sessionVfs,
  processes: new SessionProcessSupervisor(),
  ensureSqliteFs() {},
};

function makeSupervisor(props) {
  return {
    props,
    /**
     * Enumerate the filesystem. The store cannot get this from the module map
     * — measured: a facet is shipped metadata for the bundle plus ancestor
     * directories, not a file list — so it is a supervisor call.
     */
    async fsList(after, limit) {
      fsListCalls++;
      if (!allowFill) throw new Error('probe: fill disabled for the control arm');
      return _rpcFsList(rpcHost, after ?? null, limit ?? null);
    },
    async fsReadBatch(requests) {
      fsReadBatchCalls++;
      if (!allowFill) throw new Error('probe: fill disabled for the control arm');
      return _rpcFsReadBatch(rpcHost, requests);
    },
    async readFile(path) {
      return sessionVfs.as(CRED_KERNEL).readFile(String(path).replace(/^\/+/, ''), 'utf8');
    },
    async writeFile() {},
    async registerPort() {},
    async unregisterPort() {},
    async stdout(s) { stdoutChunks.push(String(s)); },
    async stderr(s) { stdoutChunks.push(String(s)); },
    async reportExit() {},
  };
}

setCtxExports({ SupervisorRPC: ({ props }) => makeSupervisor(props) });

let facetSeq = 0;
const world = createFacetWorld(async (config, info) => {
  const source = config.modules['worker.js'].replace(
    'import { DurableObject } from "cloudflare:workers";',
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  );
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const generated = await import(url);
    return new generated.NimbusProcess(
      createProcessFacetCtx(`${info.facetName}-${++facetSeq}`),
      { SUPERVISOR: config.env.SUPERVISOR },
    );
  } finally {
    URL.revokeObjectURL(url);
  }
});

const env = {
  LOADER: world.loader,
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(
        readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
        { status: 200 },
      );
    },
  },
};

const ctx = createFacetCtx(world, 'first-sync-read-session');
const manager = new FacetManager(ctx, env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {});
manager.setVfs(sessionVfs);
delete globalThis.__portRegistry;

/**
 * A real node program. Its FIRST contact with the file is the synchronous read
 * — no stat, no exists, no require, nothing that could have paged it in.
 */
const PROGRAM = `
const fs = require('fs');
try {
  const body = fs.readFileSync(${JSON.stringify(UNTOUCHED)}, 'utf8');
  console.log('SYNC_READ_OK len=' + body.length + ' head=' + body.slice(0, 8));
} catch (e) {
  console.log('SYNC_READ_FAILED ' + (e && e.code ? e.code : '') + ' ' + (e && e.message));
}
try {
  const small = fs.readFileSync(${JSON.stringify(UNTOUCHED_SMALL)}, 'utf8');
  console.log('SMALL_READ_OK ' + small);
} catch (e) {
  console.log('SMALL_READ_FAILED ' + (e && e.code ? e.code : '') + ' ' + (e && e.message));
}
`;

/**
 * Spawn it as a RESIDENT process. That is the substrate the store lives on: a
 * resident process is a DO facet and has its own SQLite, while the one-shot
 * `exec` path runs in a stateless loaded worker that has none.
 */
let spawnSeq = 0;
async function run() {
  stdoutChunks.length = 0;
  const spawned = await manager.spawnNode(PROGRAM, {
    command: `node reader${++spawnSeq}.js`,
    filename: `/home/user/reader${spawnSeq}.js`,
    cwd: '/home/user',
  });
  if (spawned?.done) { try { await spawned.done; } catch { /* the program's own exit */ } }
  // Let the runner's stdout frames drain to the supervisor.
  for (let i = 0; i < 8 && !stdoutChunks.join('').includes('SYNC_READ'); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return stdoutChunks.join('');
}

// ── Arm 1 (control): with the fill disabled, the read must FAIL ─────────────
//
// If this arm passed, the file would have been in the bundle all along and the
// store would be proving nothing.
allowFill = false;
const control = await run();
assert.ok(
  !control.includes('SYNC_READ_OK'),
  `control arm must not satisfy the read from the bundle, but it did: ${control.trim()}`,
);
assert.ok(
  control.includes('SYNC_READ_FAILED'),
  `control arm should report a failed synchronous read, got: ${control.trim()}`,
);

// ── Arm 2: with the store filled, the same first read must SUCCEED ──────────
allowFill = true;
const filled = await run();
assert.ok(
  filled.includes('SYNC_READ_OK'),
  `a first synchronous read of an untouched file must succeed, got: ${filled.trim()}`,
);
assert.ok(
  filled.includes(`len=${UNTOUCHED_BODY.length} head=NNNNNNNN`),
  `the read must return the file's real bytes and full length, got: ${filled.trim()}`,
);
assert.ok(
  filled.includes(`SMALL_READ_OK small-287`),
  `a first synchronous read must also succeed where the PATH bound binds, got: ${filled.trim()}`,
);
assert.ok(fsListCalls > 0, 'the store must have asked the authority what exists');
assert.ok(fsReadBatchCalls > 0, 'the store must have been filled over the supervisor');

console.log('resident-first-sync-read-of-untouched-file: ok');
console.log(`  control: ${control.trim().slice(0, 90)}`);
console.log(`  filled : ${filled.trim().slice(0, 90)}`);
