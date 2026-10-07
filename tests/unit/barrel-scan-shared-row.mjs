#!/usr/bin/env bun
// The installer pre-bundles a project's barrel packages and the Vite dev
// server serves them, through one bundle row per specifier. Both scan the
// project for the names it imports from a barrel, and both must reach the
// same decision for the same project, or the row alternates: the installer
// writes a bundle synthesized from the names it found, the server refuses it
// (its bounded scan left a file unread) and writes a whole one, the next
// install writes a synthesized one again, and every install and preview
// rebuilds the package.
//
// One budget (PROJECT_SCAN) and one rule (a scan that left files unread
// synthesizes nothing) for both. Here a project whose 1.5 MiB generated
// source is past that budget: install, serve, install, serve. The barrel is
// bundled once, whole, by the first install; the row it wrote is the one
// both servings and the second install use, unchanged; and the module
// served provides the name only the unread source imports.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ViteDevServer } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { kernelInstaller } from './npm-fanout-test-env.mjs';
import { freshFacetClass, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const ICONS = 1501;
const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
const write = (path, content) => {
  root.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  root.writeFile(path, content);
};
write('app/package.json', JSON.stringify({ name: 'app', dependencies: { 'big-icons': '1.0.0' } }));
write('app/src/main.ts', "import { I0 } from 'big-icons';\nconsole.log(I0);\n");
// Past the budget's 1 MiB a file: neither scan reads it.
write('app/src/generated.js', `import { I1400 } from 'big-icons';\nconsole.log(I1400);\n// ${'x'.repeat(1536 * 1024)}\n`);
write('app/node_modules/big-icons/package.json', JSON.stringify({ name: 'big-icons', version: '1.0.0', type: 'module', module: 'index.js', main: 'index.js' }));
const index = [];
for (let n = 0; n < ICONS; n++) {
  write(`app/node_modules/big-icons/icons/i${n}.js`, `export const I${n} = ${n};\n`);
  index.push(`export { I${n} } from './icons/i${n}.js';`);
}
write('app/node_modules/big-icons/index.js', index.join('\n') + '\n');

const resolved = {
  pkg: {
    name: 'big-icons', version: '1.0.0', tarballUrl: 'https://registry.invalid/big-icons-1.0.0.tgz', integrity: 'sha512-fixture',
    dependencies: {}, exports: null, main: 'index.js', module: 'index.js', bin: {},
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

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'barrel-scan-shared-row-'));
const cache = new NpmCache(harness.sql);
const row = () => {
  const entry = cache.getEsmBundle('big-icons');
  return entry && { bundleHash: entry.bundleHash, builtAt: entry.builtAt, inputHash: entry.inputHash };
};
const originalLog = console.log;
try {
  const { BuildFacet } = await freshFacetClass();
  const facet = new BuildFacet({ id: { toString: () => 'barrel-scan-shared-row' } }, {});
  const bundled = [];
  const bundlePool = { acquire: async () => ({ prebundle: (spec) => (bundled.push('/' + spec.entryPath.replace(/^\/+/, '')), facet.prebundle(spec)) }) };

  const installer = kernelInstaller(vfs, harness.sql, {
    env,
    ctx: { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage },
    esbuild: new EsbuildService(undefined, {}),
    bundlePool,
  });
  // The background pre-bundle each install starts, to wait for.
  let phase = null;
  const prebundleUsedModules = installer.prebundleUsedModules.bind(installer);
  installer.prebundleUsedModules = (...args) => (phase = prebundleUsedModules(...args));
  const said = [];
  console.log = (...args) => {
    const line = args.join(' ');
    if (line.startsWith('[npm:late]')) said.push(line);
    else originalLog(...args);
  };
  const install = async () => {
    phase = null;
    const result = await installer.install('app', { onProgress: (msg) => said.push(msg) });
    assert.deepEqual(result.failed, [], said.join('\n'));
    await phase;
  };
  /** What a fresh dev server (no cache of its own) serves for big-icons, as an importer of I0 and I1400 gets it. */
  const serve = async (tag) => {
    const server = new ViteDevServer({
      vfs, cred: CRED_KERNEL, esbuild: new EsbuildService(undefined, { engine: esbuildEngine }), root: 'app', sql: harness.sql,
      onHmrMessage() {}, basePath: '/preview', port: 5173, bundlePool,
    });
    const warn = console.warn;
    console.warn = (...args) => said.push(args.join(' '));
    let response;
    try {
      response = await server.handleRequest(new Request('http://localhost/preview/@modules/big-icons'), '/@modules/big-icons');
    } finally {
      console.warn = warn;
      server.stop?.();
    }
    const dir = join(scratch, tag);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'served.mjs'), await response.text());
    writeFileSync(join(dir, 'importer.mjs'), "export { I0, I1400 } from './served.mjs';\n");
    return import(pathToFileURL(join(dir, 'importer.mjs')).href).then((module) => [module.I0, module.I1400], (error) => String(error));
  };

  await install();
  const first = row();
  assert.deepEqual(bundled, ['/app/node_modules/big-icons/index.js'], `the install bundles the barrel once, whole:\n${bundled.join('\n')}\n${said.join('\n')}`);
  assert.ok(first && first.inputHash === '', `its row is a whole bundle's: ${JSON.stringify(first)}`);
  assert.ok(said.some((line) => /left 1 file\(s\) over 1048576 bytes \(app\/src\/generated\.js\) unread: barrel packages are pre-bundled whole/.test(line)), `the install says what its scan left unread:\n${said.join('\n')}`);

  assert.deepEqual(await serve('first'), [0, 1400], 'the preview serves both names');
  assert.equal(bundled.length, 1, `from the install's row, bundling nothing:\n${bundled.join('\n')}`);

  await install();
  assert.equal(bundled.length, 1, `the next install keeps the row, bundling nothing:\n${bundled.join('\n')}`);
  assert.deepEqual(row(), first, 'the row is the first install\'s, unchanged');

  assert.deepEqual(await serve('second'), [0, 1400], 'and the next preview serves both names from it');
  assert.equal(bundled.length, 1, `bundling nothing:\n${bundled.join('\n')}`);
  assert.deepEqual(row(), first, 'the row is still the first install\'s');
} finally {
  console.log = originalLog;
  releaseBuildFacetHarness();
  await stopEsbuildEngine?.();
  rmSync(scratch, { recursive: true, force: true });
}

console.log('barrel-scan-shared-row: ok');
