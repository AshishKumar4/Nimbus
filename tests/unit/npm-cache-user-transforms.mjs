#!/usr/bin/env bun
// npm-cache-user-transforms — the user_module_transforms cache must be
// content-addressed AND base-keyed: a hit requires the content hash, bundler
// version, AND mount base to match, so a stale row (changed file or bumped
// bundler) is a miss, and the same source served under two mount bases keeps
// two rows (the transform bakes the base). Survives across NpmCache instances
// sharing the same SQLite (the hibernation-survival property). Runs against
// real SQLite (bun:sqlite) through a minimal SqlStorage adapter.

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
const BASE = '/s/nimble-otter-4271/preview';
const ROOT = ''; // the `<port>--<sid>` host mount
const V = 'v8';

// Miss on empty table.
assert.equal(cache.getUserModuleTransform(PATH, BASE, 'hashA', V), null);

// Write then hit on matching (path, base, hash, version).
cache.putUserModuleTransform({
  vfsPath: PATH,
  base: BASE,
  contentHash: 'hashA',
  bundlerVersion: V,
  code: 'export default 1;',
  builtAt: 1,
});
const hit = cache.getUserModuleTransform(PATH, BASE, 'hashA', V);
assert.ok(hit, 'expected a hit for matching key');
assert.equal(hit.code, 'export default 1;');

// Content-hash mismatch (file edited, VFS event possibly missed) → miss.
assert.equal(cache.getUserModuleTransform(PATH, BASE, 'hashB', V), null,
  'changed content hash must miss');

// Bundler-version mismatch (transform logic bumped) → miss.
assert.equal(cache.getUserModuleTransform(PATH, BASE, 'hashA', 'v9'), null,
  'bumped bundler version must miss');

// Base mismatch: the SAME source under a different mount base is a separate
// transform, not a hit — the served text bakes the base.
assert.equal(cache.getUserModuleTransform(PATH, ROOT, 'hashA', V), null,
  'a different mount base must miss');
cache.putUserModuleTransform({
  vfsPath: PATH, base: ROOT, contentHash: 'hashA', bundlerVersion: V,
  code: 'export default 1; // root', builtAt: 1,
});
assert.equal(cache.getUserModuleTransform(PATH, ROOT, 'hashA', V).code, 'export default 1; // root');
assert.equal(cache.getUserModuleTransform(PATH, BASE, 'hashA', V).code, 'export default 1;',
  'the two bases keep independent rows');
assert.equal(cache.getStats().userModuleTransforms, 2, 'two bases → two rows');

// Overwrite-in-place on the same (path, base) with new content.
cache.putUserModuleTransform({
  vfsPath: PATH,
  base: BASE,
  contentHash: 'hashB',
  bundlerVersion: V,
  code: 'export default 2;',
  builtAt: 2,
});
assert.equal(cache.getUserModuleTransform(PATH, BASE, 'hashA', V), null,
  'old hash no longer matches after overwrite');
assert.equal(cache.getUserModuleTransform(PATH, BASE, 'hashB', V).code, 'export default 2;');
assert.equal(cache.getStats().userModuleTransforms, 2, 'still two rows (overwritten in place, not duplicated)');

// Delete (file removed) → clears EVERY base for that path.
cache.deleteUserModuleTransform(PATH);
assert.equal(cache.getUserModuleTransform(PATH, BASE, 'hashB', V), null);
assert.equal(cache.getUserModuleTransform(PATH, ROOT, 'hashA', V), null);
assert.equal(cache.getStats().userModuleTransforms, 0);

// Hibernation-survival: a fresh NpmCache over the SAME sql still reads
// what an earlier instance wrote.
cache.putUserModuleTransform({
  vfsPath: PATH, base: BASE, contentHash: 'hashC', bundlerVersion: V, code: 'survives;', builtAt: 3,
});
const reopened = new NpmCache(sql);
const survived = reopened.getUserModuleTransform(PATH, BASE, 'hashC', V);
assert.ok(survived, 'transform must survive a new NpmCache instance (hibernation)');
assert.equal(survived.code, 'survives;');

console.log('npm-cache-user-transforms: ok');
