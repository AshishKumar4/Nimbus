#!/usr/bin/env bun
// A resumption that refetches every path a program wrote keeps its supervisor
// calls under the write ledger's in-flight cap.
//
// preview/new/lucide-barrel-cache-widens runs `node setup.js`, which writes
// 1,600 files with writeFileSync and exits. At the resumption barrier every
// written path was refetched at once, and each refetch learns that path's
// metadata with its own lstat, so one facet had 1,601 lstat calls in flight.
// In a run that hung under concurrent sessions those calls stayed pending
// and never reached the session. The write ledger caps its own write-backs
// at 6 because of the same stall (vfs-write-ledger.ts), and the learn now
// takes a slot under that cap.
//
// Real code end to end: FacetManager's one-shot runner (the ledger and the
// shims as spliced into it), SupervisorRPC, the session's supervisor ops and
// SqliteVFS. Only the platform's stub is simulated: it copies the envelope as
// the wire does and counts the calls it is carrying at once.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'bun:test';

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
// vfs-write-ledger.ts __NIMBUS_VFS_RPC_MAX_IN_FLIGHT.
const LEDGER_IN_FLIGHT_CAP = 6;
// The calls the ledger's cap governs: its write-backs and the shims' learns.
const CAPPED = new Set(['writeFile', 'lstat']);

const { host, rawVfs, kfs } = createAuthority();
const ctx = createFacetCtx(createFacetWorld(() => ({})), 'refetch-cap');

const inFlight = new Map();
const peak = new Map();
let cappedInFlight = 0;
let cappedPeak = 0;
const calls = new Map();
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
          inFlight.set(op, (inFlight.get(op) ?? 0) + 1);
          peak.set(op, Math.max(peak.get(op) ?? 0, inFlight.get(op)));
          if (CAPPED.has(op)) cappedPeak = Math.max(cappedPeak, ++cappedInFlight);
          try {
            // A round trip takes time: calls issued together overlap.
            await new Promise((resolve) => realSetTimeout(resolve, 1));
            return structuredClone(await host.supervisorOp(structuredClone(envelope)));
          } finally {
            inFlight.set(op, inFlight.get(op) - 1);
            if (CAPPED.has(op)) cappedInFlight--;
          }
        },
        [Symbol.dispose]() {},
      };
    },
  },
};
adoptCtxExports({ SupervisorRPC: ({ props }) => new SupervisorRPC({ props }, hostEnv) });

const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-refetch-cap-'));
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
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)));
    },
  },
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
  // The shape that stalled: the resumption learned the written paths in one
  // burst. Without it the bounds below would hold vacuously.
  assert.ok((calls.get('lstat') ?? 0) >= FILES / 2, `the refetch learned only ${calls.get('lstat') ?? 0} of ${FILES} written paths`);
  assert.ok(
    (peak.get('lstat') ?? 0) <= LEDGER_IN_FLIGHT_CAP,
    `${peak.get('lstat')} lstat calls were in flight at once; the ledger's cap is ${LEDGER_IN_FLIGHT_CAP}`,
  );
  assert.ok(
    cappedPeak <= LEDGER_IN_FLIGHT_CAP,
    `${cappedPeak} write-backs and learns were in flight at once; they share the ledger's cap of ${LEDGER_IN_FLIGHT_CAP}`,
  );
  console.log(`  ok  ${calls.get('lstat')} learns after ${FILES} writes, at most ${cappedPeak} capped calls in flight`);
} finally {
  globalThis.console = realConsole;
  globalThis.process = realProcess;
  globalThis.Buffer = realBuffer;
  rmSync(runnerDir, { recursive: true, force: true });
}
console.log('node-refetch-in-flight-cap: ok');
