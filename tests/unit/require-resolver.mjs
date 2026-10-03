#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { prefetchForRequire } from '../../packages/core/src/runtime/require-resolver.ts';

class FakeVfs {
  get authority() { return { acquire: async () => ({ epoch: this.epoch, rev: this.revision() }), stat: async path => this.lstat(path) }; }

  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set();
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
  }

  exists(path) {
    return this.files.has(path) || this.dirs.has(path);
  }

  isDirectory(path) {
    return this.dirs.has(path);
  }

  readFileString(path) {
    if (!this.files.has(path)) throw new Error(`missing file: ${path}`);
    return this.files.get(path);
  }

  stat(path) {
    if (!this.files.has(path)) throw new Error(`missing file: ${path}`);
    return { size: this.files.get(path).length };
  }

  readdir(path) {
    const prefix = path ? `${path}/` : '';
    const entries = new Map();
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'directory');
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'file');
    }
    return Array.from(entries, ([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

const nm = 'home/user/node_modules';
const vfs = new FakeVfs({
  'home/user/app.js': "require('@scope/pkg/oauth');",
  [`${nm}/@scope/pkg/package.json`]: JSON.stringify({
    name: '@scope/pkg',
    type: 'module',
    exports: {
      './oauth': {
        types: './dist/oauth.d.ts',
        import: './dist/oauth.js',
      },
    },
  }),
  [`${nm}/@scope/pkg/dist/oauth.js`]: 'export const ok = true;',
});

const result = (await prefetchForRequire(vfs, "require('@scope/pkg/oauth');", '/home/user', '/home/user/app.js'));
assert.equal(result.bundle[`${nm}/@scope/pkg/dist/oauth.js`], 'export const ok = true;');

// A CLI entry that defers via a static-string dynamic import must have the
// imported subtree's content prefetched (regression: create-astro.mjs does
// `import('./dist/index.js').then(({main}) => main())`; without following it
// the runtime resolves the path but can't read the content → silent exit).
const dynVfs = new FakeVfs({
  'home/user/cli/create-astro.mjs': "import('./dist/index.js').then(({main}) => main());",
  'home/user/cli/dist/index.js': "import './sibling.js'; export function main() {}",
  'home/user/cli/dist/sibling.js': 'export const x = 1;',
});
const dynResult = (await prefetchForRequire(
  dynVfs,
  "import('./dist/index.js').then(({main}) => main());",
  '/home/user/cli',
  '/home/user/cli/create-astro.mjs',
));
assert.equal(
  dynResult.bundle['home/user/cli/dist/index.js'],
  "import './sibling.js'; export function main() {}",
  'dynamic-import target not prefetched',
);
assert.equal(
  dynResult.bundle['home/user/cli/dist/sibling.js'],
  'export const x = 1;',
  'dynamic-import target subtree not recursively prefetched',
);

// Parent-relative package main: a subdir package.json whose main points at
// "../dist/x" must resolve through the normalized path (regression:
// web-streams-polyfill's ponyfill/package.json -> "../dist/ponyfill").
const relVfs = new FakeVfs({
  'home/user/app2.js': "require('wsp/ponyfill');",
  [`${nm}/wsp/package.json`]: JSON.stringify({ name: 'wsp', main: 'dist/polyfill' }),
  [`${nm}/wsp/dist/polyfill.js`]: 'module.exports = {};',
  [`${nm}/wsp/dist/ponyfill.js`]: 'module.exports = { ponyfill: true };',
  [`${nm}/wsp/ponyfill/package.json`]: JSON.stringify({ name: 'wsp-ponyfill', main: '../dist/ponyfill' }),
});
const relResult = (await prefetchForRequire(relVfs, "require('wsp/ponyfill');", '/home/user', '/home/user/app2.js'));
assert.equal(
  relResult.bundle[`${nm}/wsp/dist/ponyfill.js`],
  'module.exports = { ponyfill: true };',
  'parent-relative package main not resolved/prefetched',
);
// The nested package.json consulted during LOAD_AS_DIRECTORY must have its
// CONTENT in the bundle, not just the manifest: the runtime resolver reads
// ponyfill/package.json#main to repeat the resolution, and for npx-cache
// trees outside cwd that file is in neither the snapshot nor the manifest.
assert.equal(
  relResult.bundle[`${nm}/wsp/ponyfill/package.json`],
  JSON.stringify({ name: 'wsp-ponyfill', main: '../dist/ponyfill' }),
  'nested package.json content not shipped — runtime resolution will ENOENT',
);

// A bare-spec subpath resolved through the package's own `exports` map must
// ship that package.json too (regression: pi's chunk imports
// `@earendil-works/chord/context`; chord's modules were staged but
// chord/package.json was not, and the runtime resolver's sync read of it
// failed with "read synchronously but never staged").
const expVfs = new FakeVfs({
  'home/user/app3.js': "require('dep/ctx');",
  [`${nm}/dep/package.json`]: JSON.stringify({ name: 'dep', exports: { './ctx': './lib/ctx.js' } }),
  [`${nm}/dep/lib/ctx.js`]: 'module.exports = { ctx: true };',
});
const expResult = (await prefetchForRequire(expVfs, "require('dep/ctx');", '/home/user', '/home/user/app3.js'));
assert.equal(
  expResult.bundle[`${nm}/dep/lib/ctx.js`],
  'module.exports = { ctx: true };',
  'exports-map subpath target not prefetched',
);
assert.equal(
  expResult.bundle[`${nm}/dep/package.json`],
  JSON.stringify({ name: 'dep', exports: { './ctx': './lib/ctx.js' } }),
  'package.json consulted for exports-map subpath not shipped — runtime sync read will fail',
);

// Same contract when the exports target lands OUTSIDE the package dir (a
// store-backed / realpath'd layout). Here the walker's enclosing-package
// piggyback ships the manifest next to the resolved FILE, not the one it
// WALKED — so the walked package.json only reaches the bundle through the
// resolver's sink. This is the case that proves the sink call is load-bearing.
const storeVfs = new FakeVfs({
  'home/user/app4.js': "require('dep/ctx');",
  [`${nm}/dep/package.json`]: JSON.stringify({ name: 'dep', exports: { './ctx': '../.store/dep/lib/ctx.js' } }),
  [`${nm}/.store/dep/lib/ctx.js`]: 'module.exports = { ctx: true };',
});
const storeResult = (await prefetchForRequire(storeVfs, "require('dep/ctx');", '/home/user', '/home/user/app4.js'));
assert.equal(
  storeResult.bundle[`${nm}/.store/dep/lib/ctx.js`],
  'module.exports = { ctx: true };',
  'store-backed exports-map subpath target not prefetched',
);
assert.equal(
  storeResult.bundle[`${nm}/dep/package.json`],
  JSON.stringify({ name: 'dep', exports: { './ctx': '../.store/dep/lib/ctx.js' } }),
  'walked package.json not shipped when exports target resolves outside the package dir',
);

console.log('require-resolver: ok');

// Immediately-invoked `createRequire(import.meta.url)('./x')` (pi-coding-agent
// 0.86.1's bin, dist/bundle/cli.js, verbatim). None of the require/import
// regexes match it, so without CREATE_REQUIRE_CALL_RE the walker stops at
// cli.js and the exports-map subpath reached from cli-runtime.js fails at
// runtime ("Cannot find module '@earendil-works/chord/context'").
const piCli = [
  'import { createRequire, enableCompileCache } from "node:module";',
  'enableCompileCache();',
  'createRequire(import.meta.url)("./cli-runtime.js");',
  '',
].join('\n');
const piRuntime = 'import {x} from "@scope/dep/context";\n';
const depPkgJson = JSON.stringify({
  name: '@scope/dep',
  type: 'module',
  exports: {
    '.': { import: './dist/index.js' },
    './context': { source: './src/context.ts', types: './dist/context.d.ts', import: './dist/context.js' },
  },
});
const piVfs = new FakeVfs({
  [`${nm}/pi/dist/cli.js`]: piCli,
  [`${nm}/pi/dist/cli-runtime.js`]: piRuntime,
  [`${nm}/@scope/dep/package.json`]: depPkgJson,
  [`${nm}/@scope/dep/dist/index.js`]: 'export const y = 1;\n',
  [`${nm}/@scope/dep/dist/context.js`]: 'export const x = 1;\n',
});
const piResult = (await prefetchForRequire(piVfs, piCli, '/home/user', `/${nm}/pi/dist/cli.js`));
assert.equal(
  piResult.bundle[`${nm}/pi/dist/cli-runtime.js`],
  piRuntime,
  'createRequire(import.meta.url)("./cli-runtime.js") target not prefetched',
);
assert.equal(
  piResult.bundle[`${nm}/@scope/dep/dist/context.js`],
  'export const x = 1;\n',
  'exports-map subpath reached through createRequire target not prefetched',
);
assert.equal(
  piResult.bundle[`${nm}/@scope/dep/package.json`],
  depPkgJson,
  'package.json for exports-map subpath reached through createRequire target not shipped',
);

console.log('require-resolver: createRequire ok');

// Dynamic-import subtrees: staged after the static closure, never a refusal.
{
  const grammar = 'export default ' + JSON.stringify('x'.repeat(400)) + ';';
  const lazyVfs = new FakeVfs({
    'home/user/cli/bin.mjs': "import './lib/main.js';",
    'home/user/cli/lib/main.js': "import './static.js'; import('./feature.js'); export const m = 1;",
    'home/user/cli/lib/static.js': 'export const s = 1;',
    'home/user/cli/lib/feature.js':
      "import './grammars/a.js'; import './grammars/b.js'; export const f = 1;",
    'home/user/cli/lib/grammars/a.js': grammar,
    'home/user/cli/lib/grammars/b.js': grammar,
  });
  const staticBytes = lazyVfs.files.get('home/user/cli/bin.mjs').length
    + lazyVfs.files.get('home/user/cli/lib/main.js').length
    + lazyVfs.files.get('home/user/cli/lib/static.js').length;

  // Bound fits the static closure and one grammar, not both.
  const featureBytes = lazyVfs.files.get('home/user/cli/lib/feature.js').length;
  const bound = staticBytes + featureBytes + grammar.length + 10;
  const r = await prefetchForRequire(
    lazyVfs, lazyVfs.files.get('home/user/cli/bin.mjs'), '/home/user/cli', '/home/user/cli/bin.mjs', bound,
  );
  assert.ok(!('kind' in r), `lazy subtree past the bound must not refuse the launch: ${JSON.stringify(r)}`);
  assert.deepEqual(
    [...r.speculative],
    ['home/user/cli/lib/feature.js', 'home/user/cli/lib/grammars/a.js'],
    'dynamic-import subtree staged in discovery order within the bound',
  );
  assert.equal(r.bundle['home/user/cli/lib/grammars/b.js'], undefined, 'lazy file past the bound is not staged');
  assert.equal(r.bundle['home/user/cli/lib/static.js'], 'export const s = 1;', 'static closure staged');
  assert.ok(!r.speculative.has('home/user/cli/lib/static.js'), 'static closure is required');

  // The static closure alone past the bound is still a refusal.
  const refused = await prefetchForRequire(
    lazyVfs, lazyVfs.files.get('home/user/cli/bin.mjs'), '/home/user/cli', '/home/user/cli/bin.mjs', staticBytes - 1,
  );
  assert.equal(refused.kind, 'closure-exceeds-bound', 'static closure past the bound refuses');

  // A target reached both lazily and statically is required.
  const bothVfs = new FakeVfs({
    'home/user/cli/bin.mjs': "import './lib/y.js'; import './lib/z.js';",
    'home/user/cli/lib/y.js': "import('./x.js'); export const y = 1;",
    'home/user/cli/lib/z.js': "import './x.js'; export const z = 1;",
    'home/user/cli/lib/x.js': 'export const x = 1;',
  });
  const both = await prefetchForRequire(
    bothVfs, bothVfs.files.get('home/user/cli/bin.mjs'), '/home/user/cli', '/home/user/cli/bin.mjs',
  );
  assert.equal(both.bundle['home/user/cli/lib/x.js'], 'export const x = 1;');
  assert.equal(both.speculative.size, 0, 'a statically reachable file is required even when also imported lazily');

  // The entry's own `import()` defers its main module; that module and its
  // static closure are required, and only ITS dynamic imports are lazy.
  const deferVfs = new FakeVfs({
    'home/user/cli/bin/astro.mjs': "import('../dist/cli/index.js').then(({ cli }) => cli());",
    'home/user/cli/dist/cli/index.js': "import './core.js'; export const cli = () => import('./dev/index.js');",
    'home/user/cli/dist/cli/core.js': 'export const core = 1;',
    'home/user/cli/dist/cli/dev/index.js': 'export const dev = 1;',
  });
  const defer = await prefetchForRequire(
    deferVfs, deferVfs.files.get('home/user/cli/bin/astro.mjs'), '/home/user/cli', '/home/user/cli/bin/astro.mjs',
  );
  assert.ok(!('kind' in defer));
  assert.deepEqual([...defer.speculative], ['home/user/cli/dist/cli/dev/index.js'], 'only the subcommand behind the main module is lazy');
  assert.ok('home/user/cli/dist/cli/core.js' in defer.bundle, "the main module's static closure is staged");
  const deferBound = await prefetchForRequire(
    deferVfs, deferVfs.files.get('home/user/cli/bin/astro.mjs'), '/home/user/cli', '/home/user/cli/bin/astro.mjs', 40,
  );
  assert.equal(deferBound.kind, 'closure-exceeds-bound', "the entry's deferral is part of the required closure");
}

// A native binary is never staged: the facet answers its require from the ABI
// policy, and rolldown's 19 MB `.node` reached lazily starved every subtree after it.
{
  const nativeVfs = new FakeVfs({
    'home/user/cli/bin.mjs': "import './lib/main.js';",
    'home/user/cli/lib/main.js': "require('./binding.node'); import('./feature.js');",
    'home/user/cli/lib/binding.node': 'x'.repeat(600),
    'home/user/cli/lib/feature.js': 'export const f = 1;',
  });
  const r = await prefetchForRequire(
    nativeVfs, nativeVfs.files.get('home/user/cli/bin.mjs'), '/home/user/cli', '/home/user/cli/bin.mjs', 500,
  );
  assert.ok(!('kind' in r), 'a native binary in the closure does not count against the bound');
  assert.equal(r.bundle['home/user/cli/lib/binding.node'], undefined, 'native binary not staged');
  assert.equal(r.bundle['home/user/cli/lib/feature.js'], 'export const f = 1;', 'the lazy subtree after it is staged');
}

// Phase 2 takes the fewest alternatives first. Astro's dev server loads
// vitefu's ESM through the one `import('./index.js')` in vitefu's CommonJS
// proxy; Shiki's language table, discovered before it, defers one import per
// grammar and loads the few a page names. Walked in discovery order the
// grammars spent the bound and the first launch missed vitefu/src/index.js.
{
  const grammar = 'export default ' + JSON.stringify('x'.repeat(400)) + ';';
  const files = {
    'home/user/cli/bin.mjs': "import './lib/langs.js'; import './lib/proxy.cjs';",
    'home/user/cli/lib/langs.js': "export const langs = { a: () => import('./g/a.js'), b: () => import('./g/b.js'), c: () => import('./g/c.js') };",
    'home/user/cli/lib/proxy.cjs': "module.exports.crawl = () => import('./index.js').then((m) => m.crawl());",
    'home/user/cli/lib/index.js': 'export const crawl = () => 1;',
    'home/user/cli/lib/g/a.js': grammar,
    'home/user/cli/lib/g/b.js': grammar,
    'home/user/cli/lib/g/c.js': grammar,
  };
  const vfs = new FakeVfs(files);
  const required = ['home/user/cli/bin.mjs', 'home/user/cli/lib/langs.js', 'home/user/cli/lib/proxy.cjs']
    .reduce((n, path) => n + files[path].length, 0);
  // Room for one grammar, or the proxy's target: not both.
  const bound = required + grammar.length + 10;
  const r = await prefetchForRequire(vfs, files['home/user/cli/bin.mjs'], '/home/user/cli', '/home/user/cli/bin.mjs', bound);
  assert.ok(!('kind' in r), JSON.stringify(r));
  assert.equal(r.bundle['home/user/cli/lib/index.js'], files['home/user/cli/lib/index.js'], "a module's only deferral is staged before a table's");
  assert.deepEqual([...r.speculative], ['home/user/cli/lib/index.js'], 'and the table waits for what room is left');
}

// A package the code locates by its manifest has its bins staged, after every
// deferral the code names. vinext finds the project's Vite with
// `require.resolve("vite/package.json")`, reads its `bin`, and imports
// vite/bin/vite.js by a computed URL; the first launch missed it.
{
  const files = {
    'home/user/app/node_modules/vinext/bin.js': "import './dist/cli.js';",
    'home/user/app/node_modules/vinext/dist/cli.js': [
      'import { createRequire } from "node:module";',
      'const require = createRequire(import.meta.url);',
      'const manifest = require.resolve("vite/package.json");',
      'const own = require.resolve("./package.json");',
      'export const start = () => import("./server.js");',
      'export const run = (bin) => import(bin);',
    ].join('\n'),
    'home/user/app/node_modules/vinext/dist/server.js': 'export const server = 1;',
    'home/user/app/node_modules/vinext/dist/package.json': JSON.stringify({ bin: { own: 'own.js' } }),
    'home/user/app/node_modules/vinext/dist/own.js': 'export {};',
    'home/user/app/node_modules/vite/package.json': JSON.stringify({ name: 'vite', bin: { vite: 'bin/vite.js', up: '../outside.js' } }),
    'home/user/app/node_modules/vite/bin/vite.js': "import '../dist/cli.js';",
    'home/user/app/node_modules/vite/dist/cli.js': 'export const cli = 1;',
    'home/user/app/node_modules/outside.js': 'export {};',
  };
  const vfs = new FakeVfs(files);
  const entry = 'home/user/app/node_modules/vinext/bin.js';
  const r = await prefetchForRequire(vfs, files[entry], '/home/user/app', '/' + entry);
  assert.ok(!('kind' in r), JSON.stringify(r));
  assert.deepEqual([...r.speculative], [
    'home/user/app/node_modules/vinext/dist/server.js',
    'home/user/app/node_modules/vite/bin/vite.js',
    'home/user/app/node_modules/vite/dist/cli.js',
  ], "the located package's bin and its imports, after the code's own deferral");
  assert.equal(r.bundle['home/user/app/node_modules/outside.js'], undefined, 'no bin outside its package');
  assert.equal(r.bundle['home/user/app/node_modules/vinext/dist/own.js'], undefined, 'a relative manifest locates no package');
}
// A package an ES module imports is staged as an ES import loads it, too.
// The process runs the module lowered to CommonJS, whose require takes the
// "require" branch; a module runner that evaluates the same source itself
// (Vite's, under Astro) imports its externals with import(), which takes the
// "import" branch. Astro's dev server missed clsx/dist/clsx.mjs, zod/v4,
// tinyglobby and common-ancestor-path, one per launch, that way. The import
// branch waits in phase 2, ahead of a deferral table.
{
  const files = {
    'home/user/app/node_modules/fw/bin.mjs': "import './lib/render.js';",
    'home/user/app/node_modules/fw/lib/render.js': "import clsx from 'clsx'; export * from 'same'; import './local.js'; export const r = clsx;",
    'home/user/app/node_modules/fw/lib/local.js': 'export const l = 1;',
    'home/user/app/node_modules/fw/node_modules/clsx/package.json': JSON.stringify({ name: 'clsx', exports: { '.': { import: './dist/clsx.mjs', default: './dist/clsx.js' } } }),
    'home/user/app/node_modules/fw/node_modules/clsx/dist/clsx.mjs': 'export default 1;',
    'home/user/app/node_modules/fw/node_modules/clsx/dist/clsx.js': 'module.exports = 1;',
    'home/user/app/node_modules/same/package.json': JSON.stringify({ name: 'same', main: 'index.js' }),
    'home/user/app/node_modules/same/index.js': 'module.exports = {};',
  };
  const vfs = new FakeVfs(files);
  const entry = 'home/user/app/node_modules/fw/bin.mjs';
  const r = await prefetchForRequire(vfs, files[entry], '/home/user/app', '/' + entry);
  assert.ok(!('kind' in r), JSON.stringify(r));
  const clsx = 'home/user/app/node_modules/fw/node_modules/clsx/dist/';
  assert.equal(r.bundle[clsx + 'clsx.js'], files[clsx + 'clsx.js'], "the require branch, which the process's require loads");
  assert.equal(r.bundle[clsx + 'clsx.mjs'], files[clsx + 'clsx.mjs'], 'and the import branch');
  assert.deepEqual([...r.speculative], [clsx + 'clsx.mjs'], 'the import branch is phase 2; a package with one entry adds nothing');
}
// The import branch is optional, and so is the metadata only it reads. A dual
// package whose import branch sits under its own package scope
// (esm/package.json) reads that manifest to resolve it: past the bound, it is
// left out, and the required closure (the require branch) still launches.
// Metadata the required graph reads stays required.
{
  const huge = JSON.stringify({ type: 'module', padding: 'x'.repeat(4096) });
  const files = {
    'home/user/app/node_modules/fw/bin.mjs': "import dual from 'dual'; export default dual;",
    'home/user/app/node_modules/dual/package.json': JSON.stringify({ name: 'dual', exports: { '.': { import: './esm/index.js', default: './cjs/index.js' } } }),
    'home/user/app/node_modules/dual/cjs/index.js': 'module.exports = 1;',
    'home/user/app/node_modules/dual/esm/package.json': huge,
    'home/user/app/node_modules/dual/esm/index.js': 'export default 1;',
  };
  const vfs = new FakeVfs(files);
  const entry = 'home/user/app/node_modules/fw/bin.mjs';
  const required = [entry, 'home/user/app/node_modules/dual/cjs/index.js'].reduce((n, path) => n + files[path].length, 0);
  const r = await prefetchForRequire(vfs, files[entry], '/home/user/app', '/' + entry, required + 64);
  assert.ok(!('kind' in r), `the optional branch's metadata is no refusal: ${JSON.stringify(r)}`);
  assert.equal(r.bundle['home/user/app/node_modules/dual/cjs/index.js'], files['home/user/app/node_modules/dual/cjs/index.js']);
  assert.equal(r.bundle['home/user/app/node_modules/dual/esm/package.json'], undefined, 'metadata past the bound is left out');
  assert.ok(!r.speculative.has('home/user/app/node_modules/dual/package.json'), "the required graph's metadata stays required");
  const roomy = await prefetchForRequire(vfs, files[entry], '/home/user/app', '/' + entry);
  assert.equal(roomy.bundle['home/user/app/node_modules/dual/esm/index.js'], files['home/user/app/node_modules/dual/esm/index.js'], 'with room, the import branch is staged');
  assert.ok(roomy.speculative.has('home/user/app/node_modules/dual/esm/package.json'), 'with the metadata only it read, as optional');
}
// The import branch is the weakest evidence phase 2 has (a module runner may
// load it; the process's own require does not): it waits behind every
// deferral the code names, tables included. Ahead of them it shed Astro's
// Shiki grammars (jsx.mjs, markdown.mjs among 118), which a page's code block
// loads with import().
{
  const grammar = 'export default ' + JSON.stringify('x'.repeat(400)) + ';';
  const files = {
    'home/user/app/node_modules/fw/bin.mjs': "import clsx from 'clsx'; import './langs.js'; export default clsx;",
    'home/user/app/node_modules/fw/langs.js': "export const langs = { a: () => import('./g/a.js'), b: () => import('./g/b.js') };",
    'home/user/app/node_modules/fw/g/a.js': grammar,
    'home/user/app/node_modules/fw/g/b.js': grammar,
    'home/user/app/node_modules/clsx/package.json': JSON.stringify({ name: 'clsx', exports: { '.': { import: './clsx.mjs', default: './clsx.js' } } }),
    'home/user/app/node_modules/clsx/clsx.js': 'module.exports = 1;',
    'home/user/app/node_modules/clsx/clsx.mjs': 'export default ' + JSON.stringify('y'.repeat(400)) + ';',
  };
  const vfs = new FakeVfs(files);
  const entry = 'home/user/app/node_modules/fw/bin.mjs';
  const required = [entry, 'home/user/app/node_modules/fw/langs.js', 'home/user/app/node_modules/clsx/clsx.js']
    .reduce((n, path) => n + files[path].length, 0);
  const r = await prefetchForRequire(vfs, files[entry], '/home/user/app', '/' + entry, required + 2 * grammar.length + 10);
  assert.ok(!('kind' in r), JSON.stringify(r));
  assert.deepEqual([...r.speculative].filter((p) => p.endsWith('.js') || p.endsWith('.mjs')),
    ['home/user/app/node_modules/fw/g/a.js', 'home/user/app/node_modules/fw/g/b.js'], "the code's own table first");
  assert.equal(r.bundle['home/user/app/node_modules/clsx/clsx.mjs'], undefined, 'the import branch takes only the room left');
}
console.log('require-resolver: speculative dynamic imports ok');
