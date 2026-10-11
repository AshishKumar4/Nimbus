#!/usr/bin/env bun
// A module snapshot has a data cursor, not a listed namespace. If listing
// fails afterwards, its real failure must survive boot and reach the caller.
import assert from 'node:assert/strict';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';

const store = new Function(FACET_RESIDENT_STORE_SOURCE + '\nreturn { __residentBindInMemory, __residentBoot, __residentRequireNamespace, __nsReady };')();
store.__residentBindInMemory(1 << 20);
const reason = 'Subrequest depth limit exceeded: fixture listing was not delivered';
let listings = 0;
const supervisor = {
  fsList: async () => { listings++; throw new Error(reason); },
  fsReadBatch: async () => [],
};
const boot = await store.__residentBoot(() => ({}), { epoch: 'snapshot', rev: 7 }, supervisor, 0);
assert.equal(store.__nsReady(), false, 'the module cursor never substitutes for a namespace');
assert.match(boot.failure ?? '', /Subrequest depth limit exceeded/, 'boot preserves a failed listing instead of a synthetic admission cause');
const failed = await store.__residentRequireNamespace(supervisor, boot.failure);
assert.match(failed, /Subrequest depth limit exceeded/);
assert.doesNotMatch(failed, /change reported without the stat/, 'no nonexistent change is blamed for a failed RPC');
assert.equal(listings, 2, 'the last launch check performs one existing repair attempt');
console.log('resident-namespace-boot-failure: synthetic cursor stays unlisted and actual listing failure is reported');
