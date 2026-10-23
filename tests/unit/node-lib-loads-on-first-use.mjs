// Node's library loads in parts, each the first time a program needs it
// (node-lib-module.ts): formatting a value, as an uncaught error's report and
// console.log of an object do, compiles nimbus/node-lib.js alone, which
// carries what util.inspect runs; util and the rest of Node's modules load
// nimbus/node-lib-rest.js on their first require. A launch is a module map
// the shims require from, so the standalone shims here record each module
// as they require it (lib/shims-namespace.mjs). What inspect prints is
// Node's: an object formats as host Node formats it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { RUNTIME_NODE_LIB_MODULE, RUNTIME_NODE_LIB_REST_MODULE } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { SHIMS_STORE_PRELUDE, SHIMS_STORE_START } from './lib/shims-namespace.mjs';

const VALUE = '({ probe: [1, 2, { a: 3, nested: { deeper: new Map([[1, "one"]]) } }], when: null })';
const host = spawnSync('node', ['-e', `console.log(require('util').inspect(${VALUE}))`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
assert.equal(host.status, 0, host.stderr);

const shims = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + SHIMS_STORE_PRELUDE + generateShimsCode() + SHIMS_STORE_START + '\n;return { inspect: __nimbusInspect, builtins, loaded: __nimbusTestNodeLibLoaded };',
)({}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user');
const loaded = () => [...shims.loaded.keys()];

assert.deepEqual(loaded(), [], 'the shims load none of Node\'s library until a program needs it');
assert.equal(shims.inspect(new Function(`return ${VALUE}`)()), host.stdout.trimEnd(), 'an object formats as Node formats it');
assert.match(shims.inspect(new RangeError('probe')), /^RangeError: probe\n/);
assert.deepEqual(loaded(), [RUNTIME_NODE_LIB_MODULE], 'formatting a value and an error loads Node\'s library\'s own module alone');
assert.equal(typeof shims.builtins.util.inspect, 'function');
assert.deepEqual(loaded(), [RUNTIME_NODE_LIB_MODULE, RUNTIME_NODE_LIB_REST_MODULE], 'util loads the rest of Node\'s modules, as one module');
console.log('node-lib-loads-on-first-use: formatting loads node-lib.js alone, util the rest');
