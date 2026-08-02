#!/usr/bin/env bun
/**
 * Residency policy for the entry package's own tree.
 *
 * `addBinTargetSiblings` walks ONLY the package whose bin is executing, so
 * whatever it drops is dropped from precisely the package most likely to read
 * its own data files at runtime. Two production failures came from that:
 *
 *   - typescript reads `lib/lib.*.d.ts`; a `.d.ts` suffix exclusion stripped
 *     them and tsc emitted `Cannot find global type 'Array'`.
 *   - pi reads its own `CHANGELOG.md`; a `.md` exclusion stripped it.
 *
 * And the budget was spent in readdir order, so two ~8 MiB entry bundles that
 * are never read could exhaust it and abandon the rest of the walk before the
 * small files a program actually reads were reached.
 */

import assert from 'node:assert/strict';
import { addBinTargetSiblings } from '../../packages/worker/src/facets/manager.ts';

const MiB = 1024 * 1024;

/** Minimal CredentialedVfs stand-in: a flat path -> size map plus a dir tree. */
function makeVfs(files) {
  const dirs = new Map();
  for (const path of Object.keys(files)) {
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/');
      const name = segs[i];
      const isDir = i < segs.length - 1;
      if (!dirs.has(parent)) dirs.set(parent, new Map());
      dirs.get(parent).set(name, isDir ? 'directory' : 'file');
    }
  }
  return {
    readdir(dir) {
      const d = dirs.get(dir);
      if (!d) throw new Error('ENOENT ' + dir);
      return [...d].map(([name, type]) => ({ name, type }));
    },
    lstat(path) {
      const size = files[path];
      if (size === undefined) throw new Error('ENOENT ' + path);
      return { size, type: 'file' };
    },
    readFile(path) {
      const size = files[path];
      if (size === undefined) throw new Error('ENOENT ' + path);
      return new TextEncoder().encode('x'.repeat(size));
    },
  };
}

// A typescript-shaped package. readdir yields the two huge, never-read
// entry bundles FIRST, which is what made the ordering bug reachable.
const TS_ROOT = 'home/user/node_modules/typescript';
const tsFiles = {
  [`${TS_ROOT}/package.json`]: 2 * 1024,
  [`${TS_ROOT}/CHANGELOG.md`]: 4 * 1024,
  [`${TS_ROOT}/lib/typescript.js`]: 9 * MiB,
  [`${TS_ROOT}/lib/tsc.js`]: 8 * MiB,
  [`${TS_ROOT}/lib/lib.es2020.full.d.ts`]: 64 * 1024,
  [`${TS_ROOT}/lib/lib.dom.d.ts`]: 64 * 1024,
  [`${TS_ROOT}/lib/typesMap.json`]: 8 * 1024,
};

{
  // The bin target itself arrives via the require closure (uncapped, never
  // evicted), so it is already in the bundle before this walk runs.
  const bundle = { [`${TS_ROOT}/lib/tsc.js`]: 'x'.repeat(1024) };
  const budgetState = { totalBytes: 1024, fileCount: 1 };
  addBinTargetSiblings(
    makeVfs(tsFiles),
    `/${TS_ROOT}/lib/tsc.js`,
    bundle,
    budgetState,
    'runtime',
  );

  // The files tsc actually reads must be resident.
  assert.ok(
    bundle[`${TS_ROOT}/lib/lib.es2020.full.d.ts`] !== undefined,
    'lib.es2020.full.d.ts must be resident: tsc reads it, and its absence is the sole cause of TS2318',
  );
  assert.ok(
    bundle[`${TS_ROOT}/lib/lib.dom.d.ts`] !== undefined,
    'lib.dom.d.ts must be resident',
  );
  assert.ok(
    bundle[`${TS_ROOT}/CHANGELOG.md`] !== undefined,
    'CHANGELOG.md must be resident: pi reads its own changelog at runtime',
  );
  assert.ok(
    bundle[`${TS_ROOT}/package.json`] !== undefined,
    'package.json must be resident',
  );

  // A single oversized never-read cell must not be able to consume the budget
  // that the many small read cells need.
  assert.equal(
    bundle[`${TS_ROOT}/lib/typescript.js`],
    undefined,
    '9 MiB typescript.js must not be admitted ahead of the small files that are read',
  );
}

// An oversized file must not truncate the walk: files after it still land.
{
  const files = {
    'home/user/node_modules/p/package.json': 1024,
    'home/user/node_modules/p/huge.bin': 40 * MiB,
    'home/user/node_modules/p/small.json': 512,
    'home/user/node_modules/p/bin/cli.js': 2048,
  };
  const bundle = {};
  const budgetState = { totalBytes: 0, fileCount: 0 };
  addBinTargetSiblings(
    makeVfs(files),
    '/home/user/node_modules/p/bin/cli.js',
    bundle,
    budgetState,
    'runtime',
  );
  assert.equal(bundle['home/user/node_modules/p/huge.bin'], undefined, 'oversized file skipped');
  assert.ok(
    bundle['home/user/node_modules/p/small.json'] !== undefined,
    'a file that does not fit must skip, not abandon the remaining walk',
  );
}

// Build metadata and media stay excluded — they are never read at runtime and
// the budget is real.
{
  const files = {
    'home/user/node_modules/q/package.json': 1024,
    'home/user/node_modules/q/index.js': 2048,
    'home/user/node_modules/q/index.js.map': 900 * 1024,
    'home/user/node_modules/q/logo.png': 700 * 1024,
    'home/user/node_modules/q/tsconfig.tsbuildinfo': 500 * 1024,
    'home/user/node_modules/q/README.md': 3 * 1024,
  };
  const bundle = {};
  const budgetState = { totalBytes: 0, fileCount: 0 };
  addBinTargetSiblings(
    makeVfs(files),
    '/home/user/node_modules/q/index.js',
    bundle,
    budgetState,
    'runtime',
  );
  assert.equal(bundle['home/user/node_modules/q/index.js.map'], undefined, '.map excluded');
  assert.equal(bundle['home/user/node_modules/q/logo.png'], undefined, '.png excluded');
  assert.equal(
    bundle['home/user/node_modules/q/tsconfig.tsbuildinfo'],
    undefined,
    '.tsbuildinfo excluded',
  );
  assert.ok(bundle['home/user/node_modules/q/README.md'] !== undefined, 'markdown is readable data');
}

// The docs/test/example directory exclusions still hold.
{
  const files = {
    'home/user/node_modules/r/package.json': 1024,
    'home/user/node_modules/r/index.js': 2048,
    'home/user/node_modules/r/test/fixture.json': 1024,
    'home/user/node_modules/r/docs/guide.md': 1024,
  };
  const bundle = {};
  const budgetState = { totalBytes: 0, fileCount: 0 };
  addBinTargetSiblings(
    makeVfs(files),
    '/home/user/node_modules/r/index.js',
    bundle,
    budgetState,
    'runtime',
  );
  assert.equal(bundle['home/user/node_modules/r/test/fixture.json'], undefined, 'test/ excluded');
  assert.equal(bundle['home/user/node_modules/r/docs/guide.md'], undefined, 'docs/ excluded');
}

console.log('facet-bin-package-residency-policy: ok');
