#!/usr/bin/env bun
/**
 * An install's background pre-bundle can outlive its session: a client that
 * destroys the session once its preview loads (every probe does) deletes the
 * Durable Object's storage, VFS tables and all, while pre-bundles are still
 * queued. Each one after that used to walk a store with no tables. The walk
 * swallowed every read error, so it either threw "no such table: vfs_inodes"
 * or produced an empty slice, which rolldown reported as 'Entry module
 * "…/clsx/dist/clsx.mjs" cannot be external'. That was 470 logged failures
 * over 10-06, every one after its session had closed.
 *
 * Here the bundle pool's first pre-bundle deletes the storage (every table,
 * as ctx.storage.deleteAll does). The phase stops there: one line says
 * node_modules is gone and how many were not pre-bundled (the one in flight
 * among them: there is nowhere left to keep it), the summary counts them as
 * stopped, and no pre-bundle fails.
 */

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { kernelInstaller } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir('app/node_modules/pkg', { recursive: true });
root.mkdir('app/src', { recursive: true });
root.writeFile('app/package.json', JSON.stringify({ name: 'app', dependencies: { pkg: '1.0.0' } }));
root.writeFile('app/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }));
root.writeFile('app/node_modules/pkg/index.js', 'export const x = 1;\n');
// Five pre-bundles: the package and four of its subpaths.
const subpaths = ['a', 'b', 'c', 'd'];
for (const name of subpaths) root.writeFile(`app/node_modules/pkg/${name}.js`, `export const ${name} = 1;\n`);
root.writeFile('app/src/main.js', [
  "import { x } from 'pkg';",
  ...subpaths.map((name) => `import { ${name} } from 'pkg/${name}.js';`),
  `console.log(x, ${subpaths.join(', ')});`,
].join('\n') + '\n');

const resolved = {
  pkg: {
    name: 'pkg', version: '1.0.0', tarballUrl: 'https://registry.invalid/pkg-1.0.0.tgz', integrity: 'sha512-fixture',
    dependencies: {}, exports: null, main: 'index.js', module: '', bin: {},
  },
  deps: {}, peerDeps: {}, optionalDeps: {}, cacheWrites: [], messages: [], events: [],
  packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
};
const env = {
  LOADER: { get() { return { getEntrypoint: () => ({ execute: async () => resolved }) }; } },
  NIMBUS_SESSION: {
    idFromName: (name) => ({ toString: () => name, name }),
    idFromString: (id) => ({ toString: () => id, name: id }),
    get: () => ({ supervisorOp: async (envelope) => ({ results: envelope.args[1].map(() => resolved) }) }),
  },
};

/** ctx.storage.deleteAll, as the session's destroy calls it: every table goes. */
const deleteAll = () => {
  const tables = harness.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) harness.db.run(`DROP TABLE IF EXISTS "${name}"`);
  return tables.length;
};

const bundled = [];
let dropped = 0;
const bundlePool = {
  acquire: async () => ({
    prebundle: async (spec) => {
      bundled.push(spec.specifier);
      // The client destroys the session while this one is in flight.
      if (bundled.length === 1) dropped = deleteAll();
      return { specifier: spec.specifier, ok: true, esmCode: 'export const x = 1;', elapsed: 0, warnings: [] };
    },
  }),
};

const late = [];
const done = Promise.withResolvers();
const originalLog = console.log;
console.log = (...args) => {
  const line = args.join(' ');
  if (!line.startsWith('[npm:late]')) return originalLog(...args);
  late.push(line);
  if (line.includes('Pre-bundle complete')) done.resolve();
};
try {
  const installer = kernelInstaller(vfs, harness.sql, {
    env,
    ctx: { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage },
    esbuild: new EsbuildService(undefined, {}),
    bundlePool,
  });
  const said = [];
  const result = await installer.install('app', { onProgress: (msg) => said.push(msg) });
  assert.deepEqual(result.failed, []);
  assert.ok(said.some((msg) => /Pre-bundling 5 modules/.test(msg)), `five pre-bundles start inside the install:\n${said.join('\n')}`);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no summary in 10 s:\n${late.join('\n')}`)), 10_000); });
  await Promise.race([done.promise, timeout]).finally(() => clearTimeout(timer));
} finally {
  console.log = originalLog;
}

assert.ok(dropped > 0, 'the storage had tables to delete');
const lines = late.join('\n');
assert.deepEqual(bundled.length, 1, `nothing is sent to the bundler after the storage is gone (sent: ${bundled.join(', ')})`);
assert.ok(!/slice walk threw|cannot be external|is not in its slice|pre-bundle failed|cache-write failed|not cached/.test(lines), `no pre-bundle fails on the deleted store, the one in flight included:\n${lines}`);
const stopped = late.filter((line) => /pre-bundle stopped: app\/node_modules is gone/.test(line));
assert.equal(stopped.length, 1, `one line says why the phase stopped:\n${lines}`);
// The one in flight bundled, but there is nowhere left to keep it: stopped too.
assert.match(stopped[0], /5 not pre-bundled/, stopped[0]);
assert.match(lines, /Pre-bundle complete: 0\/0 succeeded, 5 stopped/, lines);

console.log('npm-prebundle-teardown: ok');
