#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { NODE_SHIMS_ENTRY } from '../../packages/worker/src/node-shims-artifact.generated.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shimsPath = path.resolve(
  here,
  `../../packages/worker/public${NODE_SHIMS_ENTRY}`,
);
const shims = readFileSync(shimsPath, 'utf8');

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
      return worker;
    },
    get() { throw new Error('unexpected keyed loader call'); },
  },
  ASSETS: {
    async fetch() { return new Response(shims); },
  },
};
adoptCtxExports({ SupervisorRPC: () => ({ [Symbol.dispose]() {} }) });

const processes = new SessionProcessSupervisor();
const manager = new FacetManager(
  { id: { toString: () => 'permission-bundle-test' } },
  env,
  processes,
  new PortRegistry(),
  processHostFor,
);
manager.setVfs(rawVfs);

await manager.exec(
  `const fs = require('fs');
   fs.readFileSync('/home/user/project/public.txt');
   fs.readFileSync('/home/user/project/secret.txt');
   fs.readFileSync('/home/user/project/missing.txt');`,
  { cwd: '/home/user/project', filename: '<eval>' },
);
assert.ok(runnerSource, 'FacetManager emitted a runtime worker');

function moduleConstant(name, nextName) {
  const startMarker = `const ${name} = `;
  const start = runnerSource.indexOf(startMarker);
  assert.ok(start >= 0, `generated worker defines ${name}`);
  const endMarker = `;\nconst ${nextName}`;
  const end = runnerSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `generated worker terminates ${name}`);
  return new Function(`return (${runnerSource.slice(start + startMarker.length, end)});`)();
}

const bundle = moduleConstant('__MODULE_VFS_BUNDLE', '__MODULE_VFS_MANIFEST');
const manifest = moduleConstant('__MODULE_VFS_MANIFEST', '__MODULE_VFS_METADATA');
const metadata = moduleConstant('__MODULE_VFS_METADATA', '__compiledModules');
const prefix = 'home/user/project/';

assert.equal(bundle[`${prefix}public.txt`], 'public\n');
assert.deepEqual(
  bundle[`${prefix}secret.txt`],
  { error: 'EACCES' },
  'a present but unreadable file is represented by an EACCES denial cell',
);
assert.equal(
  Object.hasOwn(bundle, `${prefix}missing.txt`),
  false,
  'a nonexistent path is absent rather than represented by a denial cell',
);
assert.deepEqual(
  metadata[`${prefix}public.txt`],
  { type: 'file', size: 7, mode: 0o644, uid: 1000, gid: 1000 },
  'readable-file metadata preserves stored mode and ownership',
);
assert.deepEqual(
  metadata[`${prefix}secret.txt`],
  { type: 'file', size: 7, mode: 0o600, uid: 0, gid: 0 },
  'denied-file metadata remains available for honest statSync results',
);
assert.deepEqual(
  [...manifest['home/user/project']].sort(),
  ['public.txt', 'secret.txt'],
  'readdir metadata records present denied children without inventing missing paths',
);

console.log('facet VFS permission metadata: ok');
