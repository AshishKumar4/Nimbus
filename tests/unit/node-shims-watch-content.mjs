#!/usr/bin/env bun
// fs.watch must observe mutations, not the identity of a buffer returned by
// the resident store. A new Uint8Array of unchanged bytes on every read used
// to restart Vite/Astro every 500 ms (config and tsconfig falsely changed).
import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

// The poll's interval is the test's: each tick takes the barrier a resumed
// timer takes (the filesystem's catchUp), then runs every poll.
const TIMERS = 'const __timers = new Map(); let __nextTimer = 1;'
  + ' const setInterval = (callback) => { const id = __nextTimer++; __timers.set(id, callback); return id; };'
  + ' const clearInterval = (id) => { __timers.delete(id); };';

// The write's mtime and ctime are the clock's: a second write waits out the clock's tick.
const rawSetTimeout = globalThis.setTimeout;
const later = () => new Promise((resolve) => rawSetTimeout(resolve, 5));

const authority = createAuthority();
authority.kfs.writeFile('home/user/file.bin', new Uint8Array([1, 2, 3]));
const { fs, rf, timers } = sessionShims(authority, {
  cwd: '/home/user',
  head: TIMERS,
  tail: ';return { fs: builtins.fs, timers: __timers };',
});
const tick = async () => {
  await rf.catchUp();
  for (const callback of [...timers.values()]) callback();
};

const events = [];
const watcher = fs.watch('/home/user/file.bin', (...args) => events.push(args));
for (let n = 0; n < 3; n++) await tick();
assert.deepEqual(events, [], 'fresh buffers with identical bytes are not file changes');
await later();
authority.peer.writeFile('home/user/file.bin', new Uint8Array([9, 2, 3]));
await tick();
await tick();
assert.deepEqual(events, [['change', 'file.bin']], 'a content edit is observed once');
authority.peer.unlink('home/user/file.bin');
await tick();
assert.deepEqual(events[1], ['rename', 'file.bin'], 'deletion is a rename event');
watcher.close();
authority.peer.writeFile('home/user/file.bin', new Uint8Array([4]));
await tick();
assert.equal(events.length, 2, 'a closed watcher observes nothing');

// A namespace rebuild is not a switch to a second filesystem. Watchers must
// keep the last authoritative snapshot while the namespace is unavailable.
const rebuild = createAuthority();
rebuild.kfs.writeFile('home/user/config.js', 'export default {};');
const namespace = sessionShims(rebuild, {
  cwd: '/home/user',
  head: TIMERS,
  tail: ';return { fs: builtins.fs, timers: __timers, ready: (value) => __resident.namespace.markReady(__resident.coherence.tables("test"), value) };',
});
const namespaceEvents = [];
const namespaceWatcher = namespace.fs.watch('/home/user/config.js', (...args) => namespaceEvents.push(args));
const rebuildTick = async () => {
  await namespace.rf.catchUp();
  for (const callback of [...namespace.timers.values()]) callback();
};
namespace.ready(false);
for (const callback of [...namespace.timers.values()]) callback();
namespace.ready(true);
await rebuildTick();
assert.deepEqual(namespaceEvents, [], 'rebuilding unchanged metadata is not a config edit');
await rebuildTick();
assert.deepEqual(namespaceEvents, [], 'a fresh listing revision without an inode mutation is not a config edit');
namespace.ready(false);
await later();
rebuild.peer.writeFile('home/user/config.js', 'export default { changed: 1 };');
for (const callback of [...namespace.timers.values()]) callback();
namespace.ready(true);
await rebuildTick();
assert.deepEqual(namespaceEvents, [['change', 'config.js']], 'an actual edit during the rebuild is delivered once after recovery');
namespaceWatcher.close();
console.log('node-shims-watch-content: ok');
