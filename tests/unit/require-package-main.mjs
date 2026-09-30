#!/usr/bin/env bun
/**
 * A package without `exports` is required through `main`, never the
 * bundlers' `module` field — Node's LOAD_AS_DIRECTORY. tinydate@1 ships
 * `main: dist/tinydate.js` (CommonJS `module.exports = fn`) beside
 * `module: dist/tinydate.mjs` (`export default fn`); sirv-cli does
 * `require('tinydate')('{HH}:{mm}:{ss}')`, which threw "tinydate is not a
 * function" when the require loaded the ES module (whose require is its
 * namespace, as Node's require(esm) is).
 *
 * Differential: the expected file is REAL node's `require.resolve` on the
 * same tree, and Nimbus's runtime shim resolver and prefetch walk must each
 * agree, for a root entry and for a legacy nested-directory subpath.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prefetchForRequire } from '../../packages/core/src/runtime/require-resolver.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

const pkg = (json) => JSON.stringify(json) + '\n';
const NM = 'home/user/app/node_modules';
const FILES = {
  [`${NM}/tinydate/package.json`]: pkg({ name: 'tinydate', main: 'dist/tinydate.js', module: 'dist/tinydate.mjs' }),
  [`${NM}/tinydate/dist/tinydate.js`]: 'module.exports = function (s) { return () => s; };\n',
  [`${NM}/tinydate/dist/tinydate.mjs`]: 'export default function (s) { return () => s; }\n',
  // module only, no main: Node falls back to index.js.
  [`${NM}/module-only/package.json`]: pkg({ name: 'module-only', module: 'esm.mjs' }),
  [`${NM}/module-only/esm.mjs`]: 'export default 1;\n',
  [`${NM}/module-only/index.js`]: 'module.exports = 1;\n',
  // Legacy subpath directory with its own package.json.
  [`${NM}/legacy/package.json`]: pkg({ name: 'legacy', main: 'index.js' }),
  [`${NM}/legacy/index.js`]: 'module.exports = 0;\n',
  [`${NM}/legacy/sub/package.json`]: pkg({ main: '../dist/sub.cjs.js', module: '../dist/sub.esm.js' }),
  [`${NM}/legacy/dist/sub.cjs.js`]: 'module.exports = 2;\n',
  [`${NM}/legacy/dist/sub.esm.js`]: 'export default 2;\n',
  'home/user/app/main.js': '',
};
const CASES = ['tinydate', 'module-only', 'legacy/sub'];
const FROM = 'home/user/app/main.js';

const root = mkdtempSync(join(tmpdir(), 'nimbus-require-main-'));
try {
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  function oracle(specifier) {
    const driver = join(root, 'home/user/app/__oracle.cjs');
    writeFileSync(driver, `process.stdout.write(JSON.stringify(require.resolve(${JSON.stringify(specifier)})));`);
    const run = spawnSync('node', [driver], { encoding: 'utf8' });
    rmSync(driver);
    assert.equal(run.status, 0, `node oracle failed for ${specifier}:\n${run.stderr}`);
    return JSON.parse(run.stdout).slice(root.length + 1);
  }

  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return (id, dir) => __resolveFrom(id, dir);',
  );
  const runtime = factory(FILES, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user/app', [], {}, '/' + FROM, '/home/user/app');

  const code = new Set(Object.keys(FILES).filter((p) => !p.endsWith('package.json') && p !== FROM));
  async function prefetch(specifier) {
    const entry = `require(${JSON.stringify(specifier)});\n`;
    const vfs = {
      files: new Map(Object.entries({ ...FILES, [FROM]: entry })),
      exists(path) { return this.files.has(path) || [...this.files.keys()].some((f) => f.startsWith(path + '/')); },
      isDirectory(path) { return !this.files.has(path) && this.exists(path); },
      readFileString(path) { if (!this.files.has(path)) throw new Error(`missing ${path}`); return this.files.get(path); },
    };
    const { bundle } = await prefetchForRequire(vfs, entry, 'home/user/app', FROM);
    return Object.keys(bundle).filter((p) => code.has(p));
  }

  for (const specifier of CASES) {
    const expected = oracle(specifier);
    assert.equal(runtime(specifier, 'home/user/app'), expected, `runtime: ${specifier} (node says ${expected})`);
    const shipped = await prefetch(specifier);
    assert.ok(shipped.includes(expected), `prefetch ships ${expected} for ${specifier}: ${shipped}`);
    assert.ok(!shipped.some((p) => /\.mjs$|esm/.test(p)), `prefetch ships no bundler-only ES entry for ${specifier}: ${shipped}`);
    console.log(`  require(${JSON.stringify(specifier)}) → ${expected}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('require-package-main: require reads main, as node does');
