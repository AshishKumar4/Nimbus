#!/usr/bin/env bun
// Many synchronous reads' fault-ins land together in a store at its budget.
//
// `astro dev` imports zod's locales, a hundred modules at once, into a store
// its launch has filled. Each fault-in reserves its room before it fetches,
// and room is asked of the ledger, which grants it. But each ask was for the
// asker's own shortfall, and a waiter that saw room free after someone else's
// grant took it as its own without holding it: so one fill was served per
// grant round, and a reservation gave up after eight rounds. Past the first
// few, the fills were refused with the ledger granting every byte asked
// ("reserve refused …/zod/v4/locales/fi.js cap=42470256 db=42418176", traced
// live, with no grant short or failed), and the import failed: "could not
// fetch …; its fetches did not land".
//
// Waiting reservations are admitted in order as room comes, holding it as
// they are admitted, and one ask covers what they all still need. A
// reservation is refused only when the ledger grants less than is asked.

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

// Every read misses in the same turn, as a module's requests do.
for (const name of Object.keys(FILES)) {
  assert.throws(() => fs.readFileSync(`${dir}/${name}`, 'utf8'), { code: 'EAGAIN' }, `${name} is not held yet`);
}
await rf.misses();

const missed = Object.keys(FILES).filter((name) => {
  try { return fs.readFileSync(`${dir}/${name}`, 'utf8') !== FILES[name]; } catch { return true; }
});
assert.deepEqual(missed, [], `every fault-in landed in the full store (${missed.length} of ${Object.keys(FILES).length} did not; ${grants.length} grants)`);
// Room for a batch is asked for together, not one fill per round trip.
assert.ok(grants.length <= 4, `the batch's room took ${grants.length} asks of the ledger`);
assert.ok(bytes() <= cap(), `and the store holds no more than it was granted (${bytes()} of ${cap()})`);

console.log('node-shims-fault-in-at-cap-many: ok');
