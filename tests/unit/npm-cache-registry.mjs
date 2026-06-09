#!/usr/bin/env bun
// npm-cache-registry — the registry cache must persist ABI-relevant
// metadata (platform constraints + optionalDependencies) and upgrade
// pre-existing tables in place. Runs against real SQLite (bun:sqlite)
// through a minimal SqlStorage-shaped adapter.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';

/** Minimal SqlStorage-shaped adapter over bun:sqlite. */
class FakeSql {
  constructor(db) { this.db = db; }
  exec(query, ...params) {
    return this.db.query(query).all(...params);
  }
}

const entryFixture = {
  name: 'opencode-linux-x64',
  version: '1.16.2',
  tarballUrl: 'https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.16.2.tgz',
  integrity: 'sha512-abc',
  depsJson: '{}',
  peerDepsJson: '{}',
  exportsJson: 'null',
  main: '',
  moduleField: '',
  binJson: '{}',
  platformJson: JSON.stringify({ os: ['linux'], cpu: ['x64'] }),
  optionalDepsJson: JSON.stringify({ fsevents: '^2.0.0' }),
  fetchedAt: 1700000000000,
};

// ── Fresh schema: platform/optional-deps metadata round-trips ──────────

{
  const cache = new NpmCache(new FakeSql(new Database(':memory:')));
  cache.putRegistryEntry(entryFixture);

  const got = cache.getRegistryEntry('opencode-linux-x64', '1.16.2');
  assert.ok(got);
  assert.deepEqual(JSON.parse(got.platformJson), { os: ['linux'], cpu: ['x64'] });
  assert.deepEqual(JSON.parse(got.optionalDepsJson), { fsevents: '^2.0.0' });

  const versions = cache.getRegistryVersions('opencode-linux-x64');
  assert.equal(versions.length, 1);
  assert.deepEqual(JSON.parse(versions[0].platformJson), { os: ['linux'], cpu: ['x64'] });

  const dumped = cache.dumpRegistryEntries(10);
  assert.equal(dumped.length, 1);
  assert.deepEqual(JSON.parse(dumped[0].optionalDepsJson), { fsevents: '^2.0.0' });
}

// ── Pre-existing table: columns are added, old rows read as misses ─────

{
  const db = new Database(':memory:');
  // The original pre-X.5-F table shape (no peer_deps_json, no
  // platform_json, no optional_deps_json).
  db.query(`CREATE TABLE pkg_registry_cache (
    name           TEXT NOT NULL,
    version        TEXT NOT NULL,
    tarball_url    TEXT NOT NULL,
    integrity      TEXT NOT NULL DEFAULT '',
    deps_json      TEXT NOT NULL DEFAULT '{}',
    exports_json   TEXT NOT NULL DEFAULT '{}',
    main           TEXT NOT NULL DEFAULT '',
    module_field   TEXT NOT NULL DEFAULT '',
    bin_json       TEXT NOT NULL DEFAULT '{}',
    fetched_at     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (name, version)
  )`).run();
  db.query(`INSERT INTO pkg_registry_cache
    (name, version, tarball_url, integrity, deps_json, exports_json, main, module_field, bin_json, fetched_at)
    VALUES ('left-pad', '1.3.0', 'https://example.invalid/left-pad.tgz', 'sha512-old', '{}', 'null', 'index.js', '', '{}', 1600000000000)
  `).run();

  const cache = new NpmCache(new FakeSql(db));
  const old = cache.getRegistryEntry('left-pad', '1.3.0');
  assert.ok(old, 'pre-migration row must still read');
  assert.equal(old.platformJson, '{}', 'pre-migration rows read as metadata misses');
  assert.equal(old.optionalDepsJson, '{}');
  assert.equal(old.peerDepsJson, '{}');

  // New writes land in the upgraded table.
  cache.putRegistryEntry(entryFixture);
  const got = cache.getRegistryEntry('opencode-linux-x64', '1.16.2');
  assert.deepEqual(JSON.parse(got.platformJson), { os: ['linux'], cpu: ['x64'] });

  const { written, failed } = cache.putRegistryEntries([
    { ...entryFixture, version: '1.16.3' },
    { ...entryFixture, name: 'left-pad', version: '1.3.1', platformJson: '{}', optionalDepsJson: '{}' },
  ]);
  assert.equal(written, 2);
  assert.equal(failed, 0);
  assert.equal(cache.getRegistryVersions('opencode-linux-x64').length, 2);
}

console.log('npm-cache-registry: ok');
