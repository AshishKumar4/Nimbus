#!/usr/bin/env bun
// A relaunch that is handed the previous process's store must not serve a row
// of it that this launch has not validated.
//
// A released keyed slot keeps its SQLite for the next spawn under the same
// credential (9401b6c9), and the boot reconcile brings it current: rows the
// absolute listing proves current are kept, the rest refetched. That is what
// makes a relaunch cost 2 files instead of 36,137. But the kept rows describe
// the filesystem as of the LAST process, and only the reconcile says which of
// them still do. When it cannot say — the supervisor cannot list, the listing
// comes back short, there is no supervisor at all — those rows must not be
// what the program's first synchronous reads are answered from. No ACQUIRE
// has run yet at that point, so nothing else would catch them.
//
// Each scenario keeps a store the way a previous launch leaves one (the same
// boot fill, over the same SQLite), changes files behind it, and boots the
// REAL resident body on it (tests/unit/lib/resident-body.mjs).

import assert from 'node:assert/strict';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { _rpcFsList } from '../../packages/worker/src/session/rpc.ts';
import {
  createAuthority,
  facetSql,
  facetSupervisor,
  launchResident,
  runScenarios,
} from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
// The program's first instructions: synchronous reads, before any resumption.
globalThis.__first = {
  staged: read("/home/user/app/staged.txt"),
  kept: read("/home/user/app/kept.txt"),
  same: read("/home/user/app/same.txt"),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/**
 * A session, a store kept from a previous launch over it, and the files that
 * changed since. `staged.txt` is in this launch's own snapshot (the manager
 * stages the entry's closure and a bounded project tree at the spawn's
 * cursor); `kept.txt` changed and is not staged; `same.txt` did not change.
 */
async function keptStore() {
  const authority = createAuthority();
  const { kfs } = authority;
  kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  kfs.writeFile('home/user/app/staged.txt', 'OLD-STAGED');
  kfs.writeFile('home/user/app/kept.txt', 'OLD-KEPT');
  kfs.writeFile('home/user/app/same.txt', 'SAME');

  // What a previous launch leaves: the cold adopt, then the boot fill.
  const sql = facetSql();
  const previous = new Function(
    `${FACET_RESIDENT_STORE_SOURCE}\nreturn { __residentBind, __residentAdoptModuleBundle, __residentSynchronizeFromSupervisor };`,
  )();
  previous.__residentBind({ storage: { sql } });
  previous.__residentAdoptModuleBundle({}, authority.cursor());
  const filled = await previous.__residentSynchronizeFromSupervisor(facetSupervisor(authority).supervisor);
  assert.equal(filled.filled, 3, 'the previous launch held every file');

  kfs.writeFile('home/user/app/staged.txt', 'NEW-STAGED');
  kfs.writeFile('home/user/app/kept.txt', 'NEW-KEPT');
  const cursor = authority.cursor();
  return { authority, sql, cursor, bundle: { 'home/user/app/staged.txt': 'NEW-STAGED' } };
}

/** The first reads must not be the rows the previous launch left behind. */
function assertNothingStale(first) {
  assert.notEqual(first.staged, 'OLD-STAGED', 'a staged file was served from the kept row');
  assert.notEqual(first.kept, 'OLD-KEPT', 'a changed file was served from the kept row');
  assert.equal(first.staged, 'NEW-STAGED', "the launch's own snapshot is current as of its spawn");
}

await runScenarios(import.meta.path, {
  async 'a kept store whose listing fails'() {
    const { authority, sql, cursor, bundle } = await keptStore();
    const { supervisor } = facetSupervisor(authority, {
      async fsList() { throw new Error('Network connection lost.'); },
    });
    await launchResident({ program: PROGRAM, env: { SUPERVISOR: supervisor }, sql, bundle, cursor });
    assertNothingStale(globalThis.__first);
  },

  async 'a kept store whose listing comes back short'() {
    const { authority, sql, cursor, bundle } = await keptStore();
    let page = 0;
    const { supervisor } = facetSupervisor(authority, {
      // The supervisor is replaced between two pages, so the walk stops short.
      async fsList(after, limit) {
        const listed = await _rpcFsList(authority.host, after ?? null, 1);
        return page++ === 0 ? { ...listed, next: listed.entries.at(-1).path } : { ...listed, epoch: 'a-new-incarnation' };
      },
    });
    await launchResident({ program: PROGRAM, env: { SUPERVISOR: supervisor }, sql, bundle, cursor });
    assertNothingStale(globalThis.__first);
  },

  async 'a kept store with no supervisor to reconcile against'() {
    const { sql, cursor, bundle } = await keptStore();
    await launchResident({ program: PROGRAM, env: {}, sql, bundle, cursor });
    assertNothingStale(globalThis.__first);
  },

  async 'a kept store that reconciles'() {
    // The speedup the kept store exists for: what did not change is kept, not
    // refetched, and what changed is current before the first instruction.
    const { authority, sql, cursor, bundle } = await keptStore();
    const { supervisor, log } = facetSupervisor(authority);
    const fetched = [];
    const readBatch = supervisor.fsReadBatch;
    const counting = new Proxy(supervisor, {
      get(target, name) {
        if (name !== 'fsReadBatch') return target[name];
        return async (requests) => { for (const r of requests) fetched.push(r.path); return readBatch(requests); };
      },
    });
    await launchResident({ program: PROGRAM, env: { SUPERVISOR: counting }, sql, bundle, cursor });
    assert.deepEqual(globalThis.__first, { staged: 'NEW-STAGED', kept: 'NEW-KEPT', same: 'SAME' });
    assert.deepEqual(
      fetched.sort(),
      ['home/user/app/kept.txt', 'home/user/app/staged.txt'],
      'only what changed is fetched',
    );
    assert.equal(log.calls.fsList, 1, 'one listing');
  },
});

console.log('resident-warm-store-reconcile: ok');
