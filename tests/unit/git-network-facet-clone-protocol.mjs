import assert from 'node:assert/strict';

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { execGitNetwork } from '../../packages/worker/src/git/network-facet.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { stagedAssets } from './lib/staged-assets.mjs';

const calls = [];
let supervisorDisposeCount = 0;
let prepareDurable = false;
let loadCount = 0;
let entrypointCount = 0;
let committedFailurePrefix = false;
let abortObservedPrefix = false;
const terminalLines = [];
/** What a prepare plans: two batches (one for a clone that fails, so it fails once). */
const plan = (batches) => ({
  commit: '1'.repeat(40),
  tree: '2'.repeat(40),
  headRef: 'refs/heads/main',
  capabilities: ['filter', 'allow-reachable-sha1-in-want'],
  batches: Array.from({ length: batches }, (_, index) => ({ index, blobs: 2, paths: 2, bytes: 44 })),
  planEntries: 2 * batches,
  planBytes: 64,
  shares: [{ name: 'index-gitlinks', bytes: 0 }],
  cacheTreeBytes: 30,
  partial: false,
  packs: [],
});

const supervisor = {
  // Process output crosses this RPC as bytes; the test reads it as text.
  async stdout(message) { terminalLines.push(new TextDecoder().decode(message)); },
  [Symbol.dispose]() { supervisorDisposeCount++; },
};

adoptCtxExports({
  SupervisorRPC() {
    return supervisor;
  },
});

const entrypoint = {
  async fetch(request) {
    const body = await request.json();
    calls.push({ url: request.url, body });

    if (body.phase === 'clone-prepare') {
      if (body.dir === '/existing') {
        return Response.json({
          success: false,
          error: "fatal: destination path '/existing' already exists and is not an empty directory.",
          mutated: false,
          filesWritten: 0,
          bytesWritten: 0,
          supervisorRpc: {},
          metadataOverlay: { entries: 0, accountedBytes: 0 },
          diagnostic: {
            phase: body.phase,
            invocationId: body.invocationId,
            outcome: 'error',
            mutated: false,
          },
        });
      }
      prepareDurable = true;
      return Response.json({
        success: true,
        prepared: { fast: plan(body.dir === '/failure' ? 1 : 2) },
        filesWritten: 4,
        bytesWritten: 18,
        supervisorRpc: { writeBatchStream: 1 },
        metadataOverlay: { entries: 4, accountedBytes: 512 },
      });
    }

    if (body.phase === 'clone-abort') {
      abortObservedPrefix = committedFailurePrefix;
      return Response.json({
        success: true,
        filesWritten: 0,
        bytesWritten: 0,
        supervisorRpc: { writeBatchStream: 1 },
        metadataOverlay: { entries: 1, accountedBytes: 128 },
      });
    }

    assert.equal(prepareDurable, true, body.phase + ' started before prepare became durable');
    if (body.phase === 'clone-finish') {
      assert.deepEqual(body.shares.map((share) => share.name).sort(), ['index-0', 'index-1', 'index-gitlinks']);
      assert.equal(body.cacheTreeBytes, 30);
      return Response.json({
        success: true,
        filesWritten: 1,
        bytesWritten: 2,
        supervisorRpc: { writeBatchStream: 1 },
        metadataOverlay: { entries: 0, accountedBytes: 0 },
      });
    }
    assert.equal(body.phase, 'clone-batch');
    if (body.dir === '/failure') {
      committedFailurePrefix = true;
      return Response.json({
        success: false,
        error: 'checkout exploded',
        filesWritten: 1,
        bytesWritten: 3,
        supervisorRpc: { writeBatchStream: 1 },
        metadataOverlay: { entries: 5, accountedBytes: 640 },
      });
    }
    return Response.json({
      success: true,
      batch: { index: body.batch.index, blobs: 2, files: 2, indexBytes: 140, pack: null },
      filesWritten: 2,
      bytesWritten: 6,
      supervisorRpc: { writeBatchStream: 1 },
      metadataOverlay: { entries: 0, accountedBytes: 0 },
    });
  },
};

const worker = {
  getEntrypoint() {
    entrypointCount++;
    return entrypoint;
  },
};

const env = {
  ASSETS: stagedAssets,
  LOADER: {
    load() {
      loadCount++;
      return worker;
    },
  },
};

