#!/usr/bin/env bun
/**
 * Package self-reference through `exports` — Node's LOAD_PACKAGE_SELF.
 *
 * Inside a package's own directory, `require('<its-name>')` and
 * `require('<its-name>/sub')` resolve through the package's own `exports`
 * map. The rule applies only when the NEAREST enclosing package.json has
 * `exports` and its `name` is the specifier's package name; a package
 * without `exports` does not self-reference, and a nearer package of a
 * different name is the scope — resolution never walks past it to a
 * matching ancestor. It sits after relative/absolute and `#imports`
 * specifiers and before the node_modules walk, so a same-named package in
 * node_modules does not shadow the package's own map. Once the enclosing
 * package claims the name, its map is the whole answer: a subpath it does
 * not expose is not found even when a node_modules copy could satisfy it,
 * and the scope walk never crosses a node_modules directory (a file that
 * sits directly under one belongs to no package).
 *
 * Differential: every expectation below is produced by REAL node
 * (`require.resolve` from a CommonJS file, `import.meta.resolve` from an ESM
 * file) on the same fixture tree, and Nimbus's two resolvers — the runtime
 * shim's require/import chain (driven through its public
 * `__nimbusImportMetaResolve`) and the prefetch walk (`prefetchForRequire`)
 * — must each agree with node. Prefetch and runtime disagreeing would ship
 * a bundle missing the file the runtime then resolves.
 *
 * Two deliberate scope notes, both pre-existing and package-wide (not
 * specific to self-reference):
 *   - Nimbus lowers dynamic `import()` onto its require chain, so a map with
 *     BOTH `import` and `require` conditions answers `import()` with the
 *     `require` target. The import-mode oracle here uses an import-only map,
 *     where node and Nimbus agree.
 *   - Node picks conditions by KEY ORDER in the map; the shared resolver
 *     picks by its condition list. Fixtures avoid maps whose answer depends
 *     on that.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prefetchForRequire } from '../../packages/core/src/runtime/require-resolver.ts';
import { packageSelfReferenceSubpath } from '../../packages/core/src/_shared/exports-resolver.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

// ── Fixture tree (VFS paths, no leading slash) ────────────────────────────

const pkg = (json) => JSON.stringify(json, null, 2) + '\n';

const FILES = {
  // A: a package with a conditional root, a subpath, a wildcard, an
  // imports field, and a same-named decoy in an ancestor node_modules.
  'home/user/pkg/package.json': pkg({
    name: 'selfref-pkg',
    version: '1.0.0',
    exports: {
      '.': { import: './lib/esm.mjs', require: './lib/cjs.cjs' },
      './util': './lib/util.js',
      './feature/*': './lib/features/*.js',
    },
    imports: { '#util': './lib/util.js' },
  }),
  'home/user/pkg/lib/cjs.cjs': 'module.exports = { kind: "cjs" };\n',
  'home/user/pkg/lib/esm.mjs': 'export const kind = "esm";\n',
  'home/user/pkg/lib/util.js': 'module.exports = { util: true };\n',
  'home/user/pkg/lib/features/a.js': 'module.exports = { feature: "a" };\n',
  'home/user/pkg/lib/private.js': 'module.exports = { private: true };\n',
  'home/user/pkg/lib/main.js': '',
  'home/user/pkg/lib/main.mjs': '',
  'home/user/node_modules/selfref-pkg/package.json': pkg({ name: 'selfref-pkg', main: 'index.js' }),
  'home/user/node_modules/selfref-pkg/index.js': 'module.exports = { decoy: true };\n',
  // The decoy also carries the subpath the package's own map does NOT
  // expose: a resolver that falls through to node_modules after the
  // self-reference rule claims the name would find it. Node does not.
  'home/user/node_modules/selfref-pkg/private.js': 'module.exports = { decoyPrivate: true };\n',
  'home/user/node_modules/selfref-pkg/lib/private.js': 'module.exports = { decoyPrivate: true };\n',

  // B: an import-only map.
  'home/user/esm-only/package.json': pkg({ name: 'esm-only-pkg', exports: { '.': { import: './lib/esm.mjs' } } }),
  'home/user/esm-only/lib/esm.mjs': 'export const kind = "esm-only";\n',
  'home/user/esm-only/lib/main.mjs': '',

  // C: no exports — no self-reference, with and without a node_modules copy.
  'home/user/noexports/package.json': pkg({ name: 'noexports-pkg', main: 'index.js' }),
  'home/user/noexports/index.js': 'module.exports = { own: true };\n',
  'home/user/noexports/lib/main.js': '',
  'home/user/noexports-installed/package.json': pkg({ name: 'installed-pkg', main: 'index.js' }),
  'home/user/noexports-installed/index.js': 'module.exports = { own: true };\n',
  'home/user/noexports-installed/lib/main.js': '',
  'home/user/noexports-installed/node_modules/installed-pkg/package.json': pkg({ name: 'installed-pkg', main: 'index.js' }),
  'home/user/noexports-installed/node_modules/installed-pkg/index.js': 'module.exports = { installed: true };\n',

  // D: a nested package of a different name is the scope.
  'home/user/outer/package.json': pkg({ name: 'outer-pkg', exports: { '.': './index.js' } }),
  'home/user/outer/index.js': 'module.exports = { outer: true };\n',
  'home/user/outer/inner/package.json': pkg({ name: 'inner-pkg', exports: { '.': './inner.js' } }),
  'home/user/outer/inner/inner.js': 'module.exports = { inner: true };\n',
  'home/user/outer/inner/lib/main.js': '',

  // F: the project root is a package with exports; a file that sits
  // directly under its node_modules (no package.json of its own between it
  // and the node_modules directory) belongs to no package scope, so the
  // root's name does not self-reference from there. Node's readPackageScope
  // stops at a node_modules directory.
  'home/user/package.json': pkg({ name: 'user-root', exports: { '.': './root.js' } }),
  'home/user/root.js': 'module.exports = { root: true };\n',
  'home/user/node_modules/loose/lib/main.js': '',

  // E: a scoped name.
  'home/user/scoped/package.json': pkg({ name: '@scope/self', exports: { '.': './index.js', './sub': './lib/sub.js' } }),
  'home/user/scoped/index.js': 'module.exports = { scoped: true };\n',
  'home/user/scoped/lib/sub.js': 'module.exports = { sub: true };\n',
  'home/user/scoped/lib/main.js': '',
};

/**
 * [requiring file, specifier, oracle mode] — the expected answer is whatever
 * node says. `require` runs `require.resolve` from a .cjs driver beside the
 * file; `import` runs `import.meta.resolve` from an .mjs driver.
 */
