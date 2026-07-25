#!/usr/bin/env bun

import assert from 'node:assert/strict';

import {
  assertStagedBundleFitsRpcPayload,
  buildPrefetchBundle,
  greedyAddMainEntries,
} from '../../packages/worker/src/facets/manager.ts';
import {
  MAX_RPC_SAFE_PAYLOAD_BYTES,
  VFS_BUNDLE_MAX_BYTES,
  VFS_BUNDLE_MAX_FILES,
} from '../../packages/worker/src/constants.ts';

class FakeVfs {
  constructor(files) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set();
    for (const file of this.files.keys()) {
      const parts = file.split('/');
      for (let index = 1; index < parts.length; index++) {
        this.dirs.add(parts.slice(0, index).join('/'));
      }
    }
  }

  exists(path) {
    const stripped = path.replace(/^\/+/, '');
    return this.files.has(stripped) || this.dirs.has(stripped);
  }

  isDirectory(path) {
    return this.dirs.has(path.replace(/^\/+/, ''));
  }

  readFile(path) {
    return new TextEncoder().encode(this.readFileString(path));
  }

  readFileString(path) {
    const stripped = path.replace(/^\/+/, '');
    const content = this.files.get(stripped);
    if (content === undefined) throw new Error(`missing file: ${stripped}`);
    return content;
  }

  readdir(path) {
    const stripped = path.replace(/^\/+/, '');
    const prefix = stripped ? `${stripped}/` : '';
    const entries = new Map();
    for (const directory of this.dirs) {
      if (!directory.startsWith(prefix)) continue;
      const rest = directory.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'directory');
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      entries.set(rest, 'file');
    }
    return Array.from(entries, ([name, type]) => ({ name, type }));
  }

  lstat(path) {
    const stripped = path.replace(/^\/+/, '');
    if (this.dirs.has(stripped)) {
      return { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 };
    }
    const content = this.files.get(stripped);
    if (content === undefined) throw new Error(`missing path: ${stripped}`);
    return { type: 'file', size: content.length, mode: 0o644, uid: 1000, gid: 1000 };
  }

  access(path) {
    if (!this.exists(path)) throw new Error(`missing path: ${path}`);
  }
}

const globalModules = 'usr/local/lib/node_modules';
const cliRoot = `${globalModules}/large-cli`;
const entryPath = `${cliRoot}/index.js`;
const largeRequiredPath = `${cliRoot}/large.js`;
const readShebangPath = `${globalModules}/cross-spawn/lib/util/readShebang.js`;
const shebangCommandPath = `${globalModules}/shebang-command/index.js`;
const largeRequiredSource = `module.exports = "${'\\'.repeat(11_600_000)}";`;
const files = {
  [`${cliRoot}/package.json`]: JSON.stringify({ name: 'large-cli', main: 'index.js' }),
  [entryPath]: "require('./large');\nrequire('cross-spawn');",
  [largeRequiredPath]: largeRequiredSource,
  [`${globalModules}/cross-spawn/package.json`]: JSON.stringify({
    name: 'cross-spawn',
    main: 'index.js',
  }),
  [`${globalModules}/cross-spawn/index.js`]: "require('./lib/parse');",
  [`${globalModules}/cross-spawn/lib/parse.js`]: "require('./util/readShebang');",
  [readShebangPath]: "module.exports = require('shebang-command');",
  [`${globalModules}/shebang-command/package.json`]: JSON.stringify({
    name: 'shebang-command',
    main: 'index.js',
  }),
  [shebangCommandPath]: 'module.exports = () => "node";',
};
const vfs = new FakeVfs(files);
const identityEsbuild = { async transform(code) { return { code }; } };
const snapshot = await buildPrefetchBundle(
  vfs,
  `/${entryPath}`,
  '/home/user',
  files[entryPath],
  identityEsbuild,
);

assert.equal(
  snapshot.bundle[largeRequiredPath],
  largeRequiredSource,
  'the encoded-size pass preserves a large required module',
);
assert.equal(
  snapshot.bundle[shebangCommandPath],
  files[shebangCommandPath],
  'the shipped snapshot preserves a deep transitive leaf',
);
assert.equal(
  snapshot.bundleSideModulesRequired,
  true,
  'an oversized required closure is marked for bounded Worker Loader side modules',
);
assert.ok(
  snapshot.manifest[globalModules].includes('shebang-command'),
  'a global bin manifest enumerates hoisted dependency siblings',
);
assert.deepEqual(
  snapshot.manifest[`${globalModules}/shebang-command`].sort(),
  ['index.js', 'package.json'],
  'the hoisted dependency tree is represented in the runtime manifest',
);

