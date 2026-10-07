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
 *
 * Gone means confirmed gone: node_modules not there, or the store deleted.
 * A node_modules its principal may search but not list (mode 0311) is
 * neither: every pre-bundle goes on, as the package directories in it are
 * read by name.
 */

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
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

// ── A node_modules that may be searched but not listed ─────────────────────
{
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  const owned = (path, write) => {
    write();
    root.chown(path, USER.uid, USER.gid);
  };
  for (const dir of ['app', 'app/src', 'app/node_modules', 'app/node_modules/pkg']) owned(dir, () => root.mkdir(dir, { recursive: true }));
  owned('app/package.json', () => root.writeFile('app/package.json', JSON.stringify({ name: 'app', dependencies: { pkg: '1.0.0' } })));
  owned('app/node_modules/pkg/package.json', () => root.writeFile('app/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' })));
  owned('app/node_modules/pkg/index.js', () => root.writeFile('app/node_modules/pkg/index.js', 'export const x = 1;\n'));
  for (const name of subpaths) owned(`app/node_modules/pkg/${name}.js`, () => root.writeFile(`app/node_modules/pkg/${name}.js`, `export const ${name} = 1;\n`));
  owned('app/src/main.js', () => root.writeFile('app/src/main.js', [
    "import { x } from 'pkg';",
    ...subpaths.map((name) => `import { ${name} } from 'pkg/${name}.js';`),
  ].join('\n') + '\n'));
  root.chmod('app/node_modules', 0o311);
  const user = vfs.as(USER);
  let listing;
  try {
    listing = `listed ${user.readdir('app/node_modules').length}`;
  } catch (error) {
    listing = error.code;
  }
  assert.equal(listing, 'EACCES', 'the user may not list node_modules');
  assert.ok(user.exists('app/node_modules/pkg/package.json'), 'but may search it');

  const sent = [];
  const installer = kernelInstaller(vfs, harness.sql, {
    env,
    ctx: { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage },
    esbuild: new EsbuildService(undefined, {}),
    bundlePool: {
      acquire: async () => ({
        prebundle: async (spec) => {
          sent.push(spec.specifier);
          return { specifier: spec.specifier, ok: true, esmCode: 'export const x = 1;', elapsed: 0, warnings: [] };
        },
      }),
    },
  });
  const said = [];
  await installer.prebundleUsedModules('app', new Map([['pkg', resolved.pkg]]), user, (msg) => said.push(msg));
  const lines = said.join('\n');
  assert.ok(!/stopped|is gone/.test(lines), `a node_modules that cannot be listed is not gone:\n${lines}`);
  assert.equal(sent.length, 5, `every pre-bundle goes on (sent: ${sent.join(', ')}):\n${lines}`);
  assert.match(lines, /Pre-bundle complete: \d\/5 succeeded\./, lines);
}

console.log('npm-prebundle-teardown: ok');
