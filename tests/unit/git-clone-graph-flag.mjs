#!/usr/bin/env bun
// What clone-finish is told of a clone's commit-graph records (audit GIT-8),
// through the network facet's clone against stubbed phases: they make its
// commit-graph only for a full clone whose every history step parsed every
// commit's record. A refusal in the commits piece's first step, or in a
// continuation after steps that were fine, and the records go
// (commitGraph: false); a shallow clone's go as well.

import assert from 'node:assert/strict';

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { execGitNetwork } from '../../packages/worker/src/git/network-facet.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({ SupervisorRPC: () => ({ async stdout() {}, [Symbol.dispose]() {} }) });
const ACCOUNTED = { filesWritten: 0, bytesWritten: 0, supervisorRpc: {} };

/** A clone whose commits piece answers its steps refusing as `refusals` says (one per step, the last final); clone-finish's commitGraph. */
async function finishedWith(refusals, depth) {
  let finished;
  const entrypoint = {
    async fetch(request) {
      const body = await request.json();
      const answer = (result) => Response.json({ success: true, ...ACCOUNTED, ...result });
      switch (body.phase) {
        case 'clone-prepare':
          return answer({ prepared: { fast: {
            commit: '1'.repeat(40), tree: '2'.repeat(40), headRef: 'refs/heads/main', capabilities: ['filter', 'allow-reachable-sha1-in-want'],
            batches: [{ index: 0, blobs: 1, paths: 1, bytes: 22 }], planEntries: 1, planBytes: 32,
            shares: [{ name: 'index-gitlinks', bytes: 0 }], cacheTreeBytes: 0, partial: false, packs: [], tags: [],
          } } });
        case 'clone-batch':
          return answer({ batch: { index: body.batch.index, blobs: 1, files: 1, indexBytes: 70, pack: null } });
        case 'clone-history': {
          const { history } = body;
          if (history.step === 'plan') return answer({ history: { batches: [] } });
          const part = history.step === 'resume' ? history.part : 0;
          const last = part === refusals.length - 1;
          return answer({ history: {
            kind: history.kind, pack: last ? { objects: 1, packBytes: 1 } : null, pending: last ? null : { tmpName: `p${part}` },
            lists: [], graphRefused: history.kind === 'commits' && refusals[part], tagsFound: [],
          } });
        }
        case 'clone-finish':
          finished = body.commitGraph;
          return answer({});
        default:
          throw new Error(`unexpected phase ${body.phase}`);
      }
    },
  };
  const env = { ASSETS: stagedAssets, LOADER: { load: () => ({ getEntrypoint: () => entrypoint }) } };
  const result = await execGitNetwork({ id: { toString: () => 'graph-flag' } }, env, {
    op: 'clone', pid: 1, dir: '/repo', url: 'https://example.invalid/repo.git',
    exclusiveDestination: true, exclusiveMutationRoot: 'repo', mutationOwner: 'owner', ...(depth === undefined ? {} : { depth }),
  }, ISOLATE_NETWORK);
  assert.equal(result.success, true, result.error);
  return finished;
}

assert.equal(await finishedWith([false]), true, 'a full clone whose records all parsed: they make its commit-graph');
assert.equal(await finishedWith([false, false, false]), true, 'over continuations too');
assert.equal(await finishedWith([true]), false, 'a refusal in the first step: the records go');
assert.equal(await finishedWith([false, true, false]), false, 'a refusal in a continuation, steps after it fine: the records go');
assert.equal(await finishedWith([false], 2), false, "a shallow clone's records go, though every one parsed");
console.log('ok - git-clone-graph-flag (clone-finish keeps the commit-graph records of a full clone none refused, and only then)');
