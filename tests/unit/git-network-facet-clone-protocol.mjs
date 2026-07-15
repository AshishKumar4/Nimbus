import assert from 'node:assert/strict';

import { execGitNetwork } from '../../packages/worker/src/git/network-facet.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';

const calls = [];
let prepareDurable = false;
let loadCount = 0;
let entrypointCount = 0;
let committedFailurePrefix = false;
let abortObservedPrefix = false;

const supervisor = {
  async stdout() {},
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

console.log('git network facet clone protocol: ok');
