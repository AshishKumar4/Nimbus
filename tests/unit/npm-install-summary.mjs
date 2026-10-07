#!/usr/bin/env bun
// The install summary every install path prints (the lifo npm, its install
// port, the hosted npm-fast) is one renderer. npm-fast had its own copy,
// which printed `added 0 packages (0 files)` for an install that changed
// nothing, where npm (and the lifo path) print `up to date in Xs`.
import assert from 'node:assert/strict';
import { installSummary } from '../../packages/core/src/substrate/lifo/commands/system/npm-log.ts';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

assert.deepEqual(installSummary({ installed: 0, failed: [], elapsedMs: 1234 }), { stdout: '\x1b[32mup to date in 1.2s\x1b[0m\n', stderr: '' });

const full = installSummary({ installed: 3, failed: [], elapsedMs: 2000, totalFiles: 40, fromCacheHits: 2, linkedBins: 1, globalBinDir: '/usr/local/bin' });
assert.equal(full.stderr, '');
assert.equal(plain(full.stdout), '\nadded 3 packages (40 files) in 2.0s\n  (2 from cache)\n  linked 1 bin into /usr/local/bin\n');
assert.match(full.stdout, /^\n\x1b\[32madded/, 'a complete install is green');

const partial = installSummary({ installed: 1, failed: ['a', 'b'], elapsedMs: 500, totalFiles: 3 });
assert.equal(partial.stderr, '\x1b[31mFailed: a, b\x1b[0m\n');
assert.equal(plain(partial.stdout), '\nadded 1 packages (3 files) in 0.5s (2 failed, see above)\n');
assert.match(partial.stdout, /^\n\x1b\[33madded/, 'a partial install is yellow');

assert.deepEqual(installSummary({ installed: 0, failed: ['x'], elapsedMs: 100 }), { stdout: '', stderr: '\x1b[31mFailed: x\x1b[0m\n' });

console.log('npm-install-summary: ok');
