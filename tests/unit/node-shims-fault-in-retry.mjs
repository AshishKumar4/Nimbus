#!/usr/bin/env bun
// A fault-in whose bytes did not land is asked for again.
//
// A synchronous read that misses faults the file in, once (_faultOnce). The
// fetch can complete without its bytes landing: a barrier that could not
// date them spoiled the fill (a poison moves the cursor with no delta), or
// the store refused them. Treated as answered, the path was never fetched
// again, so the import() prefetch, whose step re-reads until nothing new
// misses, stood with the module unread and the load failed: astro dev, 1 in
// 10 under concurrency, "Cannot load module '…/zod/v4/classic/index.js': it
// was not in this launch's module map", traced live as "install … declined:
// spoiled reported=Infinity rev=528 cursor=542" (a throwaway, astro-real).
//
// Now a fetch that did not land, and did not prove the file absent, leaves
// the path to be asked for again by the next miss, a few times; and the
// prefetch takes another round for a path it asked for again. Driven here
// through the other way a fill fails to land, a store that refuses it once.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { sessionShims } from './lib/session-shims.mjs';

// The raw timer: the ledger's latency is its own, not a resumption of the program.
const rawSetTimeout = globalThis.setTimeout;
const dir = '/home/user/retry';
const FILES = {
  'direct.js': 'module.exports = "direct";\n',
  'prefetched.js': 'module.exports = "prefetched";\n',
  'shared.js': 'module.exports = "shared";\n',
  'never.js': 'module.exports = "never";\n',
  'node_modules/pinned/package.json': JSON.stringify({ name: 'pinned', main: 'lib/main.js' }),
  'node_modules/pinned/lib/main.js': 'module.exports = "main";\n',
  'node_modules/pinned/index.js': 'module.exports = "index";\n',
};

/**
 * A process over these files whose store is full, and a ledger that answers
 * an ask for room with `grant(path)`: the room asked for, or none. A
 * fetch with no room does not land. Asks for no room (the store's report
 * after a fill) are always answered.
 */
function world(grant) {
  const authority = createAuthority();
  for (const [name, body] of Object.entries(FILES)) {
    const path = `${dir.slice(1)}/${name}`;
    authority.kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    authority.kfs.writeFile(path, body);
  }
  const io = { reads: 0 };
  const shims = sessionShims(authority, {
    cwd: dir,
    overrides: (call) => ({
      fsReadBatch: (requests) => {
        io.reads += requests.filter((request) => request.lstat !== true).length;
        return call('fsReadBatch', [requests]);
      },
      fsStorageGrant: async (facet, want) => {
        await new Promise((resolve) => rawSetTimeout(resolve, 1));
        return { granted: want === 0 || grant() ? want : 0 };
      },
    }),
    tail: '\n;__resident.admission.setStorage({ facet: "proc-slot-0", grant: 0 }, __supervisor);'
      + '\n;return { fs: __fsMod, hydrated: __nimbusHydrated, read: __readFileOr, resolveFrom: __resolveFrom, quota: (s) => __nimbusPrefetchQuota(s) };',
  });
  return { ...shims, io };
}

// Every other ask for room is refused, starting with the first.
let asks = 0;
const { fs, hydrated, read, quota, rf, io } = world(() => ++asks % 2 === 0);
const settle = () => rf.misses();

// Each scenario is run on its own, so one that fails does not hide the others.
const failures = [];
async function scenario(name, run) {
  try { await run(); } catch (error) { failures.push(`${name}: ${error?.stack ?? error}`); }
}

// ── a program's own reads: the first fetch is refused, the next miss asks again ──
await scenario('a program\'s own read', async () => {
  const path = `${dir}/direct.js`;
  assert.throws(() => fs.readFileSync(path, 'utf8'), { code: 'EAGAIN' });
  await settle();
  assert.throws(() => fs.readFileSync(path, 'utf8'), { code: 'EAGAIN' }, 'the first fetch did not land');
  await settle();
  assert.equal(fs.readFileSync(path, 'utf8'), FILES['direct.js'], 'the second miss asked again, and it landed');
});

// ── the import() prefetch takes another round for it ──
await scenario('the import() prefetch', async () => {
  const k = 'home/user/retry/prefetched.js';
  const text = await hydrated(() => read(k, null), quota('retry'));
  assert.equal(text, FILES['prefetched.js'], 'one prefetch step reads the file whose first fetch was refused');
});

// ── a file that is not there is not asked for again ──
await scenario('an absent file', async () => {
  const before = io.reads;
  assert.equal(await hydrated(() => read('home/user/retry/gone.js', null), quota('gone')), null);
  assert.equal(io.reads, before, 'an absent file costs no content read');
});

// ── two imports reading the same file at once: the one that joins the other's
// fetch reruns as the one that issued it does (DustyPanther, fifth recheck) ──
await scenario('two imports of one file', async () => {
  const k = 'home/user/retry/shared.js';
  const [first, second] = await Promise.all([
    hydrated(() => read(k, null), quota('first')),
    hydrated(() => read(k, null), quota('second')),
  ]);
  assert.equal(first, FILES['shared.js']);
  assert.equal(second, FILES['shared.js'], 'the import that joined a fetch read what it fetched, not its first miss');
});

// ── a file whose fetches never land: the prefetch fails, named, rather than
// stand on a partial resolution ──
await scenario('a fetch that never lands', async () => {
  const never = world(() => false);
  const unreadable = async (step) => {
    try { await never.hydrated(step, never.quota('never')); } catch (error) { return error; }
    return null;
  };
  const unread = await unreadable(() => never.read('home/user/retry/never.js', null));
  assert.equal(unread?.code, 'ERR_NIMBUS_PREFETCH_UNREADABLE', `a module never fetched: ${unread}`);
  assert.match(unread.message, /never\.js/);
  // pinned's package.json names lib/main.js; unread, the resolver would fall
  // back to index.js.
  const resolved = await unreadable(() => never.resolveFrom('pinned', 'home/user/retry'));
  assert.equal(resolved?.code, 'ERR_NIMBUS_PREFETCH_UNREADABLE', `a resolution on an unread manifest: ${resolved}`);
  assert.match(resolved.message, /pinned\/package\.json/);
});

if (failures.length > 0) throw new Error(`${failures.length} scenario(s) failed:\n${failures.join('\n')}`);
console.log('node-shims-fault-in-retry: ok');