const CASES = [
  // A
  ['home/user/pkg/lib/main.js', 'selfref-pkg', 'require'],
  ['home/user/pkg/lib/main.js', 'selfref-pkg/util', 'require'],
  ['home/user/pkg/lib/main.js', 'selfref-pkg/feature/a', 'require'],
  ['home/user/pkg/lib/main.js', 'selfref-pkg/private', 'require'],
  ['home/user/pkg/lib/main.js', 'selfref-pkg/lib/private.js', 'require'],
  ['home/user/pkg/lib/main.js', '#util', 'require'],
  ['home/user/pkg/lib/main.js', './util.js', 'require'],
  ['home/user/pkg/lib/main.js', 'selfref-pkg-other', 'require'],
  // B
  ['home/user/esm-only/lib/main.mjs', 'esm-only-pkg', 'import'],
  // C
  ['home/user/noexports/lib/main.js', 'noexports-pkg', 'require'],
  ['home/user/noexports-installed/lib/main.js', 'installed-pkg', 'require'],
  // D
  ['home/user/outer/inner/lib/main.js', 'outer-pkg', 'require'],
  ['home/user/outer/inner/lib/main.js', 'inner-pkg', 'require'],
  // F
  ['home/user/node_modules/loose/lib/main.js', 'user-root', 'require'],
  ['home/user/pkg/lib/main.js', 'user-root', 'require'],
  // E
  ['home/user/scoped/lib/main.js', '@scope/self', 'require'],
  ['home/user/scoped/lib/main.js', '@scope/self/sub', 'require'],
  ['home/user/scoped/lib/main.js', '@scope/self/missing', 'require'],
];

