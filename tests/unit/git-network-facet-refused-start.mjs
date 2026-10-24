#!/usr/bin/env bun
// A git network facet's call the platform refuses at its Dynamic Worker limit
// ("Too many dynamic workers.") is refused before the facet is entered, so
// nothing ran: the call is sent again once the session's ledger lets it in
// (budgets.ts readmitRefused), on each path a facet is called by, a clone's
// phase and a fetch. A failure the facet answers with is the operation's
// own, and is not sent again.
//
// Red before: the refusal failed the operation ("[git] clone failed: Too
// many dynamic workers.", large-install on 2026-10-23).

import assert from 'node:assert/strict';

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { execGitNetwork } from '../../packages/worker/src/git/network-facet.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { loaderLedgerStats } from '../../packages/fabric/src/budgets.ts';
import { stagedAssets } from './lib/staged-assets.mjs';

const REFUSAL = 'Too many dynamic workers.';

adoptCtxExports({
  SupervisorRPC() {
    return { async stdout() {}, [Symbol.dispose]() {} };
  },
});

/** A two-batch clone plan, as a prepare answers it: its batches run at once (CLONE_BATCH_CONCURRENCY). */
const plan = {
  commit: '1'.repeat(40),
  tree: '2'.repeat(40),
  headRef: 'refs/heads/main',
  capabilities: ['filter', 'allow-reachable-sha1-in-want'],
  batches: [{ index: 0, blobs: 2, paths: 2, bytes: 44 }, { index: 1, blobs: 2, paths: 2, bytes: 44 }],
  planEntries: 2,
  planBytes: 64,
  shares: [{ name: 'index-gitlinks', bytes: 0 }],
  cacheTreeBytes: 30,
  partial: false,
  packs: [],
};

/** What the facet answers a call that reached it, by its phase (a fetch has none). */
function answer(body) {
  const done = { filesWritten: 1, bytesWritten: 2, supervisorRpc: {} };
  if (body.phase === 'clone-prepare') return Response.json({ success: true, prepared: { fast: plan }, ...done });
  if (body.phase === 'clone-batch') return Response.json({ success: true, batch: { index: body.batch.index, blobs: 2, files: 2, indexBytes: 140, pack: null }, ...done });
  return Response.json({ success: true, ...done });
}

/**
 * A loader whose facet refuses the calls `refuse` counts by kind (a phase, or
 * 'op' for a fetch), before reading them, as the platform does; or, with
 * `answered`, answers them with a failure of its own.
 */
function loader(refuse, answered = false) {
  const reached = [];
  let refused = 0;
  const pending = new Map(Object.entries(refuse));
  const entrypoint = {
    async fetch(request) {
      const kind = new URL(request.url).pathname.split('/')[2] ?? 'op';
      if ((pending.get(kind) ?? 0) > 0) {
        pending.set(kind, pending.get(kind) - 1);
        refused++;
        if (!answered) throw new Error(REFUSAL);
        await request.json();
        reached.push(kind);
        return Response.json({ success: false, error: REFUSAL, filesWritten: 0, bytesWritten: 0, supervisorRpc: {} });
      }
      const body = await request.json();
      reached.push(kind);
      return answer(body);
    },
    [Symbol.dispose]() {},
  };
  const worker = { getEntrypoint: () => entrypoint, [Symbol.dispose]() {} };
  return { env: { ASSETS: stagedAssets, LOADER: { load: () => worker } }, reached, refusedCount: () => refused };
}

const ctx = () => ({ id: { toString: () => `git-refused-${crypto.randomUUID()}` } });
/** What the operation left on its session's ledger: nothing, once it has ended. */
const ledgerLeft = (session) => {
  const { inFlightWorkers, waiting } = loaderLedgerStats(session);
  return { inFlightWorkers, waiting };
};
const clone = { op: 'clone', pid: 1, depth: 1, dir: '/repo', url: 'https://example.invalid/repo.git', exclusiveDestination: true, exclusiveMutationRoot: 'repo', mutationOwner: 'owner' };
const fetchOp = { op: 'fetch', dir: '/home/user/repo', pid: 42 };

// A clone whose prepare and finish are refused once, and whose two batches
// are refused together, completes; the facet holds one place on the ledger
// throughout, and none once the clone has ended.
{
  const session = ctx();
  const { env, reached, refusedCount } = loader({ 'clone-prepare': 1, 'clone-batch': 2, 'clone-finish': 1 });
  const result = await execGitNetwork(session, env, clone, ISOLATE_NETWORK);
  assert.equal(result.success, true, result.error);
  assert.equal(refusedCount(), 4, 'prepare, both batches and finish were refused');
  assert.deepEqual(reached.sort(), ['clone-batch', 'clone-batch', 'clone-finish', 'clone-prepare'], 'and each reached the facet once, when sent again');
  assert.deepEqual(ledgerLeft(session), { inFlightWorkers: [], waiting: 0 }, 'the clone left nothing on the ledger');
  console.log('  ok a clone whose phases are refused at the limit, two batches at once, completes and leaves no hold');
}

// A fetch refused once completes.
{
  const session = ctx();
  const { env, reached, refusedCount } = loader({ op: 1 });
  const result = await execGitNetwork(session, env, fetchOp, ISOLATE_NETWORK);
  assert.equal(result.success, true, result.error);
  assert.deepEqual([refusedCount(), reached], [1, ['op']], 'the fetch was refused once and reached the facet once');
  assert.deepEqual(ledgerLeft(session), { inFlightWorkers: [], waiting: 0 }, 'the fetch left nothing on the ledger');
  console.log('  ok a fetch refused at the limit completes, sent again');
}

// A failure the facet answers with, in the same words, is the operation's own.
{
  const { env, reached } = loader({ op: 1 }, true);
  const result = await execGitNetwork(ctx(), env, fetchOp, ISOLATE_NETWORK);
  assert.equal(result.success, false);
  assert.equal(result.error, REFUSAL);
  assert.deepEqual(reached, ['op'], 'a call the facet answered is not sent again');
  console.log('  ok a failure the facet answered is not sent again');
}

console.log('git network facet refused start: ok');
