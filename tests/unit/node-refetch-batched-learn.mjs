#!/usr/bin/env bun
// A program that writes 1,600 files in one run reaches the session in waves,
// not a call a file, and nothing is learned of its paths one by one afterwards.
//
// preview/new/lucide-barrel-cache-widens runs `node setup.js`, which writes
// 1,600 files with writeFileSync and exits. What the process writes it decides
// itself and sends in its client's waves. S refetched every written path at the
// resumption barrier and learned each one's metadata with an lstat call of its
// own: 1,599 lstat calls from one facet, which in runs that hung under
// concurrent sessions stayed pending and never reached the session.
//
// Real code end to end: FacetManager's one-shot runner with the node shims,
// SupervisorRPC, the session's supervisor ops and SqliteVFS. Only the
// platform's stub is simulated: it copies the envelope as the wire does and
// records each call.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { stagedAssets } from './lib/staged-assets.mjs';
import { runnerLoader } from './lib/one-shot-runner.mjs';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
}));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const { FacetManager } = await import('../../packages/worker/src/facets/manager.ts');
const { processHostFor } = await import('../../packages/worker/src/loaders/process-host.ts');
const { PortRegistry } = await import('../../packages/core/src/runtime/port-registry.ts');
const { adoptCtxExports } = await import('../../packages/fabric/src/composition.ts');
const { createFacetCtx, createFacetWorld } = await import('./lib/facet-host-harness.mjs');
const { processFiles } = await import('./lib/process-bridge.mjs');
const { createAuthority } = await import('./lib/resident-body.mjs');

// The runner installs its own console/process/Buffer while a program runs.
const realConsole = globalThis.console;
const realProcess = globalThis.process;
const realBuffer = globalThis.Buffer;
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const FILES = 1600;

const { host, rawVfs, kfs } = createAuthority();
const ctx = createFacetCtx(createFacetWorld(() => ({})), 'refetch-batch');

// Every op the session is sent, by name (a wave is one writeBatchStream), and
// the paths the session is asked to learn one by one (lstat requests in a batch).
const calls = new Map();
let learns = 0;
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
          if (op === 'fsReadBatch') learns += envelope.args[0].filter((request) => request.lstat === true).length;
          // A round trip takes time: calls issued together overlap.
          await new Promise((resolve) => realSetTimeout(resolve, 1));
          // As RPC carries it: the envelope copied, a stream in it transferred.
          const { stream, ...rest } = envelope;
          return structuredClone(await host.supervisorOp({ ...structuredClone(rest), ...(stream === undefined ? {} : { stream }) }));
        },
        [Symbol.dispose]() {},
      };
    },
  },
};
adoptCtxExports({ SupervisorRPC: ({ props }) => new SupervisorRPC({ props }, hostEnv) });

const env = { LOADER: runnerLoader('refetch-batch'), ASSETS: stagedAssets };

try {
  const manager = new FacetManager(ctx, env, host.processes, new PortRegistry(), processHostFor, {});
  manager.setVfs(rawVfs, processFiles(rawVfs));
  kfs.mkdir('home/user/probe', { recursive: true, mode: 0o755 });

  // The written cells must be fresh at an actual user resumption, not an exit-drain tick.
  const program = `
const fs = require('fs');
const icons = '/home/user/probe/node_modules/lucide-react/dist/esm/icons';
fs.mkdirSync(icons, { recursive: true });
for (let i = 0; i < ${FILES}; i++) fs.writeFileSync(icons + '/dummy-' + i + '.js', 'export default ' + i + ';\\n');
fs.writeFileSync('/home/user/probe/done.txt', 'ok');
setTimeout(() => {
  if (fs.readFileSync('/home/user/probe/done.txt', 'utf8') !== 'ok') throw new Error('the resumed callback lost its own write');
}, 0);
`;
  const result = await manager.exec(program, { filename: '/home/user/probe/setup.js', cwd: '/home/user/probe' });
  globalThis.console = realConsole;
  globalThis.process = realProcess;
  globalThis.Buffer = realBuffer;

  assert.equal(result.exitCode, 0, `setup.js failed: ${result.stderr}`);
  assert.equal([...kfs.readdir('home/user/probe/node_modules/lucide-react/dist/esm/icons')].length, FILES);
  assert.equal(new TextDecoder().decode(kfs.readFile('home/user/probe/done.txt')), 'ok');

  // The writes went to the session in waves, not a call a file, and no path was learned one by one after them.
  const waves = calls.get('writeBatchStream') ?? 0;
  assert.ok(waves >= 1, 'the writes reached the session');
  assert.ok(waves < FILES / 4, `${waves} write waves for ${FILES} written files`);
  assert.ok(learns < FILES / 4, `${learns} lstat learns of ${FILES} written paths, one by one`);
  assert.equal(calls.get('lstat') ?? 0, 0, `${calls.get('lstat')} lstat calls of their own`);
  console.log(`  ok  ${FILES} written files in ${waves} waves, ${learns} learns`);
} finally {
  globalThis.console = realConsole;
  globalThis.process = realProcess;
  globalThis.Buffer = realBuffer;
}
console.log('node-refetch-batched-learn: ok');