const result = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  env,
  {
    op: 'clone',
    pid: 1,
    depth: 1,
    dir: '/repo',
    url: 'https://example.invalid/repo.git',
    exclusiveDestination: true,
    exclusiveMutationRoot: 'repo',
    mutationOwner: 'owner',
  }, ISOLATE_NETWORK,
);

assert.equal(result.success, true, result.error);
assert.equal(loadCount, 1, 'clone must load one dynamic worker');
assert.equal(entrypointCount, 1, 'clone must use one entrypoint');
assert.deepEqual(calls.map(({ body }) => body.phase), ['clone-prepare', 'clone-batch', 'clone-batch', 'clone-finish'],
  'clone must use prepare, its batches and finish');
assert.equal(new Set(calls.map(({ url }) => url)).size, calls.length, 'phase invocations need distinct trace markers');
assert.match(calls[0].url, /\/git\/clone-prepare\//);
assert.match(calls[1].url, /\/git\/clone-batch\//);
assert.match(calls[3].url, /\/git\/clone-finish\//);
for (const call of calls) {
  assert.equal(call.body.jobId, calls[0].body.jobId);
  assert.equal(call.body.optionsHash, calls[0].body.optionsHash);
  assert.ok(Number.isSafeInteger(call.body.phaseDeadline));
}
assert.deepEqual(calls.slice(1, 3).map(({ body }) => body.batch.index).sort(), [0, 1]);
assert.equal(result.filesWritten, 4 + 2 + 2 + 1);
assert.equal(result.bytesWritten, 18 + 6 + 6 + 2);
assert.equal(result.supervisorRpc.writeBatchStream, 4);
const batchLines = terminalLines.filter(line => line.includes('clone-batch'));
assert.equal(batchLines.length, 2, 'one terminal line per batch');
assert.match(batchLines[1], /clone-batch 2\/2 complete \(blobs=2 files=2 /);

const callsBeforeFailure = calls.length;
prepareDurable = false;
const failed = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  env,
  {
    op: 'clone',
    pid: 1,
    depth: 1,
    dir: '/failure',
    url: 'https://example.invalid/repo.git',
    exclusiveDestination: true,
    exclusiveMutationRoot: 'failure',
    mutationOwner: 'owner',
  }, ISOLATE_NETWORK,
);
const failureCalls = calls.slice(callsBeforeFailure);
assert.equal(failed.success, false, 'failed checkout must not report clone complete');
assert.equal(failed.error, 'checkout exploded', 'abort must not mask the primary phase error');
assert.equal(failed.errorPhase, 'clone-batch');
assert.equal(failed.cleanupError, undefined);
assert.deepEqual(failureCalls.map(({ body }) => body.phase), [
  'clone-prepare',
  'clone-batch',
  'clone-abort',
], 'a batch failure that is not a lost transport is not retried');
assert.equal(abortObservedPrefix, true, 'abort did not leave the committed worktree prefix inspectable');
assert.equal(failed.filesWritten, 5, 'partial checkout writes were not reported');

const callsBeforeExisting = calls.length;
const existing = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  env,
  {
    op: 'clone',
    pid: 1,
    depth: 1,
    dir: '/existing',
    url: 'https://example.invalid/repo.git',
    exclusiveDestination: true,
    exclusiveMutationRoot: 'existing',
    mutationOwner: 'owner',
  }, ISOLATE_NETWORK,
);
assert.equal(existing.success, false);
assert.match(existing.error, /already exists and is not an empty directory/);
assert.deepEqual(
  calls.slice(callsBeforeExisting).map(({ body }) => body.phase),
  ['clone-prepare'],
  'pre-mutation prepare failure must not invoke clone-abort',
);

// The clone's whole budget runs out during its prepare, and the abort that
// follows has a budget of its own. The prepare answers only once the clone
// has returned, so its answer always lands late; the abort answers at once.
// The budget is wide enough that the prepare is always sent: at 5 ms, with
// 16 busy loops on 8 CPUs, it ran out before the prepare in 2 of 40 runs,
// the abort was the only call, and a count of 2 failed with nothing leaked.
const TIMED_OUT_BUDGET_MS = 1000;
let lateResponseDisposed = 0;
const disposable = () => {
  const response = Response.json({ success: true });
  Object.defineProperty(response, Symbol.dispose, {
    value() { lateResponseDisposed++; },
  });
  return response;
};
const lateCalls = [];
let answerPrepare;
const lateEntrypoint = {
  fetch(request) {
    const phase = new URL(request.url).pathname.split('/')[2];
    lateCalls.push(phase);
    if (phase === 'clone-prepare') return new Promise(resolve => { answerPrepare = () => resolve(disposable()); });
    return Promise.resolve(disposable());
  },
};
const timedOut = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  { ASSETS: stagedAssets, LOADER: { load: () => ({ getEntrypoint: () => lateEntrypoint }) } },
  {
    op: 'clone',
    pid: 1,
    depth: 1,
    dir: '/timeout',
    url: 'https://example.invalid/repo.git',
    timeout: TIMED_OUT_BUDGET_MS,
    exclusiveDestination: true,
    exclusiveMutationRoot: 'timeout',
    mutationOwner: 'owner',
  }, ISOLATE_NETWORK,
);
assert.equal(timedOut.success, false);
assert.equal(timedOut.errorPhase, 'clone-prepare');
assert.equal(timedOut.errorCode, 'GitCloneBudgetExceeded');
const { elapsedMs: timedOutElapsed, ...timedOutBudget } = timedOut.budget;
assert.deepEqual(timedOutBudget, {
  phase: 'clone-prepare',
  batchesCompleted: 0,
  filesWritten: 0,
  limitMs: TIMED_OUT_BUDGET_MS,
});
assert.ok(timedOutElapsed >= timedOut.budget.limitMs);
assert.match(timedOut.error, /clone budget exhausted after 0 batches \/ 0 files/);
assert.deepEqual(lateCalls, ['clone-prepare', 'clone-abort'], 'the prepare was sent and timed out, then the abort ran');
// The prepare's answer lands now; the caller disposes it in the
// continuation it attached when it called, which has run by the next turn.
answerPrepare();
await new Promise(resolve => setImmediate(resolve));
assert.equal(lateResponseDisposed, 2,
  'timed-out prepare or independently budgeted abort leaked its RPC stub');

const originalNow = Date.now;
let artificialNow = 0;
const defaultBudgetCalls = [];
try {
  Date.now = () => artificialNow;
  const defaultBudget = await execGitNetwork(
    { id: { toString: () => 'test-do' } },
    {
      ASSETS: stagedAssets,
      LOADER: {
        load: () => ({
          getEntrypoint: () => ({
            async fetch(request) {
              const body = await request.json();
              defaultBudgetCalls.push(body);
              if (body.phase === 'clone-prepare') {
                artificialNow = 290_000;
                return Response.json({ success: true, prepared: { fast: plan(1) }, supervisorRpc: {} });
              }
              return Response.json({
                success: true,
                batch: { index: 0, blobs: 1, files: 1, indexBytes: 70, pack: null },
                supervisorRpc: {},
              });
            },
          }),
        }),
      },
    },
    {
      op: 'clone',
      pid: 1,
      depth: 1,
      dir: '/default-budget',
      url: 'https://example.invalid/repo.git',
      exclusiveDestination: true,
      exclusiveMutationRoot: 'default-budget',
      mutationOwner: 'owner',
    }, ISOLATE_NETWORK,
  );
  assert.equal(defaultBudget.success, true, defaultBudget.error);
} finally {
  Date.now = originalNow;
}
assert.equal(defaultBudgetCalls[1].phase, 'clone-batch');
assert.equal(defaultBudgetCalls[1].phaseDeadline, 290_000 + 300_000,
  'default clone budget starved a later batch');

let throwingWorkerDisposed = 0;
const supervisorDisposalsBeforeEntrypointFailure = supervisorDisposeCount;
const entrypointFailure = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  {
    ASSETS: stagedAssets,
    LOADER: {
      load() {
        return {
          getEntrypoint() { throw new Error('entrypoint unavailable'); },
          [Symbol.dispose]() { throwingWorkerDisposed++; },
        };
      },
    },
  },
  { op: 'fetch', pid: 1, dir: '/repo' }, ISOLATE_NETWORK,
);
assert.equal(entrypointFailure.success, false);
assert.equal(entrypointFailure.error, 'entrypoint unavailable');
assert.equal(throwingWorkerDisposed, 1, 'worker leaked when getEntrypoint threw');
assert.equal(supervisorDisposeCount, supervisorDisposalsBeforeEntrypointFailure + 1,
  'supervisor binding leaked when getEntrypoint threw');

console.log('git network facet clone protocol: ok');
