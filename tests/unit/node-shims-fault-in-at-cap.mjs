#!/usr/bin/env bun
// A synchronous read's fault-in lands in a store that is at its budget.
//
// A process facet's store has a storage cap the session's ledger grants, and
// a big launch fills it: nuxt dev's store sat at 23.71 of 23.72 MB. A fill
// that does not fit was refused, and only then was room asked for, without
// waiting. A synchronous read's fault-in fetches once (_faultOnce), so its
// bytes were declined and never fetched again: every late module stayed
// unreadable ("store refused cap=23720160 db=23715840", traced live on a
// throwaway, nuxt-real), and nuxt dev never served.
//
// A fault-in can wait, so it asks for the room first. And concurrent asks
// each get theirs: a caller that waited on another's ask asks again if that
// grant did not cover it, where it used to give up.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

// The raw timer: the ledger's latency is its own, not a resumption of the program.
const rawSetTimeout = globalThis.setTimeout;
const dir = '/home/user/at-cap';
const FILES = { 'one.js': 'a'.repeat(12 * 1024), 'two.js': 'b'.repeat(3 * 1024), 'three.js': 'c'.repeat(40 * 1024) };
const authority = createAuthority();
authority.kfs.mkdir(dir.slice(1), { recursive: true, mode: 0o755 });
for (const [name, body] of Object.entries(FILES)) authority.kfs.writeFile(`${dir.slice(1)}/${name}`, body);

const grants = [];
// A process facet's store, its cap exactly what it holds: full. The session's
// ledger grants exactly what is asked, after a turn.
const { fs, cap, bytes, rf } = sessionShims(authority, {
  cwd: dir,
  overrides: {
    fsStorageGrant: async (facet, want) => {
      await new Promise((resolve) => rawSetTimeout(resolve, 1));
      grants.push(want);
      return { granted: want };
    },
  },
  tail: '\n;__resident.admission.setStorage({ facet: "proc-slot-0", grant: 0 }, __supervisor);'
    + '\n;return { fs: __fsMod, cap: () => __resident.admission.storageCap(), bytes: () => __resident.admission.dbBytes() };',
});
assert.ok(bytes() >= cap(), `the store starts full (${bytes()} of ${cap()} bytes)`);

// Three reads miss together, as a module's requests do.
for (const name of Object.keys(FILES)) {
  assert.throws(() => fs.readFileSync(`${dir}/${name}`, 'utf8'), { code: 'EAGAIN' }, `${name} is not held yet`);
}
await rf.misses();

for (const [name, body] of Object.entries(FILES)) {
  assert.equal(fs.readFileSync(`${dir}/${name}`, 'utf8'), body, `${name}'s fault-in landed in the full store`);
}
assert.ok(grants.length >= 1, 'room was asked of the ledger');
assert.ok(bytes() <= cap(), `and the store holds no more than it was granted (${bytes()} of ${cap()})`);

console.log('node-shims-fault-in-at-cap: ok');
