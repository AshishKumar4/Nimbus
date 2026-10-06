#!/usr/bin/env bun
// A resumption that refetches every path a program wrote pays a round trip
// per batch, not per path — its metadata learns included.
//
// preview/new/lucide-barrel-cache-widens runs `node setup.js`, which writes
// 1,600 files with writeFileSync and exits. At the resumption barrier every
// written path is refetched at once (_acquireAndRefetch), and each refetch
// learns the path's metadata (_learnLive). The reads travelled in batches;
// the learns were one lstat call each — 1,599 lstat calls from one facet, and
// in runs that hung under concurrent sessions those calls stayed pending and
// never reached the session. A learn now rides fsReadBatch as an lstat
// request, so the whole refetch costs about one round trip per batch.
//
// Real code end to end: FacetManager's one-shot runner with the node shims
// and write ledger it splices in (the staged node-shims asset, so the worker
// dist and bundle-node-shims.mjs must be current), SupervisorRPC, the
// session's supervisor ops and SqliteVFS. Only the platform's stub is
// simulated: it copies the envelope as the wire does and records each call.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'bun:test';
import { FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES } from '../../packages/core/src/constants.ts';
import { stagedAssets } from './lib/staged-assets.mjs';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
}));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const { FacetManager } = await import('../../packages/worker/src/facets/manager.ts');
const { processHostFor } = await import('../../packages/worker/src/loaders/process-host.ts');
const { PortRegistry } = await import('../../packages/core/src/runtime/port-registry.ts');
const { adoptCtxExports } = await import('../../packages/fabric/src/composition.ts');
const { createFacetCtx, createFacetWorld } = await import('./facet-host-harness.mjs');
const { processFiles } = await import('./lib/process-bridge.mjs');
const { createAuthority } = await import('./lib/resident-body.mjs');
const { writeModuleSet } = await import('./lib/module-map-bundle.mjs');

// The runner installs its own console/process/Buffer while a program runs.
const realConsole = globalThis.console;
const realProcess = globalThis.process;
const realBuffer = globalThis.Buffer;
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const FILES = 1600;
// node-shims.ts READ_STREAM_CHUNK_BYTES: what one refetch read asks for.
const CHUNK_BYTES = 65536;
// Requests one fsReadBatch round trip can carry: its path bound, or as many
// chunk reads as its byte bound admits.
const PER_BATCH = Math.min(FS_READ_BATCH_PATH_LIMIT, Math.floor(FS_READ_BATCH_REQUEST_BYTES / CHUNK_BYTES));

const { host, rawVfs, kfs } = createAuthority();
const ctx = createFacetCtx(createFacetWorld(() => ({})), 'refetch-batch');

const calls = new Map();
const batched = { ranges: 0, lstats: 0 };
// Every range request sent, as path@offset: one sent twice is a read made twice.
const rangesSent = [];
let batchesInFlight = 0;
let batchesPeak = 0;
const hostEnv = {
  NIMBUS_SESSION: {
    idFromName: (id) => ({ toString: () => id }),
    idFromString: (id) => ({ toString: () => id }),
    get() {
      return {
        async supervisorOp(envelope) {
          const op = envelope.delivery?.op ?? envelope.op;
          calls.set(op, (calls.get(op) ?? 0) + 1);
          if (op === 'stdout' || op === 'stderr' || op === 'reportExit') return undefined;
          if (op === 'fsReadBatch') {
            for (const request of envelope.args[0]) {
              if (request.lstat === true) batched.lstats++;
              else {
                batched.ranges++;
                rangesSent.push(`${request.path}@${request.offset}`);
              }
            }
            batchesPeak = Math.max(batchesPeak, ++batchesInFlight);
          }
          try {
            // A round trip takes time: calls issued together overlap.
            await new Promise((resolve) => realSetTimeout(resolve, 1));
            return structuredClone(await host.supervisorOp(structuredClone(envelope)));
          } finally {
            if (op === 'fsReadBatch') batchesInFlight--;
          }
        },
        [Symbol.dispose]() {},
      };
    },
  },
};
adoptCtxExports({ SupervisorRPC: ({ props }) => new SupervisorRPC({ props }, hostEnv) });

const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-refetch-batch-'));
let runners = 0;
const env = {
  LOADER: {
    load(config) {
      const file = writeModuleSet(join(runnerDir, `runner-${runners++}`), config.modules, 'runner.js');
      const loaded = import(pathToFileURL(file).href);
      return {
        getEntrypoint: () => ({
          async fetch(request) { return (await loaded).default.fetch(request, { SUPERVISOR: config.env?.SUPERVISOR }); },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get() { throw new Error('the one-shot runner is loaded, not keyed'); },
  },
  ASSETS: stagedAssets,
};

try {
  const manager = new FacetManager(ctx, env, host.processes, new PortRegistry(), processHostFor, {});
  manager.setVfs(rawVfs, processFiles(rawVfs));
  kfs.mkdir('home/user/probe', { recursive: true, mode: 0o755 });

  // The probe's setup.js, reduced to what it does to the filesystem.
  const program = `
const fs = require('fs');
const icons = '/home/user/probe/node_modules/lucide-react/dist/esm/icons';
fs.mkdirSync(icons, { recursive: true });
for (let i = 0; i < ${FILES}; i++) fs.writeFileSync(icons + '/dummy-' + i + '.js', 'export default ' + i + ';\\n');
fs.writeFileSync('/home/user/probe/done.txt', 'ok');
`;
  const result = await manager.exec(program, { filename: '/home/user/probe/setup.js', cwd: '/home/user/probe' });
  globalThis.console = realConsole;
  globalThis.process = realProcess;
  globalThis.Buffer = realBuffer;

  assert.equal(result.exitCode, 0, `setup.js failed: ${result.stderr}`);
  assert.equal([...kfs.readdir('home/user/probe/node_modules/lucide-react/dist/esm/icons')].length, FILES);
  assert.equal(new TextDecoder().decode(kfs.readFile('home/user/probe/done.txt')), 'ok');

  // The refetch did learn what it read — the bound below is not vacuous.
  const learns = batched.lstats + (calls.get('lstat') ?? 0);
  assert.ok(learns >= FILES / 2, `the refetch learned only ${learns} of ${FILES} written paths`);
  assert.equal(calls.get('lstat') ?? 0, 0, `${calls.get('lstat')} learns each cost an lstat round trip of their own`);
  // Each read is sent once: a batch a bound closed used to be flushed by
  // the bound and again by the microtask that opened it.
  const distinctReads = new Set(rangesSent).size;
  assert.equal(rangesSent.length, distinctReads,
    `${rangesSent.length - distinctReads} of ${rangesSent.length} range reads were sent more than once`);
  // Read-side round trips: full batches of the distinct reads, and a learn
  // batch for each read batch whose answers it learns from, bar a last
  // partial batch of each.
  const trips = (calls.get('fsReadBatch') ?? 0) + (calls.get('lstat') ?? 0);
  const readBatches = Math.ceil(distinctReads / PER_BATCH);
  const bound = 2 * readBatches + 2;
  assert.ok(
    trips <= bound,
    `the refetch took ${trips} round trips for ${distinctReads} reads and ${learns} learns; ${bound} batches carry them`,
  );
  console.log(`  ok  ${batched.ranges} reads and ${learns} learns in ${trips} round trips (at most ${batchesPeak} in flight)`);
} finally {
  globalThis.console = realConsole;
  globalThis.process = realProcess;
  globalThis.Buffer = realBuffer;
  rmSync(runnerDir, { recursive: true, force: true });
}
console.log('node-refetch-batched-learn: ok');
