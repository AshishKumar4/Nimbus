#!/usr/bin/env bun
// The Vite dev server's persistent caches answer only the request that made
// the row. user_module_transforms (a project's .ts/.tsx/.jsx, transformed and
// rewritten) and pkg_esm_bundles (a dependency's pre-bundle) outlive an
// isolate, a restart of `vite` and an edit of vite.config; a row is served
// only when what this server would make of the same input is what the row
// holds. So, for each part of a request: a server whose cache another
// configuration warmed serves what the same server serves from an empty
// cache. The parts: the transform's define (vite.config `define`), the
// aliases and `package.json#imports` the import rewrite reads, the router
// basename injection, and a dependency reinstalled at another version.
// And what a request is made from is read once, when it is made: an input
// that moves while it is made (an edit, a reinstall, during the transform's
// or the build's await) is never what its row is keyed on while the row
// holds the other (the moving cases below change it at that await). A
// pre-bundle is keyed on every manifest its build consulted, a nested
// package.json and a workspace package outside node_modules too.
// And a pre-bundle has one request wherever it is made: the installer's
// and the dev server's take the same define (Vite's dev values, none of
// vite.config's, as Vite's optimizer), so a row either writes the other
// serves, and the installer rebuilds a dependency reinstalled at another
// version rather than skip it as current.

import assert from 'node:assert/strict';
import { EsbuildService, buildWithEsbuild } from '../../packages/core/src/runtime/esbuild-service.ts';
import { PREBUNDLE_DEFINE, prebundleSlice } from '../../packages/core/src/runtime/prebundle-slice.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ViteDevServer } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const root = 'home/user/app';

