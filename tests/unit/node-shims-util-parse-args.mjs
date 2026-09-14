#!/usr/bin/env bun
// node-shims-util-parse-args — util.parseArgs, Node 18.3+.
//
// json-server@1.0.0-beta.15's bin destructures `parseArgs` from `node:util`
// at module init; once its dependencies actually installed (chokidar was
// being dropped by the resolver), the next thing the bin hit was
// "parseArgs is not a function". This pins Node's contract for the shapes
// CLIs use: long/short/inline/grouped options, defaults, multiple, `--`,
// allowNegative, strict errors with Node's error codes, and lax mode.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + generateShimsCode() + '\n;return __utilMod;',
);
const util = factory(
  {}, {}, {}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', ['/home/user/main.mjs', '--from-argv'], {}, '/home/user/main.mjs', '/home/user',
);
assert.equal(typeof util.parseArgs, 'function');

// json-server's own option table and a typical invocation.
const jsonServer = {
  port: { type: 'string', short: 'p', default: '3000' },
  host: { type: 'string', short: 'h', default: 'localhost' },
  static: { type: 'string', short: 's', multiple: true, default: [] },
  help: { type: 'boolean' },
  version: { type: 'boolean' },
};
assert.deepEqual(
  util.parseArgs({ args: ['--version'], options: jsonServer, allowPositionals: true }),
  { values: { port: '3000', host: 'localhost', static: [], version: true }, positionals: [] },
);
assert.deepEqual(
  util.parseArgs({ args: ['-p', '4000', '--host=0.0.0.0', '-s', 'public', '-s', 'assets', 'db.json'], options: jsonServer, allowPositionals: true }),
  { values: { port: '4000', host: '0.0.0.0', static: ['public', 'assets'] }, positionals: ['db.json'] },
);

// Short inline value, grouped boolean shorts, `--` terminator, allowNegative.
const opts = { verbose: { type: 'boolean', short: 'v' }, force: { type: 'boolean', short: 'f' }, out: { type: 'string', short: 'o' }, color: { type: 'boolean' } };
assert.deepEqual(util.parseArgs({ args: ['-vf', '-odist', '--', '--not-an-option', 'x'], options: opts, allowPositionals: true }),
  { values: { verbose: true, force: true, out: 'dist' }, positionals: ['--not-an-option', 'x'] });
assert.deepEqual(util.parseArgs({ args: ['--no-color'], options: opts, allowNegative: true }), { values: { color: false }, positionals: [] });

// Strict mode: Node's error codes.
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
assert.equal(codeOf(() => util.parseArgs({ args: ['--nope'], options: opts })), 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
assert.equal(codeOf(() => util.parseArgs({ args: ['--out'], options: opts })), 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
assert.equal(codeOf(() => util.parseArgs({ args: ['--out', '--verbose'], options: opts })), 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
assert.equal(codeOf(() => util.parseArgs({ args: ['file'], options: opts })), 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL');
assert.equal(codeOf(() => util.parseArgs({ args: ['--verbose=yes'], options: opts })), 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
assert.equal(codeOf(() => util.parseArgs({ args: [], options: { bad: { type: 'number' } } })), 'ERR_INVALID_ARG_TYPE');

// Lax mode: unknown options are recorded, positionals allowed by default.
assert.deepEqual(util.parseArgs({ args: ['--unknown', 'pos', '--k=v'], strict: false }),
  { values: { unknown: true, k: 'v' }, positionals: ['pos'] });

// No args given: process.argv past the script.
assert.deepEqual(util.parseArgs({ strict: false }), { values: { 'from-argv': true }, positionals: [] });

console.log('node-shims-util-parse-args: ok');
