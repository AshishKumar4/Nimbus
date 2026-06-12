#!/usr/bin/env bun
// npm-cache-user-transforms — the user_module_transforms cache must be
// content-addressed: a hit requires BOTH the content hash and bundler
// version to match, so a stale row (changed file or bumped bundler) is
// reported as a miss and overwritten. Survives across NpmCache instances
// sharing the same SQLite (the hibernation-survival property). Runs
// against real SQLite (bun:sqlite) through a minimal SqlStorage adapter.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';

class FakeSql {
  constructor(db) { this.db = db; }
  exec(query, ...params) {
    return this.db.query(query).all(...params);
  }
}

const db = new Database(':memory:');
const sql = new FakeSql(db);
const cache = new NpmCache(sql);

const PATH = 'home/user/projects/src/App.tsx';
const V = 'v7';

// Miss on empty table.
assert.equal(cache.getUserModuleTransform(PATH, 'hashA', V), null);

// Write then hit on matching (path, hash, version).
cache.putUserModuleTransform({
  vfsPath: PATH,
  contentHash: 'hashA',
  bundlerVersion: V,
  code: 'export default 1;',
  builtAt: 1,
});
const hit = cache.getUserModuleTransform(PATH, 'hashA', V);
assert.ok(hit, 'expected a hit for matching key');
assert.equal(hit.code, 'export default 1;');

// Content-hash mismatch (file edited, VFS event possibly missed) → miss.
assert.equal(cache.getUserModuleTransform(PATH, 'hashB', V), null,
  'changed content hash must miss');

// Bundler-version mismatch (transform logic bumped) → miss.
assert.equal(cache.getUserModuleTransform(PATH, 'hashA', 'v8'), null,
  'bumped bundler version must miss');

// Overwrite-in-place on the same path with new content.
cache.putUserModuleTransform({
  vfsPath: PATH,
  contentHash: 'hashB',
  bundlerVersion: V,
  code: 'export default 2;',
  builtAt: 2,
});
assert.equal(cache.getUserModuleTransform(PATH, 'hashA', V), null,
  'old hash no longer matches after overwrite');
assert.equal(cache.getUserModuleTransform(PATH, 'hashB', V).code, 'export default 2;');
assert.equal(cache.getStats().userModuleTransforms, 1, 'still one row (overwritten, not duplicated)');

// Delete (file removed) → miss.
cache.deleteUserModuleTransform(PATH);
assert.equal(cache.getUserModuleTransform(PATH, 'hashB', V), null);
assert.equal(cache.getStats().userModuleTransforms, 0);

// Hibernation-survival: a fresh NpmCache over the SAME sql still reads
// what an earlier instance wrote.
cache.putUserModuleTransform({
  vfsPath: PATH, contentHash: 'hashC', bundlerVersion: V, code: 'survives;', builtAt: 3,
});
const reopened = new NpmCache(sql);
const survived = reopened.getUserModuleTransform(PATH, 'hashC', V);
assert.ok(survived, 'transform must survive a new NpmCache instance (hibernation)');
assert.equal(survived.code, 'survives;');

console.log('npm-cache-user-transforms: ok');
