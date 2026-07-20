import assert from 'node:assert/strict';

import { execGitNetwork } from '../../packages/worker/src/git/network-facet.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';

const calls = [];
let supervisorDisposeCount = 0;
let prepareDurable = false;
let loadCount = 0;
let entrypointCount = 0;
let committedFailurePrefix = false;
let abortObservedPrefix = false;
const terminalLines = [];
const continuationCursor = {
  version: 2,
  tree: '2'.repeat(40),
  stack: [{ treeOid: '2'.repeat(40), path: '', nextChildIndex: 3 }],
  directories: ['src'],
  indexChunks: 1,
  indexEntries: 3,
};

const supervisor = {
  async stdout(message) { terminalLines.push(message); },
  [Symbol.dispose]() { supervisorDisposeCount++; },
};

setCtxExports({
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
      const root = body.dir.replace(/^\/+/, '');
      return Response.json({
        success: true,
        prepared: {
          jobId: body.jobId,
          optionsHash: body.optionsHash,
          dir: root,
          commit: '1'.repeat(40),
          tree: '2'.repeat(40),
          headRef: 'refs/heads/main',
          packs: [{
            packPath: root + '/.git/objects/pack/pack-' + '3'.repeat(40) + '.pack',
            packBytes: 10,
            idxPath: root + '/.git/objects/pack/pack-' + '3'.repeat(40) + '.idx',
            idxBytes: 8,
            packSha: '3'.repeat(40),
          }],
          packOnlyObjectStore: true,
          metadata: [],
        },
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

    assert.equal(body.phase, 'clone-checkout');
    assert.equal(prepareDurable, true, 'checkout started before prepare became durable');
    if (body.dir === '/directory-limit') {
      return Response.json({
        success: false,
        error: 'git clone checkout directories exceeded their bound',
        errorCode: 'FreshCheckoutDirectoryLimitError',
        filesWritten: 0,
        bytesWritten: 0,
        supervisorRpc: {},
        metadataOverlay: { entries: 5, accountedBytes: 640 },
      });
    }
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
    if (body.checkoutCursor === null) {
      return Response.json({
        success: true,
        nextCursor: continuationCursor,
        treeEntriesVisited: 3,
        decodedBytes: 12,
        indexEntries: 2,
        filesWritten: 2,
        bytesWritten: 6,
        supervisorRpc: { writeBatchStream: 1 },
        cold: true,
        metadataOverlay: { entries: 6, accountedBytes: 768 },
      });
    }
    assert.deepEqual(body.checkoutCursor, continuationCursor);
    return Response.json({
      success: true,
      nextCursor: null,
      treeEntriesVisited: 2,
      decodedBytes: 6,
      indexEntries: 4,
      filesWritten: 2,
      bytesWritten: 6,
      supervisorRpc: { writeBatchStream: 1 },
      cold: false,
      metadataOverlay: { entries: 6, accountedBytes: 768 },
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
    dir: '/repo',
    url: 'https://example.invalid/repo.git',
    exclusiveDestination: true,
    exclusiveMutationRoot: 'repo',
    mutationOwner: 'owner',
  },
);

assert.equal(result.success, true, result.error);
assert.equal(loadCount, 1, 'clone must load one dynamic worker');
assert.equal(entrypointCount, 1, 'clone must use one entrypoint');
assert.equal(calls.length, 3, 'clone must use prepare plus bounded checkout invocations');
assert.notEqual(calls[0].url, calls[1].url, 'phase invocations need distinct trace markers');
assert.notEqual(calls[1].url, calls[2].url, 'checkout chunks need distinct trace markers');
assert.match(calls[0].url, /\/git\/clone-prepare\//);
assert.match(calls[1].url, /\/git\/clone-checkout\//);
assert.match(calls[2].url, /\/git\/clone-checkout\//);
assert.equal(calls[0].body.jobId, calls[1].body.jobId);
assert.equal(calls[1].body.jobId, calls[2].body.jobId);
assert.equal(calls[0].body.optionsHash, calls[1].body.optionsHash);
assert.equal(calls[1].body.optionsHash, calls[2].body.optionsHash);
assert.ok(Number.isSafeInteger(calls[0].body.phaseDeadline));
assert.ok(Number.isSafeInteger(calls[1].body.phaseDeadline));
assert.ok(Number.isSafeInteger(calls[2].body.phaseDeadline));
assert.equal(calls[1].body.checkoutCursor, null);
assert.deepEqual(calls[2].body.checkoutCursor, continuationCursor);
assert.deepEqual(calls[1].body.checkoutBounds, {
  maxEntries: 10_000,
  maxDecodedBytes: 32 * 1024 * 1024,
  maxWallMs: 150_000,
});
assert.deepEqual(calls[1].body.prepared, calls[0].body.phase === 'clone-prepare'
  ? {
      jobId: calls[0].body.jobId,
      optionsHash: calls[0].body.optionsHash,
      dir: 'repo',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      headRef: 'refs/heads/main',
      packs: [{
        packPath: 'repo/.git/objects/pack/pack-' + '3'.repeat(40) + '.pack',
        packBytes: 10,
        idxPath: 'repo/.git/objects/pack/pack-' + '3'.repeat(40) + '.idx',
        idxBytes: 8,
        packSha: '3'.repeat(40),
      }],
      packOnlyObjectStore: true,
      metadata: [],
    }
  : null);
assert.equal(result.filesWritten, 8);
assert.equal(result.bytesWritten, 30);
assert.equal(result.supervisorRpc.writeBatchStream, 3);
const chunkLines = terminalLines.filter(line => line.includes('clone-checkout chunk'));
assert.equal(chunkLines.length, 2, 'checkout emitted more than one terminal line per chunk');
assert.match(chunkLines[0], /chunk 1 complete .*w7=1 rpc=1 cold=yes\)/s);
assert.match(chunkLines[1], /chunk 2 complete .*w7=1 rpc=1 cold=no\)/s);

const callsBeforeFailure = calls.length;
prepareDurable = false;
const failed = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  env,
  {
    op: 'clone',
    pid: 1,
    dir: '/failure',
    url: 'https://example.invalid/repo.git',
    exclusiveDestination: true,
    exclusiveMutationRoot: 'failure',
    mutationOwner: 'owner',
  },
);
const failureCalls = calls.slice(callsBeforeFailure);
assert.equal(failed.success, false, 'failed checkout must not report clone complete');
assert.equal(failed.error, 'checkout exploded', 'abort must not mask the primary phase error');
assert.equal(failed.errorPhase, 'clone-checkout');
assert.equal(failed.cleanupError, undefined);
assert.deepEqual(failureCalls.map(({ body }) => body.phase), [
  'clone-prepare',
  'clone-checkout',
  'clone-abort',
]);
assert.equal(abortObservedPrefix, true, 'abort did not leave the committed worktree prefix inspectable');
assert.equal(failed.filesWritten, 5, 'partial checkout writes were not reported');

prepareDurable = false;
const directoryLimit = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  env,
  {
    op: 'clone',
    pid: 1,
    dir: '/directory-limit',
    url: 'https://example.invalid/repo.git',
    exclusiveDestination: true,
    exclusiveMutationRoot: 'directory-limit',
    mutationOwner: 'owner',
  },
);
assert.equal(directoryLimit.success, false);
assert.equal(directoryLimit.errorCode, 'FreshCheckoutDirectoryLimitError');

const callsBeforeExisting = calls.length;
const existing = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  env,
  {
    op: 'clone',
    pid: 1,
    dir: '/existing',
    url: 'https://example.invalid/repo.git',
    exclusiveDestination: true,
    exclusiveMutationRoot: 'existing',
    mutationOwner: 'owner',
  },
);
assert.equal(existing.success, false);
assert.match(existing.error, /already exists and is not an empty directory/);
assert.deepEqual(
  calls.slice(callsBeforeExisting).map(({ body }) => body.phase),
  ['clone-prepare'],
  'pre-mutation prepare failure must not invoke clone-abort',
);

let lateResponseDisposed = 0;
const lateEntrypoint = {
  async fetch() {
    await new Promise(resolve => setTimeout(resolve, 25));
    const response = Response.json({ success: true });
    Object.defineProperty(response, Symbol.dispose, {
      value() { lateResponseDisposed++; },
    });
    return response;
  },
};
const timedOut = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  { LOADER: { load: () => ({ getEntrypoint: () => lateEntrypoint }) } },
  {
    op: 'clone',
    pid: 1,
    dir: '/timeout',
    url: 'https://example.invalid/repo.git',
    timeout: 5,
    exclusiveDestination: true,
    exclusiveMutationRoot: 'timeout',
    mutationOwner: 'owner',
  },
);
assert.equal(timedOut.success, false);
assert.equal(timedOut.errorPhase, 'clone-prepare');
assert.equal(timedOut.errorCode, 'GitCloneBudgetExceeded');
const { elapsedMs: timedOutElapsed, ...timedOutBudget } = timedOut.budget;
assert.deepEqual(timedOutBudget, {
  phase: 'clone-prepare',
  chunksCompleted: 0,
  processedEntries: 0,
  decodedBytes: 0,
  limitMs: 5,
});
assert.ok(timedOutElapsed >= timedOut.budget.limitMs);
assert.match(timedOut.error, /clone budget exhausted after 0 chunks \/ 0 entries/);
await new Promise(resolve => setTimeout(resolve, 30));
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
      LOADER: {
        load: () => ({
          getEntrypoint: () => ({
            async fetch(request) {
              const body = await request.json();
              defaultBudgetCalls.push(body);
              if (body.phase === 'clone-prepare') {
                artificialNow = 290_000;
                return Response.json({
                  success: true,
                  prepared: {
                    jobId: body.jobId,
                    optionsHash: body.optionsHash,
                    dir: 'default-budget',
                    commit: '1'.repeat(40),
                    tree: '2'.repeat(40),
                    headRef: 'refs/heads/main',
                    packs: [],
                    packOnlyObjectStore: true,
                    metadata: [],
                  },
                  supervisorRpc: {},
                });
              }
              return Response.json({
                success: true,
                nextCursor: null,
                treeEntriesVisited: 1,
                decodedBytes: 1,
                indexEntries: 1,
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
      dir: '/default-budget',
      url: 'https://example.invalid/repo.git',
      exclusiveDestination: true,
      exclusiveMutationRoot: 'default-budget',
      mutationOwner: 'owner',
    },
  );
  assert.equal(defaultBudget.success, true, defaultBudget.error);
} finally {
  Date.now = originalNow;
}
assert.equal(defaultBudgetCalls[1].phase, 'clone-checkout');
assert.equal(defaultBudgetCalls[1].phaseDeadline, 290_000 + 240_000,
  'default clone budget starved a later checkout phase');

let throwingWorkerDisposed = 0;
const supervisorDisposalsBeforeEntrypointFailure = supervisorDisposeCount;
const entrypointFailure = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  {
    LOADER: {
      load() {
        return {
          getEntrypoint() { throw new Error('entrypoint unavailable'); },
          [Symbol.dispose]() { throwingWorkerDisposed++; },
        };
      },
    },
  },
  { op: 'fetch', pid: 1, dir: '/repo' },
);
assert.equal(entrypointFailure.success, false);
assert.equal(entrypointFailure.error, 'entrypoint unavailable');
assert.equal(throwingWorkerDisposed, 1, 'worker leaked when getEntrypoint threw');
assert.equal(supervisorDisposeCount, supervisorDisposalsBeforeEntrypointFailure + 1,
  'supervisor binding leaked when getEntrypoint threw');

console.log('git network facet clone protocol: ok');
