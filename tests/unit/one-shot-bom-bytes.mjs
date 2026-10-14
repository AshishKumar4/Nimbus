#!/usr/bin/env bun
// A file that opens with a UTF-8 byte order mark reads back as its bytes,
// the mark included, however the launch staged it: a working-tree data file
// (the project snapshot), a required CommonJS module read as data (the
// module walk's cell, read back from its module), a required JSON file and an
// installed package's package.json. Node's synchronous and asynchronous reads
// both return every byte, while require() of the JSON and the package's
// resolution through its package.json skip the mark, as Node's parsers do.
//
// One fixture tree, on disk for real node and in the session's filesystem for
// a one-shot `node` run through the real launch path; the outputs must be
// Node's. The staged snapshot used to decode each file with TextDecoder's
// default, which drops a leading mark: EF BB BF 68 69 read back as two bytes
// from readFileSync and five from the live file.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const ROOT = '/home/user/bom';
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const text = (body) => new TextEncoder().encode(body);
const marked = (body) => new Uint8Array([...BOM, ...text(body)]);
const READ = ['data.txt', 'lib.cjs', 'conf.json', 'esm.mjs', 'node_modules/bompkg/package.json'];
const MAIN = `const fs = require('fs');
const path = require('path');
const hex = (name) => fs.readFileSync(path.join(__dirname, name)).toString('hex');
// Every synchronous read first: an asynchronous read of a file refreshes what the process holds of it.
const sync = Object.fromEntries(${JSON.stringify(READ)}.map((name) => [name, hex(name)]));
(async () => {
  const esm = await import('./esm.mjs');
  const live = await fs.promises.readFile(path.join(__dirname, 'data.txt'));
  console.log(JSON.stringify({
    lib: require('./lib.cjs'),
    conf: require('./conf.json').a,
    pkg: require('bompkg'),
    esm: esm.default,
    sync,
    live: live.toString('hex'),
  }));
})();
`;
const files = {
  'main.cjs': text(MAIN),
  'data.txt': marked('hi'),
  'lib.cjs': marked("module.exports = 'lib';\n"),
  'conf.json': marked('{"a":1}\n'),
  'esm.mjs': marked("export default 'esm';\n"),
  'node_modules/bompkg/package.json': marked(JSON.stringify({ name: 'bompkg', version: '1.0.0', main: 'main.js' })),
  'node_modules/bompkg/main.js': text("module.exports = 'bompkg';\n"),
};

// ── real node ────────────────────────────────────────────────────────────
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'one-shot-bom-bytes-')));
let expected;
try {
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, rel)), { recursive: true });
    writeFileSync(join(disk, rel), bytes);
  }
  const node = spawnSync('node', ['--no-warnings', 'main.cjs'], { cwd: disk, encoding: 'utf8' });
  assert.equal(node.status, 0, `node main.cjs: ${node.stderr}`);
  expected = JSON.parse(node.stdout.trim().split('\n').at(-1));
} finally {
  rmSync(disk, { recursive: true, force: true });
}
assert.equal(expected.sync['data.txt'], 'efbbbf6869', 'premise: node reads the mark synchronously');
assert.equal(expected.live, 'efbbbf6869', 'premise: node reads the mark asynchronously');
assert.deepEqual([expected.lib, expected.conf, expected.pkg, expected.esm], ['lib', 1, 'bompkg', 'esm'], 'premise: node loads each marked file');

// ── one-shot node in the session ─────────────────────────────────────────
const { host, rawVfs, kfs } = createAuthority();
let out = '';
adoptSessionSupervisor(host, (chunk) => { out += chunk; });
const manager = oneShotManager('one-shot-bom-bytes', { host, rawVfs, loader: runnerLoader('bom-bytes') });
const { oxcTransforms } = await import('./lib/oxc-engine.mjs');
manager.setEsbuildService(new EsbuildService(undefined, oxcTransforms));
for (const [rel, bytes] of Object.entries(files)) {
  const path = `${ROOT.slice(1)}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, bytes);
}

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
let result;
try {
  result = await manager.exec(MAIN, { filename: `${ROOT}/main.cjs`, dirname: ROOT, cwd: ROOT, captureOutput: true });
} finally { Object.assign(globalThis, real); }
const printed = (out + result.stdout).trim().split('\n').at(-1) ?? '';
assert.equal(result.exitCode, 0, `node main.cjs: ${result.stderr}${out}`);
assert.ok(printed.startsWith('{'), `node main.cjs printed no report: ${result.stderr}${out}`);
assert.deepEqual(JSON.parse(printed), expected, 'every marked file reads back as node reads it');

console.log(`one-shot-bom-bytes: ${READ.length} marked files read back with their byte order mark, as node reads them`);
