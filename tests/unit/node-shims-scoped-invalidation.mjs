#!/usr/bin/env bun
// A Node process's heap cells follow the delta entries that cover a subtree.
//
// An ACQUIRE delta reports a directory that went, or whose mode, owner or
// group changed, as `structural`, and a change beneath a directory the
// process may not see as that directory, `subtree`-scoped. Neither names the
// cells under it, so a reader that evicted only named paths kept serving
// them: the files of a directory made private, and of one made private and
// then removed. The shims now evict every cell at or under such an entry, and
// a synchronous read there no longer returns the old bytes.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

// The process reads as READER; the files are the session user's (OWNER), which
// makes changes through authority.peer.
const READER = Object.freeze({ uid: 5001, gid: 5001, groups: Object.freeze([5001]), umask: 0o022 });
const DIRS = ['d', 'g', 'k'];
const authority = createAuthority();
for (const dir of DIRS) {
  authority.kfs.mkdir(`/home/user/${dir}`);
  authority.kfs.writeFile(`/home/user/${dir}/f.txt`, `${dir} v1`);
}
// The launch stages the bytes it holds of each file.
const bundle = Object.fromEntries(DIRS.map((dir) => [`home/user/${dir}/f.txt`, `${dir} v1`]));
const { fs, setTimeout: later } = shimsOnSession({ authority, cred: READER, bundle });

/** A synchronous read inside a timer callback, after the barrier it runs behind. */
const readInTimer = (path) => new Promise((resolve) => {
  later(() => {
    try {
      resolve(fs.readFileSync(path, 'utf8'));
    } catch (error) {
      resolve(error.code);
    }
  }, 1);
});

// The first barrier establishes the cursor, and each async read installs its
// cell at it, so a later synchronous read is served from the heap.
for (const dir of DIRS) {
  assert.equal(await fs.promises.readFile(`/home/user/${dir}/f.txt`, 'utf8'), `${dir} v1`);
}
for (const dir of DIRS) assert.equal(await readInTimer(`/home/user/${dir}/f.txt`), `${dir} v1`);

// ── A directory made private: its cells go ───────────────────────────────
await authority.peer.chmod('/home/user/d', 0o700);
assert.notEqual(await readInTimer('/home/user/d/f.txt'), 'd v1', 'a cell under a directory the process was locked out of was served');

// ── Made private, then removed ────────────────────────────────────────────
await authority.peer.chmod('/home/user/g', 0o700);
await authority.peer.removeRecursive('/home/user/g');
assert.notEqual(await readInTimer('/home/user/g/f.txt'), 'g v1', 'a cell for a removed file was served');

// ── An untouched directory keeps its cells ────────────────────────────────
assert.equal(await readInTimer('/home/user/k/f.txt'), 'k v1');

console.log('node-shims-scoped-invalidation: ok');
