#!/usr/bin/env bun
/**
 * A `.js` specifier resolves to the `.ts` file it names.
 *
 * TypeScript's `"moduleResolution": "NodeNext"` requires authors to write the
 * OUTPUT extension in a specifier that names a TypeScript source, so
 *
 *     // packages/cli/bin/cli.ts
 *     import '../src/program.js';        // means ../src/program.ts
 *
 * is not a quirk of one project — it is what every modern TS project on
 * NodeNext looks like. Real bun resolves it (measured against bun 1.3.1);
 * node does not, and the shared resolver probed node's list only, so the
 * installer's CLI started and then died on its own first import.
 *
 * The scoping is the whole question, because this resolver serves node too.
 * These candidates are FALLBACKS: probed only after every path node itself
 * would take has missed, and only ever naming a TypeScript source. The set of
 * inputs whose resolution changes is therefore exactly the set that resolves
 * to nothing today — where node's own answer is "Cannot find module". No
 * module graph that resolves now resolves differently.
 *
 * Prefetch and the runtime require() must agree on every one of these, or a
 * file is shipped that the facet then cannot find (or vice versa), so the
 * mapping has ONE definition and this test evaluates the copy that is
 * actually emitted into the shim.
 */

import assert from 'node:assert/strict';
import { prefetchForRequire } from '../../packages/core/src/runtime/require-resolver.ts';
import { typescriptFallbackCandidates } from '../../packages/core/src/_shared/typescript-specifiers.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import {
  bundleTypescriptLoader,
  isBundleModuleCandidate,
} from '../../packages/worker/src/facets/manager.ts';