{
  const cwd = 'home/user';
  const optionalFiles = {};
  for (let index = 0; index < VFS_BUNDLE_MAX_FILES / 2 + 100; index++) {
    const packageRoot = `${cwd}/node_modules/optional-${index}`;
    optionalFiles[`${packageRoot}/package.json`] = JSON.stringify({
      name: `optional-${index}`,
      main: 'index.js',
    });
    optionalFiles[`${packageRoot}/index.js`] = 'module.exports = true;';
  }
  const requiredPath = `${globalModules}/required/index.js`;
  const bundle = { [requiredPath]: 'x'.repeat(VFS_BUNDLE_MAX_BYTES + 1) };
  const budget = { totalBytes: 0, fileCount: 0 };
  greedyAddMainEntries(new FakeVfs(optionalFiles), cwd, bundle, budget);

  assert.equal(bundle[requiredPath].length, VFS_BUNDLE_MAX_BYTES + 1);
  assert.equal(
    budget.fileCount,
    VFS_BUNDLE_MAX_FILES,
    'optional greedy content retains the existing file-count ceiling',
  );
  assert.ok(
    budget.totalBytes <= VFS_BUNDLE_MAX_BYTES,
    'optional greedy content retains the existing raw-byte ceiling',
  );
  assert.equal(
    Object.keys(bundle).length,
    VFS_BUNDLE_MAX_FILES + 1,
    'the optional budget is independent from required closure content',
  );
}

// Evicting optional enrichment is a real loss — the sync reads it exists for
// have no live fallback — so it has to name what it dropped.
{
  const cwd = 'home/user';
  const optionalFiles = {};
  for (let index = 0; index < 8; index++) {
    const packageRoot = `${cwd}/node_modules/bulky-${index}`;
    optionalFiles[`${packageRoot}/package.json`] = JSON.stringify({
      name: `bulky-${index}`,
      main: 'index.js',
    });
    // Backslashes so the JSON-encoded size (what the ceiling measures) is
    // twice the raw size the greedy pass budgets against.
    optionalFiles[`${packageRoot}/index.js`] = `// ${'\\'.repeat(3 * 1024 * 1024)}`;
  }
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  let evictionSnapshot;
  try {
    evictionSnapshot = await buildPrefetchBundle(
      new FakeVfs(optionalFiles),
      undefined,
      cwd,
      '',
      identityEsbuild,
    );
  } finally {
    console.warn = realWarn;
  }

  assert.equal(evictionSnapshot.truncated, true, 'an over-budget snapshot reports truncation');
  assert.equal(warnings.length, 1, 'optional eviction is reported exactly once');
  assert.match(
    warnings[0],
    /evicted \d+ optional file\(s\)/,
    'the eviction report states how many files went',
  );
  assert.match(
    warnings[0],
    /home\/user\/node_modules\/bulky-\d+\/index\.js \(\d+ bytes\)/,
    'the eviction report names the paths it dropped',
  );
}

// The staged path serializes the snapshot into ONE RPC payload and has no
// side-module relief, so a snapshot that cannot fit must fail loud.
{
  const bundle = {
    'home/user/node_modules/huge/index.js': 'z'.repeat(MAX_RPC_SAFE_PAYLOAD_BYTES + 1),
    'home/user/node_modules/small/index.js': 'module.exports = true;',
  };
  assert.throws(
    () => assertStagedBundleFitsRpcPayload(JSON.stringify(bundle), bundle),
    (error) => (
      error.message.includes(String(MAX_RPC_SAFE_PAYLOAD_BYTES))
      && error.message.includes('home/user/node_modules/huge/index.js')
    ),
    'an undeliverable staged snapshot fails naming the cells that dominate it',
  );

  const fits = { 'home/user/index.js': 'module.exports = true;' };
  assert.doesNotThrow(() => assertStagedBundleFitsRpcPayload(JSON.stringify(fits), fits));
}

console.log('facet VFS snapshot closure: ok');
