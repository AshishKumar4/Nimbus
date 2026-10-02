#!/usr/bin/env bun
// The session's own process listing reports a process's exec id.
//
// The session shell's Process tab polls `/api/processes` on the session
// (routes.ts → handleProcessesListRequest), which projects each process
// table entry field by field, so a field the table gained never reached it.
// A process an exec named carries `execId` there as it does in the SDK's
// listing; a process no exec named has no such field. Driven through the
// session's `handleFetch`, over a real process table.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';

const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-exec-id-listing-'));
let handleFetch;
try {
  const build = await Bun.build({
    entrypoints: ['./packages/worker/src/session/routes.ts'],
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));
  ({ handleFetch } = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/routes.js')).path).href));
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

const processes = new SessionProcessSupervisor();
processes.setPidBase(PID_GEN_STRIDE);
const store = new Map();
const self = {
  env: {},
  processes,
  portRegistry: new PortRegistry(),
  viteDevServer: null,
  cirrusReal: null,
  sessionBasePath: '/s/nimble-otter-4271',
  sessionBasePathHydrated: true,
  appDocuments: {},
  ctx: {
    storage: {
      async get(k) { return store.get(k); },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
  },
  async hydrateSessionBasePath() {},
};

const job = processes.spawn('npm run dev', ['npm run dev'], '/home/user/app', { execId: 'j1' });
const server = processes.spawn('node server.js', ['/home/user/app/server.js'], '/home/user/app', { parentPid: job.pid, longRunning: true });
const plain = processes.spawn('node plain.js', ['/home/user/app/plain.js'], '/home/user/app', { longRunning: true });

const response = await handleFetch(self, new Request('https://nimbus.test/api/processes'));
assert.equal(response.status, 200, await response.clone().text());
const { processes: listed } = await response.json();
const byPid = new Map(listed.map((p) => [p.pid, p]));
assert.equal(byPid.get(job.pid)?.execId, 'j1', `the exec's own process reports its id: ${JSON.stringify(listed)}`);
assert.equal(byPid.get(server.pid)?.execId, 'j1', 'and so does what it started');
assert.equal('execId' in byPid.get(plain.pid), false, `a process no exec named has no execId field: ${JSON.stringify(byPid.get(plain.pid))}`);
console.log('  [1] /api/processes reports execId for a tagged process and its child, and no field for an untagged one');

console.log('exec-id-process-listing OK');
