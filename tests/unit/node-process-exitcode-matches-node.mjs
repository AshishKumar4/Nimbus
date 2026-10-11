// process.exitCode as Node 22.22.3 keeps it (lib/internal/bootstrap/node.js:
// a non-empty string is its Number() unless that is NaN, then
// validateInteger: a number, an integer, a safe one; stored as int32; null
// and undefined unset it), against host Node for every kind of value: the
// code it reads back, or the error's code and message. Before, a string was
// taken whenever it was integral, its range unchecked
// ('9007199254740992' read 0, Node throws ERR_OUT_OF_RANGE), and '1.5' threw
// ERR_INVALID_ARG_TYPE where Node says it must be an integer.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

const VALUES = `[
  '9007199254740992', '1.5', 'abc', '3', ' 4', '0x10', '1e3', '', '-0', '-5', 'Infinity', '4294967297', '-9007199254740992',
  1.5, 2 ** 53, -(2 ** 53), 9007199254740991, 4294967297, -1, 0, -0, NaN, Infinity, true, null, undefined, 7n, {}, [], Symbol('s'),
]`;
const PROBE = `
const out = [];
for (const value of ${VALUES}) {
  try {
    process.exitCode = value;
    out.push(['ok', process.exitCode === undefined ? 'undefined' : Object.is(process.exitCode, -0) ? '-0' : process.exitCode]);
  } catch (e) {
    out.push([e.code, e.message, e.name]);
  }
  process.exitCode = undefined;
}
return out;
`;
const ran = spawnSync('node', ['-e', `console.log(JSON.stringify((() => { ${PROBE} })()))`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
assert.equal(ran.status, 0, ran.stderr);
const want = JSON.parse(ran.stdout);

const process_ = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return __processMod;',
)({}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user');
const got = new Function('process', PROBE)(process_);
const values = new Function(`return ${VALUES}`)();
for (let i = 0; i < want.length; i++) {
  assert.deepEqual(got[i], want[i], `process.exitCode = ${typeof values[i] === 'string' ? JSON.stringify(values[i]) : String(values[i])}`);
}
console.log(`node-process-exitcode-matches-node: ${want.length} values as Node takes them`);