// ── Oracle: real node on the same tree ────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'nimbus-self-reference-'));
try {
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  /** node's answer: the resolved path relative to the tree root, or null. */
  function oracle(file, specifier, mode) {
    const dir = dirname(join(root, file));
    const driver = join(dir, mode === 'require' ? '__oracle.cjs' : '__oracle.mjs');
    const body = mode === 'require'
      ? `try { process.stdout.write(JSON.stringify(require.resolve(${JSON.stringify(specifier)}))); } catch (e) { process.stdout.write(JSON.stringify({ code: e.code })); }`
      : `try { process.stdout.write(JSON.stringify(new URL(import.meta.resolve(${JSON.stringify(specifier)})).pathname)); } catch (e) { process.stdout.write(JSON.stringify({ code: e.code })); }`;
    writeFileSync(driver, body);
    const run = spawnSync('node', [driver], { encoding: 'utf8' });
    rmSync(driver);
    assert.equal(run.status, 0, `node oracle failed for ${specifier} from ${file}:\n${run.stderr}`);
    const answer = JSON.parse(run.stdout);
    if (typeof answer === 'string') {
      assert.ok(answer.startsWith(root + '/'), `oracle answered outside the tree: ${answer}`);
      return answer.slice(root.length + 1);
    }
    assert.ok(answer && typeof answer.code === 'string', `oracle answered neither a path nor an error: ${run.stdout}`);
    return null;
  }

  // ── Nimbus runtime: the shim's require/import chain ──────────────────
  class FakeVfs {
    constructor(files) {
      this.files = new Map(Object.entries(files));
      this.dirs = new Set();
      for (const path of this.files.keys()) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
      }
    }
    exists(path) { return this.files.has(path) || this.dirs.has(path); }
    isDirectory(path) { return this.dirs.has(path); }
    readFileString(path) {
      if (!this.files.has(path)) throw new Error(`missing file: ${path}`);
      return this.files.get(path);
    }
  }

  const factory = new Function(
    '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
    '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + generateShimsCode() + '\n;return globalThis.__nimbusImportMetaResolve;',
  );
  const runtimeResolve = factory(
    FILES, {}, {}, {}, {}, null,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/pkg/lib/main.js', '/home/user/pkg/lib',
  );
  /** The runtime's answer: a tree-relative path, or null. */
  function runtime(file, specifier) {
    try {
      const url = runtimeResolve(specifier, 'file:///' + file);
      assert.ok(url.startsWith('file:///'), `runtime answered a non-file URL: ${url}`);
      return url.slice('file:///'.length);
    } catch (error) {
      assert.equal(error.code, 'ERR_MODULE_NOT_FOUND', `runtime failed with something other than not-found: ${error.stack}`);
      return null;
    }
  }

  // ── Nimbus prefetch: the bundle the walk ships for the same specifier ──
  const fixtureModules = Object.keys(FILES).filter((p) => !p.endsWith('package.json'));
  /** The prefetch's answer: which fixture module the walk shipped, or null. */
  async function prefetch(file, specifier, mode) {
    const entry = mode === 'require' ? `require(${JSON.stringify(specifier)});\n` : `import(${JSON.stringify(specifier)});\n`;
    const vfs = new FakeVfs({ ...FILES, [file]: entry });
    const { bundle } = await prefetchForRequire(vfs, entry, dirname(file), file);
    const shipped = fixtureModules.filter((p) => p !== file && p in bundle);
    assert.ok(shipped.length <= 1, `prefetch shipped more than one module for ${specifier}: ${shipped}`);
    return shipped[0] ?? null;
  }

  for (const [file, specifier, mode] of CASES) {
    const expected = oracle(file, specifier, mode);
    assert.equal(runtime(file, specifier), expected, `runtime: ${specifier} from ${file} (node says ${expected})`);
    assert.equal(await prefetch(file, specifier, mode), expected, `prefetch: ${specifier} from ${file} (node says ${expected})`);
    console.log(`  ${specifier.padEnd(28)} from ${file.replace('home/user/', '')}  →  ${expected ?? '(not found)'}`);
  }

  // The rule's own positive cases must actually be self-references — the
  // table above would also pass if node and Nimbus both fell through to a
  // node_modules copy. Pin the answers that only LOAD_PACKAGE_SELF gives.
  assert.equal(oracle('home/user/pkg/lib/main.js', 'selfref-pkg', 'require'), 'home/user/pkg/lib/cjs.cjs', 'self beats the node_modules decoy');
  assert.equal(oracle('home/user/pkg/lib/main.js', 'selfref-pkg/feature/a', 'require'), 'home/user/pkg/lib/features/a.js');
  assert.equal(oracle('home/user/esm-only/lib/main.mjs', 'esm-only-pkg', 'import'), 'home/user/esm-only/lib/esm.mjs');
  assert.equal(oracle('home/user/scoped/lib/main.js', '@scope/self/sub', 'require'), 'home/user/scoped/lib/sub.js');
  assert.equal(oracle('home/user/noexports/lib/main.js', 'noexports-pkg', 'require'), null, 'no exports → no self-reference');
  assert.equal(oracle('home/user/noexports-installed/lib/main.js', 'installed-pkg', 'require'), 'home/user/noexports-installed/node_modules/installed-pkg/index.js');
  assert.equal(oracle('home/user/outer/inner/lib/main.js', 'outer-pkg', 'require'), null, 'a nearer package of another name is the scope');
  assert.equal(oracle('home/user/pkg/lib/main.js', 'selfref-pkg/private', 'require'), null, 'a subpath the map does not expose is not exported, even with a node_modules copy that has it');
  assert.equal(oracle('home/user/node_modules/loose/lib/main.js', 'user-root', 'require'), null, 'the scope walk stops at node_modules');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── The shared rule itself ────────────────────────────────────────────────
{
  const withExports = { name: 'p', exports: './index.js' };
  assert.equal(packageSelfReferenceSubpath(withExports, 'p'), '.');
  assert.equal(packageSelfReferenceSubpath(withExports, 'p/sub/deep'), './sub/deep');
  assert.equal(packageSelfReferenceSubpath(withExports, 'pp'), null, 'a longer name is a different package');
  assert.equal(packageSelfReferenceSubpath(withExports, 'q'), null);
  assert.equal(packageSelfReferenceSubpath({ name: 'p', main: 'index.js' }, 'p'), null, 'no exports → null');
  assert.equal(packageSelfReferenceSubpath({ name: 'p', exports: null }, 'p'), null, 'exports: null → null');
  assert.equal(packageSelfReferenceSubpath({ exports: './index.js' }, 'p'), null, 'no name → null');
  assert.equal(packageSelfReferenceSubpath(null, 'p'), null);
  assert.equal(packageSelfReferenceSubpath({ name: '@s/p', exports: './index.js' }, '@s/p/x'), './x');
}

console.log('package-self-reference: ok');