/** A session's SQLite with `files` under the project root (`links`: symlinks, path → target). */
function session(files, links = {}) {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  const write = (path, content) => {
    const at = `${root}/${path}`;
    kernel.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    kernel.writeFile(at, new TextEncoder().encode(content), { mode: 0o644 });
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  for (const [path, target] of Object.entries(links)) {
    const at = `${root}/${path}`;
    kernel.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    kernel.symlink(target, at);
  }
  const remove = (path) => kernel.unlink(`${root}/${path}`);
  return { harness, vfs, write, remove };
}

/** What a dev server started with `config` serves for `path`, on the session's cache (`esbuild`: the service it transforms and builds with). */
async function serve({ harness, vfs }, config, path, esbuild = new EsbuildService(undefined, { engine: esbuildEngine })) {
  const server = new ViteDevServer({
    vfs, cred: CRED_KERNEL, esbuild, root, sql: harness.sql, onHmrMessage() {}, basePath: '/preview', port: 5173, ...config,
  });
  try {
    const response = await server.handleRequest(new Request(`http://localhost/preview${path}`), path);
    return `${response.status}\n${await response.text()}`;
  } finally {
    server.stop?.();
  }
}

const failures = [];
/**
 * `reader` served from a cache `writer` warmed, against `reader` served from
 * an empty cache: the same. `writerFiles`, when given, are the project as
 * the writer saw it (a later edit, or a reinstall, gives the reader `files`).
 */
async function sameAsCold(name, { files, writerFiles = files, writer, reader, path, links = {} }) {
  const warm = session(writerFiles, links);
  const writerSaw = await serve(warm, writer, path);
  for (const [file, content] of Object.entries(files)) {
    if (writerFiles[file] !== content) warm.write(file, content);
  }
  const served = await serve(warm, reader, path);
  const cold = await serve(session(files, links), reader, path);
  assert.ok(cold.startsWith('200\n'), `${name}: the reader's own request is served (${cold.slice(0, 300)})`);
  if (writerSaw === cold) {
    failures.push(`${name}: the writer's and the reader's requests make the same output, so this case checks nothing`);
  } else if (served !== cold) {
    failures.push(`${name}: served the writer's row\n    served: ${served.slice(0, 400)}\n    own:    ${cold.slice(0, 400)}`);
  }
  console.log(`  ${served === cold ? 'ok ' : 'RED'} ${name}`);
}

const PACKAGE = JSON.stringify({ name: 'app', type: 'module', dependencies: { pkg: '1.0.0' } });

try {
  // ── user_module_transforms ─────────────────────────────────────────────
  await sameAsCold('a transform under another vite.config define', {
    files: { 'package.json': PACKAGE, 'src/value.ts': 'export const app: string = __APP__;\n' },
    writer: { define: { __APP__: '"one"' } },
    reader: { define: { __APP__: '"two"' } },
    path: '/src/value.ts',
  });
  await sameAsCold('a transform under other aliases', {
    files: { 'package.json': PACKAGE, 'src/value.ts': "import { v } from '@/lib';\nexport const app: string = v;\n" },
    writer: { aliases: { '@': './src' } },
    reader: { aliases: { '@': './shared' } },
    path: '/src/value.ts',
  });
  await sameAsCold('a transform with and without the router basename injected', {
    files: {
      'package.json': PACKAGE,
      'src/main.tsx': "import { createBrowserRouter } from 'react-router-dom';\nexport const router = createBrowserRouter([{ path: '/', element: null }]);\n",
    },
    writer: { injectBasename: true },
    reader: { injectBasename: false },
    path: '/src/main.tsx',
  });
  await sameAsCold('a transform after package.json#imports moved', {
    files: {
      'package.json': JSON.stringify({ name: 'app', type: 'module', imports: { '#lib': './src/b.ts' } }),
      'src/a.ts': 'export const v = "a";\n',
      'src/b.ts': 'export const v = "b";\n',
      'src/value.ts': "import { v } from '#lib';\nexport const app: string = v;\n",
    },
    writerFiles: {
      'package.json': JSON.stringify({ name: 'app', type: 'module', imports: { '#lib': './src/a.ts' } }),
      'src/a.ts': 'export const v = "a";\n',
      'src/b.ts': 'export const v = "b";\n',
      'src/value.ts': "import { v } from '#lib';\nexport const app: string = v;\n",
    },
    writer: {},
    reader: {},
    path: '/src/value.ts',
  });

  // ── pkg_esm_bundles ────────────────────────────────────────────────────
  const dependency = (version, text) => ({
    'package.json': PACKAGE,
    'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', version, type: 'module', main: 'index.js' }),
    'node_modules/pkg/index.js': text,
  });
  await sameAsCold('a pre-bundle after its package was reinstalled at another version', {
    files: dependency('2.0.0', "export default 'version 2';\n"),
    writerFiles: dependency('1.0.0', "export default 'version 1';\n"),
    writer: {},
    reader: {},
    path: '/@modules/pkg',
  });

  // ── Inputs that move while a request is made ──────────────────────────
  {
    // A service whose transform, or build, changes the project at its await,
    // once: `move` runs after the engine read what it reads, before it answers.
    const moving = (move) => {
      let moved = false;
      const once = () => { if (!moved) { moved = true; move(); } };
      const service = new EsbuildService(undefined, {
        engine: esbuildEngine,
        buildHost: async (options, plugin) => {
          const out = await buildWithEsbuild(await esbuildEngine(), options, plugin);
          once();
          return out;
        },
      });
      const transform = service.transform.bind(service);
      service.transform = async (...args) => {
        const out = await transform(...args);
        once();
        return out;
      };
      return service;
    };
    /** Serve `path` with the project moving under the first request; then, with `after` written, from that cache and from none. */
    const moves = async (name, { files, during, after = {}, path }) => {
      const warm = session(files);
      await serve(warm, {}, path, moving(() => { for (const [file, content] of Object.entries(during)) warm.write(file, content); }));
      for (const [file, content] of Object.entries(after)) warm.write(file, content);
      const served = await serve(warm, {}, path);
      const cold = await serve(session({ ...files, ...during, ...after }), {}, path);
      if (served !== cold) failures.push(`${name}: served a row keyed on what moved\n    served: ${served.slice(0, 300)}\n    own:    ${cold.slice(0, 300)}`);
      console.log(`  ${served === cold ? 'ok ' : 'RED'} ${name}`);
    };
    const imports = (target) => JSON.stringify({ name: 'app', type: 'module', imports: { '#lib': target } });
    await moves('package.json#imports edited during the transform, then back', {
      files: {
        'package.json': imports('./src/a.ts'),
        'src/a.ts': 'export const v = "a";\n', 'src/b.ts': 'export const v = "b";\n',
        'src/value.ts': "import { v } from '#lib';\nexport const app: string = v;\n",
      },
      during: { 'package.json': imports('./src/b.ts') },
      after: { 'package.json': imports('./src/a.ts') },
      path: '/src/value.ts',
    });
    await moves('a dependency reinstalled during its pre-bundle\'s build', {
      files: dependency('1.0.0', "export default 'version 1';\n"),
      during: {
        'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', version: '2.0.0', type: 'module', main: 'index.js' }),
        'node_modules/pkg/index.js': "export default 'version 2';\n",
      },
      path: '/@modules/pkg',
    });
    // A nested package.json the build's resolver consulted (`#impl`, in pkg/part).
    const nested = (impl) => ({
      'package.json': PACKAGE,
      'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', main: 'index.js' }),
      'node_modules/pkg/index.js': "export { v } from './part/x.js';\n",
      'node_modules/pkg/part/package.json': JSON.stringify({ type: 'module', imports: { '#impl': impl } }),
      'node_modules/pkg/part/x.js': "export { v } from '#impl';\n",
      'node_modules/pkg/part/impl-a.js': "export const v = 'impl a';\n",
      'node_modules/pkg/part/impl-b.js': "export const v = 'impl b';\n",
    });
    // A workspace package outside node_modules, linked in: its own package.json is its scope.
    const workspace = (impl) => ({
      'package.json': PACKAGE,
      'packages/ui/package.json': JSON.stringify({ name: 'ui', version: '1.0.0', type: 'module', main: 'index.js', imports: { '#impl': impl } }),
      'packages/ui/index.js': "export { v } from '#impl';\n",
      'packages/ui/impl-a.js': "export const v = 'ui a';\n",
      'packages/ui/impl-b.js': "export const v = 'ui b';\n",
    });
    await sameAsCold('a pre-bundle of a workspace package after its package.json changed', {
      files: workspace('./impl-b.js'),
      writerFiles: workspace('./impl-a.js'),
      links: { 'node_modules/ui': `/${root}/packages/ui` },
      writer: {},
      reader: {},
      path: '/@modules/ui',
    });
    // A nested package.json that appears while the build runs: after the
    // build loaded the source below it (and found none there), before the
    // source's `#impl` resolves, so the build reads the new map. It goes
    // again after the build (the first case), or while the build still runs,
    // once the module it mapped to is read (the second: then only what the
    // build read can tell).
    for (const goes of ['after the build', 'during the build']) {
      const files = {
        'package.json': PACKAGE,
        'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', main: 'index.js', imports: { '#impl': './impl-a.js' } }),
        'node_modules/pkg/index.js': "export { v } from './part/x.js';\n",
        'node_modules/pkg/part/x.js': "export { v } from '#impl';\n",
        'node_modules/pkg/impl-a.js': "export const v = 'root a';\n",
        'node_modules/pkg/part/impl-b.js': "export const v = 'part b';\n",
      };
      const nested = 'node_modules/pkg/part/package.json';
      const warm = session(files);
      // The view the server reads through: the first time anything asks
      // whether the nested package.json exists (the build's resolver of
      // `#impl`, after x.js loaded), it is written first.
      let appeared = false;
      let gone = false;
      const at = (path) => path.replace(/^\/+/, '');
      const appearing = {
        events: warm.vfs.events,
        as(cred) {
          const view = warm.vfs.as(cred);
          return new Proxy(view, {
            get(target, prop) {
              if (prop === 'exists') {
                return (path) => {
                  if (!appeared && at(path) === `${root}/${nested}`) {
                    appeared = true;
                    warm.write(nested, JSON.stringify({ type: 'module', imports: { '#impl': './impl-b.js' } }));
                  }
                  return target.exists(path);
                };
              }
              if (prop === 'readFileString' && goes === 'during the build') {
                return (path) => {
                  const text = target.readFileString(path);
                  if (appeared && !gone && at(path) === `${root}/node_modules/pkg/part/impl-b.js`) {
                    gone = true;
                    warm.remove(nested);
                  }
                  return text;
                };
              }
              const value = Reflect.get(target, prop);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
      const during = await serve({ harness: warm.harness, vfs: appearing }, {}, '/@modules/pkg');
      assert.ok(appeared && during.includes('part b'), `the build read the map that appeared: ${during.slice(0, 300)}`);
      if (goes === 'after the build') warm.remove(nested);
      else assert.ok(gone, 'it went while the build ran');
      const served = await serve(warm, {}, '/@modules/pkg');
      const cold = await serve(session(files), {}, '/@modules/pkg');
      const ok = served === cold;
      const name = `a nested package.json that appeared during the build, and went ${goes}`;
      if (!ok) failures.push(`${name}: served the row built from it\n    served: ${served.slice(0, 300)}\n    own:    ${cold.slice(0, 300)}`);
      console.log(`  ${ok ? 'ok ' : 'RED'} ${name}`);
    }
    await sameAsCold('a pre-bundle after a nested package.json its build read changed', {
      files: nested('./impl-b.js'),
      writerFiles: nested('./impl-a.js'),
      writer: {},
      reader: {},
      path: '/@modules/pkg',
    });
  }

  // ── One pre-bundle request, the installer's and the dev server's ───────
  {
    const files = {
      ...dependency('1.0.0', "export const x = typeof __X__ === 'undefined' ? 'none' : __X__;\nexport const env = process.env.NODE_ENV;\nexport const version = 1;\n"),
      'src/main.ts': "import { x } from 'pkg';\nconsole.log(x);\n",
    };
    const project = session(files);
    // The session's bundle pool, as the build facet runs it: the slice built on esbuild.
    const specs = [];
    const engine = await esbuildEngine();
    const pool = { prebundle: async (spec) => (specs.push(spec), prebundleSlice(spec, (options, plugin) => buildWithEsbuild(engine, options, plugin))) };
    const installer = new NpmInstaller(new ProcessFiles(project.vfs), project.harness.sql, {
      esbuild: new EsbuildService(undefined, { engine: esbuildEngine }),
      bundlePool: { acquire: async () => pool },
    });
    const prebundle = () => installer.prebundleUsedModules(root, new Map([['pkg', {}]]), project.vfs.as(CRED_KERNEL), () => {});
    const row = () => new NpmCache(project.harness.sql).getEsmBundle('pkg');

    await prebundle();
    assert.equal(specs.length, 1, 'the installer pre-bundles the dependency the project imports');
    const installed = row();
    const oneDefine = JSON.stringify(specs[0].define) === JSON.stringify(PREBUNDLE_DEFINE) && installed?.esmCode.includes('"development"');
    if (!oneDefine) failures.push(`the installer's pre-bundle took another define than the dev server's: ${JSON.stringify(specs[0].define)}\n    ${installed?.esmCode}`);
    // A dev server with another vite.config define serves the installer's row
    // as it is: its build host refuses to build, so whatever it serves is the row.
    const esbuild = new EsbuildService(undefined, {
      buildHost: async () => { throw new Error('built: the installer\'s row was not served'); },
    });
    const server = new ViteDevServer({
      vfs: project.vfs, cred: CRED_KERNEL, esbuild, root, sql: project.harness.sql, onHmrMessage() {}, basePath: '/preview', port: 5173,
      define: { __X__: '"a"' },
    });
    const response = await server.handleRequest(new Request('http://localhost/preview/@modules/pkg'), '/@modules/pkg');
    const served = await response.text();
    server.stop?.();
    const shared = response.status === 200 && (served.includes("'none'") || served.includes('"none"'));
    if (!shared) failures.push(`the dev server did not serve the installer's row as it is (${response.status}): ${served.slice(0, 300)}`);
    console.log(`  ${oneDefine && shared ? 'ok ' : 'RED'} a pre-bundle the installer made is the dev server's, one define (none of vite.config's)`);

    // Nothing changed: the installer sees its row as current.
    await prebundle();
    assert.equal(specs.length, 1, 'an unchanged dependency is not pre-bundled again');
    // Reinstalled at another version: rebuilt, not skipped as current.
    project.write('node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '2.0.0', type: 'module', main: 'index.js' }));
    project.write('node_modules/pkg/index.js', 'export const x = "none";\nexport const version = 2;\n');
    await prebundle();
    const reinstalled = row();
    const rebuilt = specs.length === 2 && reinstalled?.esmCode.includes('version = 2');
    if (!rebuilt) failures.push(`the installer kept the bundle of the version it replaced: ${specs.length} builds, ${reinstalled?.esmCode}`);
    console.log(`  ${rebuilt ? 'ok ' : 'RED'} the installer pre-bundles a dependency reinstalled at another version again`);
  }
} finally {
  await stopEsbuildEngine();
}

assert.equal(failures.length, 0, `${failures.length} cases failed:\n  ${failures.join("\n  ")}`);
console.log('vite-dev-cache-requests OK');
