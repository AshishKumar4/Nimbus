// The names an ES module may import from 'undici' (core runtime/undici-shim.ts
// UNDICI_SHIM_EXPORTS, which its facade is staged with) are the shim
// module's own keys beside `default`: evaluated here with the stream and
// events modules its block reads.

import assert from 'node:assert/strict';
import events from 'node:events';
import { pipeline, Readable } from 'node:stream';
import { generateUndiciShimCode, UNDICI_SHIM_EXPORTS } from '../../packages/core/src/runtime/undici-shim.ts';

const mod = new Function('__streamMod', '__eventsMod', 'env', `${generateUndiciShimCode()}\nreturn __undiciMod;`)({ Readable, pipeline }, events, {});
assert.deepEqual([...UNDICI_SHIM_EXPORTS], Object.keys(mod).filter((name) => name !== 'default').sort(), "the list is the shim module's keys");
assert.equal(mod.default, mod, 'its default is itself');
console.log(`undici-shim-exports: ${UNDICI_SHIM_EXPORTS.length} names, the shim's own`);
