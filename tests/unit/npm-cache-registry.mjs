#!/usr/bin/env bun
// npm-cache-registry — the registry cache must persist ABI-relevant
// metadata (platform constraints + optionalDependencies) and upgrade
// pre-existing tables in place. Runs against real SQLite (bun:sqlite)
// through a minimal SqlStorage-shaped adapter.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const entryFixture = {
  name: 'opencode-linux-x64',
  version: '1.16.2',
  tarballUrl: 'https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.16.2.tgz',
  integrity: 'sha512-abc',
  depsJson: '{}',
  peerDepsJson: '{}',
  main: '',
  binJson: '{}',
  platformJson: JSON.stringify({ os: ['linux'], cpu: ['x64'] }),
  optionalDepsJson: JSON.stringify({ fsevents: '^2.0.0' }),
};

const SOURCE = { registry: 'https://registry.npmjs.org', network: '' };

// ── Fresh schema: platform/optional-deps metadata round-trips ──────────

{
  const cache = new NpmCache(createSqliteVfsTestHarness().sql);
  assert.deepEqual(cache.putRegistryEntries(SOURCE, [entryFixture]), { written: 1, failed: 0 });

  const got = cache.getRegistryEntry(SOURCE, 'opencode-linux-x64', '1.16.2');
  assert.ok(got);
  assert.deepEqual(JSON.parse(got.platformJson), { os: ['linux'], cpu: ['x64'] });
  assert.deepEqual(JSON.parse(got.optionalDepsJson), { fsevents: '^2.0.0' });

  const read = cache.getRegistryEntries(SOURCE, [['opencode-linux-x64', '1.16.2']]).get('opencode-linux-x64@1.16.2');
  assert.deepEqual(JSON.parse(read.platformJson), { os: ['linux'], cpu: ['x64'] });
  assert.deepEqual(JSON.parse(read.optionalDepsJson), { fsevents: '^2.0.0' });
}

// ── A table from before records kept their registry: its rows are no registry's, and it goes ──

{
  const db = new Database(':memory:');
  // The original pre-X.5-F table shape (no peer_deps_json, no
  // platform_json, no optional_deps_json), keyed by name@version alone.
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

  const cache = new NpmCache(createSqliteVfsTestHarness(db).sql);
  assert.equal(cache.getRegistryEntry(SOURCE, 'left-pad', '1.3.0'), null, 'a row of no known registry answered');
  assert.equal(db.query(`SELECT name FROM sqlite_master WHERE name = 'pkg_registry_cache'`).all().length, 0, 'the old table stayed');

  const { written, failed } = cache.putRegistryEntries(SOURCE, [
    { ...entryFixture, version: '1.16.3' },
    { ...entryFixture, name: 'left-pad', version: '1.3.1', platformJson: '{}', optionalDepsJson: '{}' },
  ]);
  assert.equal(written, 2);
  assert.equal(failed, 0);
  assert.equal(cache.getRegistryEntry(SOURCE, 'left-pad', '1.3.1')?.version, '1.3.1');
}

console.log('npm-cache-registry: ok');