class FakeVfs {
  constructor(files = {}) {
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

/** What the entry's specifiers resolved to — the entry itself is always shipped. */
const bundleOf = (files, entryFile) =>
  Object.keys(prefetchForRequire(
    new FakeVfs(files),
    files[entryFile],
    entryFile.slice(0, entryFile.lastIndexOf('/')),
    entryFile,
  ).bundle).filter((p) => p !== entryFile).sort();

// ── The installer's own shape ─────────────────────────────────────────────
{
  const files = {
    'app/bin/cli.ts': "import '../src/program.js';\n",
    'app/src/program.ts': 'export const program = 1;\n',
  };
  assert.deepEqual(
    bundleOf(files, 'app/bin/cli.ts'),
    ['app/src/program.ts'],
    "a .js specifier from a .ts entry ships the .ts sibling",
  );
}

// ── An existing .js always wins; the fallback never displaces it ───────────
// This is what keeps the change out of node's semantics: when the file the
// specifier literally names exists, it resolves, exactly as it does today.
{
  const files = {
    'app/bin/cli.ts': "import '../src/program.js';\n",
    'app/src/program.js': 'module.exports = 1;\n',
    'app/src/program.ts': 'export const program = 1;\n',
  };
  assert.deepEqual(
    bundleOf(files, 'app/bin/cli.ts'),
    ['app/src/program.js'],
    'the literal .js file still wins over its .ts sibling',
  );
}

// ── A plain CommonJS graph is untouched ───────────────────────────────────
{
  const files = {
    'app/index.js': "require('./lib');\nrequire('./other.js');\n",
    'app/lib/index.js': 'module.exports = 1;\n',
    'app/lib/index.ts': 'export const x = 1;\n',
    'app/other.js': 'module.exports = 2;\n',
    'app/other.ts': 'export const y = 2;\n',
  };
  assert.deepEqual(
    bundleOf(files, 'app/index.js'),
    ['app/lib/index.js', 'app/other.js'],
    'node resolution is unchanged wherever it already resolves',
  );
}

// ── The extensionless and directory-index cases ───────────────────────────
{
  const files = {
    'app/index.ts': "import './helper';\nimport './mod';\n",
    'app/helper.ts': 'export const h = 1;\n',
    'app/mod/index.ts': 'export const m = 1;\n',
  };
  assert.deepEqual(
    bundleOf(files, 'app/index.ts'),
    ['app/helper.ts', 'app/mod/index.ts'],
    'extensionless specifiers reach .ts files and .ts directory indexes',
  );
}

// ── .mjs maps to .mts; .cjs maps to nothing ───────────────────────────────
// Both measured against bun 1.3.1: `./m.mjs` finds `m.mts`, `./m.cjs` does
// not find `m.cts`.
{
  const files = {
    'app/index.ts': "import './a.mjs';\n",
    'app/a.mts': 'export const a = 1;\n',
  };
  assert.deepEqual(bundleOf(files, 'app/index.ts'), ['app/a.mts'], '.mjs finds .mts');
}
{
  const files = {
    'app/index.ts': "require('./b.cjs');\n",
    'app/b.cts': 'export const b = 1;\n',
  };
  assert.deepEqual(bundleOf(files, 'app/index.ts'), [], '.cjs does not find .cts, as in bun');
}

// ── The mapping itself, against the table measured from bun 1.3.1 ─────────
const TABLE = [
  ['src/program.js', ['src/program.ts', 'src/program.tsx']],
  ['src/program.mjs', ['src/program.mts']],
  ['src/program.cjs', []],
  ['src/program.json', []],
  ['src/program.ts', []],
  ['src/program.tsx', []],
  ['src/program.mts', []],
  ['src/program.cts', []],
  ['src/program', ['src/program.ts', 'src/program.tsx']],
  ['src/index', ['src/index.ts', 'src/index.tsx']],
];
for (const [base, expected] of TABLE) {
  assert.deepEqual(typescriptFallbackCandidates(base), expected, `candidates for ${base}`);
}

// ── Prefetch and the emitted runtime cannot disagree ──────────────────────
// The shim carries the same definition, not a copy of it. Evaluating the one
// that is actually emitted is the only way to know they still agree — a
// "keep in sync" comment has never caught a drift.
{
  const shim = generateShimsCode();
  assert.ok(
    shim.includes('__typescriptFallbackCandidates'),
    'the emitted shim carries the TypeScript fallback mapping',
  );
  const start = shim.indexOf('const __NON_MAPPING_EXTENSION');
  const source = shim.slice(start);
  const end = source.indexOf('\n}\n');
  assert.ok(start > 0 && end > 0, 'the emitted mapping is a complete block');
  // eslint-disable-next-line no-new-func
  const emitted = new Function(`${source.slice(0, end + 2)}\nreturn __typescriptFallbackCandidates;`)();
  for (const [base, expected] of TABLE) {
    assert.deepEqual(emitted(base), expected, `the emitted mapping agrees for ${base}`);
  }
}

// ── A resolved .ts file must be COMPILED, not merely shipped ─────────────
// Resolution alone would ship raw TypeScript into the facet, where
// `new Function` on a type annotation is a SyntaxError — the same
// "shipped a file the runtime cannot use" failure the prefetch/runtime
// mirroring exists to prevent, one layer further down.
{
  for (const [path, loader] of [
    ['app/src/program.ts', 'ts'],
    ['app/src/view.tsx', 'tsx'],
    ['app/src/mod.mts', 'ts'],
    ['app/src/mod.cts', 'ts'],
    ['app/src/plain.js', null],
    ['app/src/data.json', null],
    ['app/node_modules/.bin/cli', null],
  ]) {
    assert.equal(bundleTypescriptLoader(path), loader, `loader for ${path}`);
    if (loader !== null) {
      assert.ok(
        isBundleModuleCandidate(path),
        `${path} must reach the bundle transform`,
      );
    }
  }
  // The extensions the transform already covered are still covered.
  for (const path of ['app/a.js', 'app/b.mjs', 'app/node_modules/.bin/cli']) {
    assert.ok(isBundleModuleCandidate(path), `${path} stays a transform candidate`);
  }
  assert.equal(isBundleModuleCandidate('app/data.json'), false, 'json is data');
  assert.equal(isBundleModuleCandidate('app/mod.cjs'), false, 'cjs is already CommonJS');
}

console.log('typescript-specifier-resolution: ok');
