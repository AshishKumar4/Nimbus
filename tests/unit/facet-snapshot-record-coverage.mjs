#!/usr/bin/env bun
// The premise a facet's synchronous stat rests on: it is never handed a path
// it has no stat record for. buildPrefetchBundle builds the metadata pass
// LAST, over the final bundle and the manifest, so every name the facet can
// see at spawn arrives with the record that describes it.
//
// If this ever stops holding, statSync starts refusing paths that used to
// resolve — the failure surfaces as EAGAIN on module resolution rather than
// as a wrong stat, so it is worth an assertion of its own rather than being
// left as a property nobody checks.

import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
const enc = new TextEncoder();
const cwd = '/home/user';

const write = (path, content) => {
  const key = path.replace(/^\//, '');
  const parent = key.slice(0, key.lastIndexOf('/'));
  vfs.mkdir(parent, { recursive: true });
  vfs.writeFile(key, enc.encode(content));
};

const entry = "const dep = require('dep');\nconst deep = require('./lib/deep.js');\n";
write(`${cwd}/main.js`, entry);
write(`${cwd}/lib/deep.js`, "module.exports = require('./nested/leaf.js');");
write(`${cwd}/lib/nested/leaf.js`, 'module.exports = 1;');
write(`${cwd}/node_modules/dep/package.json`, '{"name":"dep","main":"index.js"}');
write(`${cwd}/node_modules/dep/index.js`, "module.exports = require('./sub/impl.js');");
write(`${cwd}/node_modules/dep/sub/impl.js`, 'module.exports = 2;');
// A package the require graph never mentions — greedy oversampling reaches it.
write(`${cwd}/node_modules/unreferenced/package.json`, '{"name":"unreferenced","main":"main.js"}');
write(`${cwd}/node_modules/unreferenced/main.js`, 'module.exports = 3;');
// A binary asset, so the metadata pass is exercised on a non-string cell too.
vfs.mkdir('home/user/assets', { recursive: true });
vfs.writeFile('home/user/assets/blob.bin', new Uint8Array([0, 1, 2, 250, 255]));

const state = await buildPrefetchBundle(
  vfs,
  `${cwd}/main.js`,
  cwd,
  entry,
  { async transform(code) { return { code }; } },
);

const missing = [];
for (const path of Object.keys(state.bundle)) {
  if (!(path in state.metadata)) missing.push(path);
}
assert.deepEqual(missing, [], 'every bundled cell arrives with its stat record');

for (const [directory, children] of Object.entries(state.manifest)) {
  if (!(directory in state.metadata)) missing.push(directory);
  for (const child of children) {
    const path = directory ? `${directory}/${child}` : child;
    if (!(path in state.metadata)) missing.push(path);
  }
}
assert.deepEqual(missing, [], 'every name the manifest lists arrives with its stat record');

// The records are the authority's, not defaults: a mode changed on disk
// reaches the facet.
vfs.chmod('home/user/lib/deep.js', 0o600);
const rebuilt = await buildPrefetchBundle(
  vfs,
  `${cwd}/main.js`,
  cwd,
  entry,
  { async transform(code) { return { code }; } },
);
assert.equal(rebuilt.metadata['home/user/lib/deep.js'].mode & 0o777, 0o600);
assert.equal(rebuilt.metadata['home/user/lib/deep.js'].uid, CRED_KERNEL.uid);
assert.equal(rebuilt.metadata['home/user/lib/deep.js'].type, 'file');
assert.equal(rebuilt.metadata['home/user/lib'].type, 'directory');
assert.equal(
  rebuilt.metadata['home/user/lib/nested/leaf.js'].size,
  'module.exports = 1;'.length,
);

console.log('facet-snapshot-record-coverage: all assertions passed');
