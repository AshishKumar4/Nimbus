#!/usr/bin/env bun
// What the snapshot spends first when it is over its bound.
//
// The bundle exists so the facet's `require` resolves synchronously, and the
// size guard sheds "optional" cells — everything outside the statically
// proven closure — until the snapshot fits. It shed them largest-first, which
// ranks a cell by what it COSTS and never by what losing it costs.
//
// Those are not the same thing. The greedy oversample admits a package's
// chunks without walking their own static imports, so an admitted module and
// the sibling it imports are both "optional"; shedding the sibling leaves a
// module in the bundle that cannot load. A declaration file next to them
// cannot be the target of a `require` at all, so shedding one cannot orphan
// anything — yet largest-first keeps the declaration whenever it happens to
// be the smaller file.
//
// `astro dev` died exactly there (nimbus-tw-astro, 2026-09-22): the snapshot
// went 591 files over the bound, `rolldown/dist/experimental-index.mjs` was
// retained, and the `./shared/resolve-tsconfig-Bf6oL9fm.mjs` it statically
// imports was evicted. The process exited 1 having printed that path and
// nothing else.

import assert from 'node:assert/strict';
import {
  buildPrefetchBundle,
  isTypescriptDeclarationFile,
} from '../../packages/worker/src/facets/manager.ts';
import { BUNDLE_MAX_ENCODED_BYTES } from '../../packages/core/src/constants.ts';

class FakeVfs {
  get authority() {
    return {
      acquire: async () => ({ epoch: this.epoch, rev: this.revision() }),
      stat: async (path) => this.lstat(path),
    };
  }

  epoch = 'fake-vfs-epoch';
  revision() { return 0; }
  constructor(files) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set();
    for (const file of this.files.keys()) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
  }
  exists(p) { const s = p.replace(/^\/+/, ''); return this.files.has(s) || this.dirs.has(s); }
  isDirectory(p) { return this.dirs.has(p.replace(/^\/+/, '')); }
  readFile(p) { return new TextEncoder().encode(this.readFileString(p)); }
  readFileString(p) {
    const s = p.replace(/^\/+/, '');
    const c = this.files.get(s);
    if (c === undefined) throw new Error(`missing file: ${s}`);
    return c;
  }
  readdir(p) {
    const s = p.replace(/^\/+/, '');
    const prefix = s ? `${s}/` : '';
    const entries = new Map();
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'directory');
    }
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'file');
    }
    return Array.from(entries, ([name, type]) => ({ name, type }));
  }
  lstat(p) {
    const s = p.replace(/^\/+/, '');
    if (this.dirs.has(s)) return { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
    const c = this.files.get(s);
    if (c === undefined) throw new Error(`missing path: ${s}`);
    return { type: 'file', size: c.length, mode: 0o644, uid: 1000, gid: 1000 };
  }
  stat(p) { return this.lstat(p); }
  access(p) { if (!this.exists(p)) throw new Error(`missing path: ${p}`); }
}

const PROJ = 'home/user/proj';
const filler = (bytes, tag) => `// ${tag}\n${'x'.repeat(Math.max(0, bytes - tag.length - 4))}\n`;


// The closure the program proves it needs: the entry and what it requires.
// Sized just under the ceiling so the optional cells below are what pushes
// the snapshot over, by a margin SMALLER than the declaration file — the one
// arrangement where the two orderings disagree about the module.
const REQUIRED_BYTES = BUNDLE_MAX_ENCODED_BYTES - 1_200_000;
const DECL_BYTES = 600 * 1024;
const SIBLING_BYTES = 900 * 1024;

const files = {
  [`${PROJ}/package.json`]: JSON.stringify({ name: 'proj', dependencies: { chunky: '1.0.0' } }),
  [`${PROJ}/app.js`]: 'require("./big.js");\nmodule.exports = 1;\n',
  [`${PROJ}/big.js`]: filler(REQUIRED_BYTES, 'required-closure'),
  // A declaration file: real enough to want, and impossible to `require`.
  [`${PROJ}/types.d.ts`]: filler(DECL_BYTES, 'declarations'),
  // A package whose main entry the oversample admits, and the `shared/` chunk
  // that entry statically imports.
  [`${PROJ}/node_modules/chunky/package.json`]: JSON.stringify({ name: 'chunky', main: 'dist/index.js' }),
  [`${PROJ}/node_modules/chunky/dist/index.js`]:
    'module.exports = require("./shared/helper-Bf6oL9fm.js");\n',
  [`${PROJ}/node_modules/chunky/dist/shared/helper-Bf6oL9fm.js`]:
    `module.exports = () => 1;\n${filler(SIBLING_BYTES, 'shared-chunk')}`,
};

const DECL = `${PROJ}/types.d.ts`;
const SIBLING = `${PROJ}/node_modules/chunky/dist/shared/helper-Bf6oL9fm.js`;

const vfs = new FakeVfs(files);
const state = await buildPrefetchBundle(vfs, `${PROJ}/app.js`, PROJ, files[`${PROJ}/app.js`]);
const bundle = state.bundle;

assert.ok(state.truncated, 'the arrangement really does breach the bound and evict');
assert.ok(
  bundle[`${PROJ}/big.js`] !== undefined,
  'the statically proven closure is never evictable',
);

// The property: a cell the require path can load is not spent while a cell it
// can never load survives. Stated over the whole bundle rather than the two
// named cells, so it holds however the passes order their admissions.
const survivingDeclarations = Object.keys(bundle).filter(isTypescriptDeclarationFile);
const evictedModules = [SIBLING, `${PROJ}/node_modules/chunky/dist/index.js`]
  .filter((path) => files[path] !== undefined && bundle[path] === undefined);
assert.deepEqual(
  evictedModules.length > 0 ? survivingDeclarations : [],
  [],
  `a loadable module was evicted (${evictedModules.join(', ')}) while `
  + `${survivingDeclarations.length} declaration file(s) kept their cells: `
  + `${survivingDeclarations.join(', ')}`,
);

// And concretely, for the shape that took astro down: the declaration goes,
// the statically imported sibling stays.
assert.equal(bundle[DECL], undefined, 'the declaration file is spent first');
assert.ok(
  bundle[SIBLING] !== undefined,
  'the chunk its retained importer statically imports keeps its cell',
);

console.log('facet bundle eviction order: ok');
