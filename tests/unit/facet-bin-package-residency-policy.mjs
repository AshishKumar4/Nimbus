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
import { addBinTargetSiblings, greedyAddMainEntries } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';

const MiB = 1024 * 1024;

/** A launch filesystem holding `files` (path -> size), each `contents[path]` or that many bytes. */
function makeVfs(files, contents) {
  return launchFs(Object.fromEntries(
    Object.entries(files).map(([path, size]) => [path, contents?.[path] ?? 'x'.repeat(size)]),
  )).fs;
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
  (await addBinTargetSiblings(
    makeVfs(tsFiles),
    `/${TS_ROOT}/lib/tsc.js`,
    bundle,
    budgetState,
    'runtime',
  ));

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
  (await addBinTargetSiblings(
    makeVfs(files),
    '/home/user/node_modules/p/bin/cli.js',
    bundle,
    budgetState,
    'runtime',
  ));
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
  (await addBinTargetSiblings(
    makeVfs(files),
    '/home/user/node_modules/q/index.js',
    bundle,
    budgetState,
    'runtime',
  ));
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
  (await addBinTargetSiblings(
    makeVfs(files),
    '/home/user/node_modules/r/index.js',
    bundle,
    budgetState,
    'runtime',
  ));
  assert.equal(bundle['home/user/node_modules/r/test/fixture.json'], undefined, 'test/ excluded');
  assert.equal(bundle['home/user/node_modules/r/docs/guide.md'], undefined, 'docs/ excluded');
}

// The main-entry oversample is a guess too, and the same per-file ceiling
// bounds it. typescript's `main` is the 8.69 MiB `lib/typescript.js`, the
// alternative bundle beside the `lib/tsc.js` that `tsc` actually runs; the
// closure carries the latter, and the guess must not carry the former on
// every invocation. Small main entries — the computed-require safety net the
// pass exists for — still land.
{
  const files = {
    'home/user/package.json': 64,
    'home/user/node_modules/typescript/package.json': 128,
    'home/user/node_modules/typescript/lib/typescript.js': 9 * MiB,
    'home/user/node_modules/typescript/lib/tsc.js': 4 * 1024,
    'home/user/node_modules/left-pad/package.json': 96,
    'home/user/node_modules/left-pad/index.js': 2048,
  };
  const contents = {
    // The oversample follows dependency edges: the project declares both.
    'home/user/package.json': JSON.stringify({ name: 'app', dependencies: { typescript: '*', 'left-pad': '*' } }),
    'home/user/node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', main: './lib/typescript.js' }),
    'home/user/node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', main: 'index.js' }),
  };
  const bundle = {};
  const budgetState = { totalBytes: 0, fileCount: 0 };
  (await greedyAddMainEntries(makeVfs(files, contents), '/home/user', bundle, budgetState));
  assert.equal(
    bundle['home/user/node_modules/typescript/lib/typescript.js'],
    undefined,
    'a 9 MiB main entry is not admitted on a guess',
  );
  assert.ok(
    bundle['home/user/node_modules/typescript/package.json'] !== undefined,
    'the package manifest still lands',
  );
  assert.ok(
    bundle['home/user/node_modules/left-pad/index.js'] !== undefined,
    'a small main entry still lands',
  );
  assert.ok(budgetState.totalBytes < MiB, 'the guess spent nothing on the oversized entry');
}

console.log('facet-bin-package-residency-policy: ok');
