#!/usr/bin/env bun
// Many synchronous reads' fault-ins wait on a ledger that refuses.
//
// Their reservations wait in line for room (node-shims-fault-in-at-cap-many).
// The ledger grants part of what is asked, then nothing: the reservations
// that fit in what it granted land, and the rest are refused, so their reads
// stay misses. None is left waiting: the settle the exit report owes returns.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

// The raw timer: the ledger's latency is its own, not a resumption of the program.
const rawSetTimeout = globalThis.setTimeout;
const dir = '/home/user/locales';
// zod's locales run 2 to 12 KB; sizes that differ, as theirs do.
const FILES = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`l${i}.js`, String.fromCharCode(97 + (i % 26)).repeat(2048 + ((i * 1597) % 10240))]));
const authority = createAuthority();
authority.kfs.mkdir(dir.slice(1), { recursive: true, mode: 0o755 });
for (const [name, body] of Object.entries(FILES)) authority.kfs.writeFile(`${dir.slice(1)}/${name}`, body);

const grants = [];
const left = { taken: 0 };
// A session's ledger near its limit: 20000 bytes in all, after a turn.
const { fs, cap, bytes, rf } = sessionShims(authority, {
  cwd: dir,
  overrides: {
    fsStorageGrant: async (facet, want) => {
      await new Promise((resolve) => rawSetTimeout(resolve, 1));
      grants.push(want);
      const granted = Math.min(want, 20000 - left.taken);
      left.taken += granted;
      return { granted };
    },
  },
  tail: '\n;__resident.admission.setStorage({ facet: "proc-slot-0", grant: 0 }, __supervisor);'
    + '\n;return { fs: __fsMod, cap: () => __resident.admission.storageCap(), bytes: () => __resident.admission.dbBytes() };',
});
assert.ok(bytes() >= cap(), `the store starts full (${bytes()} of ${cap()} bytes)`);

// Every read misses in the same turn, as a module's requests do.
for (const name of Object.keys(FILES)) {
  assert.throws(() => fs.readFileSync(`${dir}/${name}`, 'utf8'), { code: 'EAGAIN' }, `${name} is not held yet`);
}
const settled = await Promise.race([
  rf.settle().then(() => true),
  new Promise((resolve) => rawSetTimeout(() => resolve(false), 5000)),
]);
assert.ok(settled, 'every fault-in settles: none waits for room that will not come');

import { recording } from './lib/session-shims.mjs';
const checks = recording();
const landed = Object.keys(FILES).filter((name) => {
  try { return fs.readFileSync(`${dir}/${name}`, 'utf8') === FILES[name]; } catch { return false; }
});
await checks.check('the fills the grant covered landed', () => assert.ok(landed.length > 0));
await checks.check('the rest were refused', () => assert.ok(landed.length < Object.keys(FILES).length, `the rest were refused (${landed.length} landed)`));
assert.ok(bytes() <= cap(), `and the store holds no more than it was granted (${bytes()} of ${cap()})`);
checks.finish();
console.log('node-shims-fault-in-refused: ok');
