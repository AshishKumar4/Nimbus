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

const supervisor = {
  async stdout() {},
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
      filesWritten: 2,
      bytesWritten: 6,
      supervisorRpc: { writeBatchStream: 1 },
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
assert.equal(calls.length, 2, 'clone must use separate prepare and checkout invocations');
assert.notEqual(calls[0].url, calls[1].url, 'phase invocations need distinct trace markers');
assert.match(calls[0].url, /\/git\/clone-prepare\//);
assert.match(calls[1].url, /\/git\/clone-checkout\//);
assert.equal(calls[0].body.jobId, calls[1].body.jobId);
assert.equal(calls[0].body.optionsHash, calls[1].body.optionsHash);
assert.ok(Number.isSafeInteger(calls[0].body.phaseDeadline));
assert.ok(Number.isSafeInteger(calls[1].body.phaseDeadline));
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
assert.equal(result.filesWritten, 6);
assert.equal(result.bytesWritten, 24);
assert.equal(result.supervisorRpc.writeBatchStream, 2);

const callsBeforeFailure = calls.length;
prepareDurable = false;
const failed = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  env,
  {
    op: 'clone',
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

const callsBeforeExisting = calls.length;
const existing = await execGitNetwork(
  { id: { toString: () => 'test-do' } },
  env,
  {
    op: 'clone',
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
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(lateResponseDisposed, 1, 'timeout-loser response leaked its RPC stub');

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
  { op: 'fetch', dir: '/repo' },
);
assert.equal(entrypointFailure.success, false);
assert.equal(entrypointFailure.error, 'entrypoint unavailable');
assert.equal(throwingWorkerDisposed, 1, 'worker leaked when getEntrypoint threw');
assert.equal(supervisorDisposeCount, supervisorDisposalsBeforeEntrypointFailure + 1,
  'supervisor binding leaked when getEntrypoint threw');

console.log('git network facet clone protocol: ok');
