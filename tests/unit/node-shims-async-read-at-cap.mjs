#!/usr/bin/env bun
// An asynchronous read of a file the store holds, with the store at its cap.
//
// An async read goes to the authority and writes its bytes through, dated at
// its cursor, so the next synchronous read is not older than what the
// program was just handed. A dev server reads its sources that way (vite's
// transform), and a big launch fills its store to the cap. The write-through
// removed the row it was replacing before asking whether the replacement
// fit; at the cap it did not, and the file the store held was gone. Tailwind
// v4's scanner reads synchronously and skips a file that is not held, so the
// first stylesheet lacked the classes App.tsx uses (vite-tailwind4-real, the
// row dropped by a fill of the same bytes 80 ms after it was read).
//
// Bytes the store already holds are its own, as text or as bytes: such a
// read only dates the row at its cursor. Bytes that differ replace it as
// before. The supervisor reads by ranges, as a session's does, so the store
// holds text a fault-in filled and the async read returns bytes.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

const dir = '/home/user/reread';
const FILES = { 'App.tsx': 'export const App = () => <div className="text-red-500" />;\n'.repeat(40), 'main.tsx': 'import { App } from "./App";\n'.repeat(60) };
const authority = createAuthority();
authority.kfs.mkdir(dir.slice(1), { recursive: true, mode: 0o755 });
for (const [name, body] of Object.entries(FILES)) authority.kfs.writeFile(`${dir.slice(1)}/${name}`, body);

// The session's ledger grants what is asked until the store holds the sources; then it has none left,
// and the store's allowance is what it holds.
let granting = true;
const { fs, room, full, rf } = sessionShims(authority, {
  cwd: dir,
  overrides: {
    fsStorageGrant: async (_facet, want) => ({ granted: granting ? want : 0 }),
  },
  tail: '\n;__resident.admission.setStorage({ facet: "proc-slot-0", grant: 0 }, __supervisor);'
    + '\n;const allow = (grant) => __resident.admission.setStorage({ facet: "proc-slot-0", grant }, __supervisor);'
    + '\n;return { fs: __fsMod, room: () => allow(1 << 20), full: () => allow(0) };',
});

// App.tsx and main.tsx are faulted in by their first synchronous reads.
room();
assert.throws(() => fs.readFileSync(`${dir}/App.tsx`, 'utf8'), { code: 'EAGAIN' }, 'App.tsx is not held yet');
assert.throws(() => fs.readFileSync(`${dir}/main.tsx`, 'utf8'), { code: 'EAGAIN' });
await rf.misses();
for (const [name, body] of Object.entries(FILES)) assert.equal(fs.readFileSync(`${dir}/${name}`, 'utf8'), body, `${name} is held`);

// Now the store is at its cap, and the ledger has nothing more.
granting = false;
full();
for (const [name, body] of Object.entries(FILES)) {
  assert.equal(await fs.promises.readFile(`${dir}/${name}`, 'utf8'), body, `${name} reads asynchronously`);
  assert.equal(fs.readFileSync(`${dir}/${name}`, 'utf8'), body, `${name} still reads synchronously, held at the cap`);
}

// A changed file's async read still replaces what the store held.
authority.kfs.writeFile(`${dir.slice(1)}/main.tsx`, 'changed');
assert.equal(await fs.promises.readFile(`${dir}/main.tsx`, 'utf8'), 'changed');
let served = 'changed';
try { served = fs.readFileSync(`${dir}/main.tsx`, 'utf8'); } catch (error) { assert.equal(error.code, 'EAGAIN', 'a row it could not keep is refused, not stale'); }
assert.notEqual(served, FILES['main.tsx'], 'no sync read serves the old bytes');
console.log('node-shims-async-read-at-cap: ok');
