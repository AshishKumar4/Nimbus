#!/usr/bin/env bun

import assert from 'node:assert/strict';

import {
  assertStagedBundleFitsRpcPayload,
  buildPrefetchBundle,
  encodedBundleSize,
  greedyAddMainEntries,
} from '../../packages/worker/src/facets/manager.ts';
import {
  CWD_SNAPSHOT_MAX_FILE_BYTES,
  MAX_RPC_SAFE_PAYLOAD_BYTES,
  VFS_BUNDLE_MAX_BYTES,
  VFS_BUNDLE_MAX_FILES,
} from '../../packages/core/src/constants.ts';

class FakeVfs {
  // The bundle is stamped with the cursor it was read at, so a stand-in
  // for the real VFS has to answer for one. A fake never mutates, so the
  // revision never moves.
  epoch = 'fake-vfs-epoch';
  revision() { return 0; }

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

// The encoded-size guard is accounted incrementally so no second copy of the
// payload exists; the number it reports has to stay exactly the number the
// materializing form reported.
{
  const exact = (bundle, manifest) =>
    new TextEncoder().encode(JSON.stringify({ bundle, manifest })).length;
  const cases = [
    [{}, {}],
    [{ 'a.js': 'x' }, {}],
    [{ 'a.js': 'x', 'b/c.js': 'yy' }, { b: ['c.js'] }],
    [{ 'ü/né.js': 'héllo "quoted"\n\tand\\slashes', x: ' \u{1F600}' }, { 'ü': ['né.js'] }],
    [{ 'bin.dat': new Uint8Array([0, 1, 255]), 't.js': 'ok' }, { '.': ['bin.dat', 't.js'] }],
    [{ 'd.txt': { error: 'EACCES' } }, {}],
    // Every escape class JSON.stringify distinguishes: two-character escapes,
    // \u00XX controls, multi-byte code points, a surrogate pair, and a lone
    // surrogate — the string length is computed, not measured, so each one
    // has to be counted right.
    [{ 'esc.js': '\b\t\n\f\r\v\0\x1f "q" \\ é € \u{1F600} \ud800 \udfff' }, { '.': ['esc.js'] }],
  ];
  for (const [bundle, manifest] of cases) {
    assert.equal(
      encodedBundleSize(bundle, manifest).bytes,
      exact(bundle, manifest),
      `incremental encoded size is exact for ${JSON.stringify(Object.keys(bundle))}`,
    );
  }

  // Binary sizing must remain incremental too. JSON.stringify(Uint8Array)
  // materializes a numeric-key object whose text is more than 12x the raw
  // bytes for representative data, defeating the no-copy sizing invariant.
  const binary = new Uint8Array(1024 * 1024);
  binary.fill(255);
  const indexDigits = Array.from(
    { length: String(binary.length - 1).length },
    (_, index) => {
      const digits = index + 1;
      const start = digits === 1 ? 0 : 10 ** (digits - 1);
      const end = Math.min(binary.length, 10 ** digits);
      return Math.max(0, end - start) * digits;
    },
  ).reduce((sum, digits) => sum + digits, 0);
  const encodedBinaryBytes = 1 + indexDigits + (7 * binary.length);
  const originalStringify = JSON.stringify;
  JSON.stringify = (value, ...args) => {
    if (value instanceof Uint8Array) {
      throw new Error('binary sizing materialized Uint8Array JSON');
    }
    return originalStringify(value, ...args);
  };
  try {
    assert.equal(
      encodedBundleSize({ 'data.bin': binary }, {}).bytes,
      38 + encodedBinaryBytes,
      'a large binary cell is sized exactly without materializing its numeric-key JSON',
    );
  } finally {
    JSON.stringify = originalStringify;
  }

  const bundle = { a: 'aaa', b: 'bbbb', c: 'cc' };
  const manifest = { '.': ['a', 'b', 'c'] };
  const size = encodedBundleSize(bundle, manifest);
  for (const key of ['b', 'a', 'c']) {
    delete bundle[key];
    size.remove(key);
    assert.equal(
      size.bytes,
      exact(bundle, manifest),
      `incremental encoded size stays exact after evicting ${key}`,
    );
  }
}

// The working-tree sweep guesses at what a program might read. One guessed
// file must not take the whole budget: that is what every later invocation
// then carries while the supervisor still holds the cached copy.
{
  const cwd = 'home/user';
  const files = {
    [`${cwd}/index.js`]: 'module.exports = 1;',
    [`${cwd}/small.json`]: '{"a":1}',
    [`${cwd}/data.bin`]: 'D'.repeat(CWD_SNAPSHOT_MAX_FILE_BYTES + 1),
  };
  const snapshot = await buildPrefetchBundle(
    new FakeVfs(files),
    undefined,
    cwd,
    '',
    identityEsbuild,
  );

  assert.equal(
    snapshot.bundle[`${cwd}/data.bin`],
    undefined,
    'the working-tree sweep skips a file past the per-file ceiling',
  );
  assert.equal(
    snapshot.bundle[`${cwd}/small.json`],
    files[`${cwd}/small.json`],
    'ordinary project files still ride along',
  );
}

console.log('facet VFS snapshot closure: ok');
