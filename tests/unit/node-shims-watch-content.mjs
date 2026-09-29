#!/usr/bin/env bun
// fs.watch must observe mutations, not the identity of a buffer returned by
// the resident store. A new Uint8Array of unchanged bytes on every read used
// to restart Vite/Astro every 500 ms (config and tsconfig falsely changed).
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
let bytes = new Uint8Array([1, 2, 3]);
const bundle = new Proxy({}, {
  has(_target, key) { return key === 'home/user/file.bin' && bytes !== null; },
  get(_target, key) { return key === 'home/user/file.bin' && bytes !== null ? bytes.slice() : undefined; },
});
const ticks = [];
const fs = new Function('__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', 'setInterval', 'clearInterval',
  '"use strict";' + generateShimsCode() + '\nreturn builtins.fs;')(
  bundle, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.js', '/home/user',
  (callback) => { ticks.push(callback); return ticks.length; }, () => {},
);
const events = [];
const watcher = fs.watch('/home/user/file.bin', (...args) => events.push(args));
for (let n = 0; n < 3; n++) ticks[0]();
assert.deepEqual(events, [], 'fresh buffers with identical bytes are not file changes');
bytes[0] = 9;
ticks[0]();
ticks[0]();
assert.deepEqual(events, [['change', 'file.bin']], 'a content edit is observed once');
bytes = null;
ticks[0]();
assert.deepEqual(events[1], ['rename', 'file.bin'], 'deletion is a rename event');
watcher.close();
bytes = new Uint8Array([4]);
ticks[0]();
assert.equal(events.length, 2, 'a closed watcher observes nothing');
console.log('node-shims-watch-content: ok');
