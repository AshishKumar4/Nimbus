#!/usr/bin/env bun
// A pre-bundle's slice is every file of the package, or the pre-bundle fails
// with the reason. Before, the walk skipped any file it could not read, so a
// store that had failed under it (the session's storage deleted) produced a
// slice short of files, its entry among them. rolldown then reported only
// 'Entry module "…" cannot be external'.
//
//   - the walk skips a file removed between listing and reading it (ENOENT),
//     as before;
//   - any other read failure fails the walk, with that error;
//   - a slice without its entry fails the pre-bundle, naming the entry,
//     before the bundler runs.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { buildSliceForSpecifierWithCap } from '../../packages/worker/src/npm/pre-bundle-facet.ts';
import { freshFacetClass, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`  ${ok ? 'ok ' : 'RED'} ${name}`);
};

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const fs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
const nm = 'home/user/app/node_modules';
fs.mkdir(`${nm}/pkg/dist`, { recursive: true });
fs.writeFile(`${nm}/pkg/package.json`, JSON.stringify({ name: 'pkg', type: 'module', exports: { '.': './dist/index.js' } }));
fs.writeFile(`${nm}/pkg/dist/index.js`, "export { helper } from './helper.js';\n");
fs.writeFile(`${nm}/pkg/dist/helper.js`, 'export const helper = 1;\n');

/** The VFS, but reading `path` throws `error`. */
const failing = (path, error) => new Proxy(fs, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (key !== 'readFile' && key !== 'readFileString') return typeof value === 'function' ? value.bind(target) : value;
    return (p, ...rest) => {
      if (p.replace(/^\/+/, '') === path) throw error;
      return value.call(target, p, ...rest);
    };
  },
});
const codeError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const paths = (slice) => slice.slice.filter((entry) => !entry.isDir).map((entry) => entry.path);

// ── The walk ─────────────────────────────────────────────────────────────
{
  const whole = buildSliceForSpecifierWithCap(fs, 'pkg', nm, 1 << 20);
  check('a readable package is walked whole', paths(whole).length === 3, JSON.stringify(paths(whole)));

  const removed = buildSliceForSpecifierWithCap(failing(`${nm}/pkg/dist/helper.js`, codeError('ENOENT', 'removed')), 'pkg', nm, 1 << 20);
  check('a file removed under the walk is passed over', paths(removed).length === 2 && !paths(removed).some((p) => p.endsWith('helper.js')), JSON.stringify(paths(removed)));

  let outcome;
  try {
    outcome = buildSliceForSpecifierWithCap(failing(`${nm}/pkg/dist/index.js`, new Error('no such table: vfs_chunks: SQLITE_ERROR')), 'pkg', nm, 1 << 20);
  } catch (error) {
    outcome = error;
  }
  check('any other read failure fails the walk with its error', outcome instanceof Error && /no such table: vfs_chunks/.test(outcome.message), outcome instanceof Error ? outcome.message : `it returned a slice of ${JSON.stringify(paths(outcome))}`);
}

// ── A slice without its entry ────────────────────────────────────────────
try {
  const { BuildFacet } = await freshFacetClass();
  const facet = new BuildFacet({ id: { toString: () => 'prebundle-slice-integrity' } }, {});
  const encoder = new TextEncoder();
  const root = '/home/user/app/node_modules/pkg';
  const result = await facet.prebundle({
    specifier: 'pkg', entryPath: `${root}/dist/index.js`, externals: [], bundlerVersion: 'prebundle-slice-integrity',
    slice: [
      { path: root, isDir: true },
      { path: `${root}/package.json`, isDir: false, bytes: encoder.encode('{"name":"pkg"}') },
    ],
  });
  check('a slice without its entry fails, naming the entry', result.ok === false && result.errorText.includes(`entry module ${root}/dist/index.js is not in its slice`), JSON.stringify(result).slice(0, 300));
} finally {
  releaseBuildFacetHarness();
}

assert.equal(failures.length, 0, `${failures.length} failed:\n  ${failures.join('\n  ')}`);
console.log('prebundle-slice-integrity OK');
