// The names an ES module may import from a CommonJS module (core
// runtime/cjs-module-exports.ts), against host Node 22.23.4's
// cjsPreparseModuleExports (lib/internal/modules/esm/translators.js), which
// skips a re-export whose resolution throws. Each package re-exports a path
// its "exports" hides: behind a dead branch, in an optional require() in
// try/catch, and beside one that resolves (React's NODE_ENV entry). Both walks run over Nimbus's
// require resolver: the sync one lifo's loader uses, the async one the
// session's staging uses. Before, the refusal escaped both walks, and the
// import failed where Node's succeeds.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cjsModuleExportNames, cjsModuleExportNamesAsync } from '../../packages/core/src/runtime/cjs-module-exports.ts';
import { createRequireResolver } from '../../packages/core/src/runtime/require-resolution.ts';

const pkg = (name) => JSON.stringify({ name, exports: { '.': './index.js' } });
const FILES = {
  'node_modules/guarded/package.json': pkg('guarded'),
  'node_modules/guarded/index.js': "exports.keep = 1;\nif (false) module.exports = require('guarded/private');\n",
  'node_modules/guarded/private.js': 'exports.secret = 1;\n',
  'node_modules/optional/package.json': pkg('optional'),
  'node_modules/optional/index.js': "try { module.exports = require('optional/private'); } catch { exports.ok = true; }\n",
  'node_modules/optional/private.js': 'exports.secret = 2;\n',
  'node_modules/mixed/package.json': pkg('mixed'),
  'node_modules/mixed/index.js': "if (process.env.NODE_ENV === 'production') {\n  module.exports = require('mixed/private');\n} else {\n  module.exports = require('./whole.js');\n}\n",
  'node_modules/mixed/whole.js': 'exports.a = 1;\nexports.b = 2;\n',
  'node_modules/mixed/private.js': 'exports.secret = 3;\n',
};
const PACKAGES = ['guarded', 'optional', 'mixed'];

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cjs-module-exports-')));
try {
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
  const node = spawnSync('node', ['--input-type=module', '-e', `for (const name of ${JSON.stringify(PACKAGES)}) console.log(JSON.stringify(Object.keys(await import(name))));`], { cwd: directory, encoding: 'utf8' });
  assert.equal(node.status, 0, node.stderr);
  const want = node.stdout.trim().split('\n').map((line) => JSON.parse(line));

  const resolver = createRequireResolver({
    kind(path) {
      try { return statSync(path).isDirectory() ? 'directory' : 'file'; } catch { return null; }
    },
    readText: (path) => readFileSync(path, 'utf8'),
    realpath: (path) => realpathSync(path),
    isBuiltin,
  });
  const source = (path) => readFileSync(path, 'utf8');
  const sync = { source, resolve: (specifier, from) => resolver.resolveSync(specifier, dirname(from))?.path ?? null };
  const async = { source: async (path) => source(path), resolve: async (specifier, from) => (await resolver.resolve(specifier, dirname(from)))?.path ?? null };
  for (const [i, name] of PACKAGES.entries()) {
    const entry = join(directory, 'node_modules', name, 'index.js');
    assert.deepEqual([...cjsModuleExportNames(entry, sync)].sort(), want[i], `${name}: the sync walk names what Node's import does`);
    assert.deepEqual([...await cjsModuleExportNamesAsync(entry, async)].sort(), want[i], `${name}: the async walk names what Node's import does`);
  }
  console.log(`ok - cjs-module-exports-matches-node: ${PACKAGES.length} packages, both walks, as Node ${spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
