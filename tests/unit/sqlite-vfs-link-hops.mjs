#!/usr/bin/env bun
// Path lookup counts link hops, as Linux does (ELOOP after 40), and never
// refuses a link for being met twice: `loop -> .` resolved through twice is
// two hops and names the directory (GitParityLane's report; find -L, cp -rL
// and node_modules links of this shape depend on it). A true cycle still
// ends in ELOOP.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { processBridge } from './lib/process-bridge.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const fs = rawVfs.as(CRED_KERNEL);
fs.mkdir('w/d/sub/deep', { recursive: true });
fs.writeFile('w/d/sub/deep/h', 'here');
fs.symlink('.', 'w/d/sub/loop');

assert.equal(fs.stat('w/d/sub/loop').type, 'directory');
assert.equal(fs.stat('w/d/sub/loop/loop').type, 'directory', 'the same link twice is two hops');
assert.equal(fs.readFileString('w/d/sub/loop/loop/deep/h'), 'here');
assert.equal(fs.readFileString(`w/d/sub/${'loop/'.repeat(39)}deep/h`), 'here', '39 hops');
assert.throws(() => fs.stat(`w/d/sub/${'loop/'.repeat(41)}deep`), { code: 'ELOOP' }, 'more than 40 hops');

fs.symlink('b', 'w/a');
fs.symlink('a', 'w/b');
assert.throws(() => fs.stat('w/a'), { code: 'ELOOP' }, 'a true cycle');

// A process's bridge (node's fs, WASI) resolves the same way.
const bridge = processBridge(rawVfs, CRED_KERNEL);
assert.equal(new TextDecoder().decode(bridge.readFile('/w/d/sub/loop/loop/deep/h')), 'here');
assert.equal(bridge.realpath('/w/d/sub/loop/loop/deep'), '/w/d/sub/deep');

console.log('sqlite-vfs-link-hops: ok');
