#!/usr/bin/env bun
// One answer to "is this a Node builtin" for the launch's dependency walk,
// ES module staging and the process's require (audit RTM-3,
// runtime/node-builtins.ts): host Node's module.isBuiltin is the oracle for
// every builtin it lists, with and without `node:`, and the names it serves
// only with the scheme. And the walk follows what Node loads: an app whose
// node_modules holds a `constants` shadow (a builtin, which Node serves
// without reading it) and an npm `sqlite` (no builtin bare, which Node
// loads), as host Node runs the same files.
//
// Red before: the walk kept its own list, which lacked `constants` and held
// bare `sqlite`, so it walked (and charged, past its bound) the shadow and
// skipped the package.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isNodeBuiltin } from '../../packages/core/src/runtime/node-builtins.ts';
import { prefetchForRequire } from '../../packages/core/src/runtime/require-resolver.ts';
import { FakeVfs } from './lib/fake-require-fs.mjs';

// ── module.isBuiltin, name by name ─────────────────────────────────────────
const asked = spawnSync('node', ['-e', `
  const { builtinModules, isBuiltin } = require('node:module');
  const names = [...builtinModules, 'sea', 'sqlite', 'test', 'test/reporters', 'constants', 'sys', 'undici', 'nope', 'fs/nope'];
  const specifiers = [...names, ...names.map((name) => 'node:' + name)];
  console.log(JSON.stringify(specifiers.map((specifier) => [specifier, isBuiltin(specifier)])));
`], { encoding: 'utf8' });
assert.equal(asked.status, 0, asked.stderr);
const oracle = JSON.parse(asked.stdout);
assert.ok(oracle.length > 140, 'host Node lists its builtins');
assert.deepEqual(oracle.map(([specifier]) => [specifier, isNodeBuiltin(specifier)]), oracle, "isNodeBuiltin is Node's module.isBuiltin");

// ── The walk follows what Node loads ───────────────────────────────────────
const BOUND = 1000;
const APP = 'home/user/app';
const FILES = {
  [`${APP}/main.cjs`]: "console.log(JSON.stringify([typeof require('constants').O_RDONLY, require('sqlite')]));\n",
  [`${APP}/node_modules/constants/package.json`]: '{"name":"constants","main":"index.js"}',
  [`${APP}/node_modules/constants/index.js`]: `module.exports = ${JSON.stringify('x'.repeat(BOUND * 2))};\n`,
  [`${APP}/node_modules/sqlite/package.json`]: '{"name":"sqlite","main":"index.js"}',
  [`${APP}/node_modules/sqlite/index.js`]: "module.exports = 'npm sqlite';\n",
};
const host = mkdtempSync(join(tmpdir(), 'builtin-identity-'));
try {
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(host, path)), { recursive: true });
    writeFileSync(join(host, path), text);
  }
  const ran = spawnSync('node', [join(host, APP, 'main.cjs')], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), ['number', 'npm sqlite'], 'host Node serves constants itself and loads the npm sqlite');
} finally {
  rmSync(host, { recursive: true, force: true });
}
const entry = `${APP}/main.cjs`;
const outcome = await prefetchForRequire(new FakeVfs(FILES), FILES[entry], APP, entry, BOUND);
assert.notEqual(outcome.kind, 'closure-exceeds-bound', `the walk charged the constants shadow: ${JSON.stringify(outcome)}`);
assert.equal(`${APP}/node_modules/constants/index.js` in outcome.bundle, false, 'the walk leaves the shadow Node never reads');
assert.equal(outcome.bundle[`${APP}/node_modules/sqlite/index.js`], FILES[`${APP}/node_modules/sqlite/index.js`], 'and ships the sqlite package Node loads');
console.log(`ok - builtin-identity (${oracle.length} specifiers as module.isBuiltin answers; the walk follows what Node loads)`);
