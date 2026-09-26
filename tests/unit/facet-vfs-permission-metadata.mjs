#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { moduleMapBundle } from './lib/module-map-bundle.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
kernel.mkdir('home/user/project', { recursive: true, mode: 0o755 });
for (const directory of ['home', 'home/user', 'home/user/project']) {
  kernel.chown(directory, 1000, 1000);
  kernel.chmod(directory, 0o755);
}
kernel.writeFile('home/user/project/public.txt', 'public\n', { mode: 0o644 });
kernel.chown('home/user/project/public.txt', 1000, 1000);
kernel.writeFile('home/user/project/secret.txt', 'secret\n', { mode: 0o600 });
kernel.chown('home/user/project/secret.txt', 0, 0);

let runnerSource = '';
let runnerModules = {};
const entrypoint = {
  async fetch() {
    return Response.json({ pid: 1, exitCode: 0, stdout: '', stderr: '', durationMs: 0 });
  },
  [Symbol.dispose]() {},
};
const worker = {
  getEntrypoint() { return entrypoint; },
  [Symbol.dispose]() {},
};
const env = {
  LOADER: {
    load(config) {
      runnerSource = config.modules['runner.js'];
      runnerModules = config.modules;
      return worker;
    },
    get() { throw new Error('unexpected keyed loader call'); },
  },
  ASSETS: {
    async fetch(request) {
      const staged = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${staged}`, import.meta.url)), { status: 200 });
    },
  },
};
adoptCtxExports({ SupervisorRPC: () => ({ [Symbol.dispose]() {} }) });

const processes = new SessionProcessSupervisor();
// A real session ctx: an exec's bundle build is paged like a resident launch,
// and a build that crosses a turn resumes off ctx.storage's journal pump.
const manager = new FacetManager(
  createFacetCtx(createFacetWorld(() => ({})), 'permission-bundle-test'),
  env,
  processes,
  new PortRegistry(),
  processHostFor,
);
manager.setVfs(rawVfs, processFiles(rawVfs));

await manager.exec(
  `const fs = require('fs');
   fs.readFileSync('/home/user/project/public.txt');
   fs.readFileSync('/home/user/project/secret.txt');
   fs.readFileSync('/home/user/project/missing.txt');`,
  { cwd: '/home/user/project', filename: '<eval>' },
);
assert.ok(runnerSource, 'FacetManager emitted a runtime worker');

const bundle = moduleMapBundle(runnerModules, 'runner.js');
const prefix = 'home/user/project/';

// The bundle carries bytes this process may read, and nothing else: the
// stat and permission verdicts on the rest are the namespace's (an unreadable
// file is EACCES by its mode there; node-shims-permissions).
assert.equal(bundle[`${prefix}public.txt`], 'public\n');
assert.equal(Object.hasOwn(bundle, `${prefix}secret.txt`), false,
  'no bytes of a file this credential cannot read are staged');
assert.equal(Object.hasOwn(bundle, `${prefix}missing.txt`), false, 'a nonexistent path is absent');
assert.equal(/__MODULE_VFS_(MANIFEST|METADATA)/.test(runnerSource), false,
  'the facet carries no spawn-time stat or directory tables: the namespace is its view');

console.log('facet VFS permission metadata: ok');
