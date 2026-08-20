#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { execGitNetwork } from '../../packages/worker/src/git/network-facet.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

const supervisor = { [Symbol.dispose]() {} };
const boundProps = [];
adoptCtxExports({
  SupervisorRPC(options) {
    boundProps.push(options.props);
    return supervisor;
  },
});

const entrypoint = {
  async fetch() {
    return Response.json({
      success: true,
      filesWritten: 0,
      bytesWritten: 0,
      supervisorRpc: {},
      metadataOverlay: {},
    });
  },
  [Symbol.dispose]() {},
};
const worker = {
  getEntrypoint() { return entrypoint; },
  [Symbol.dispose]() {},
};
const env = { LOADER: { load() { return worker; } } };
const ctx = { id: { toString: () => 'git-identity-test' } };

for (const pid of [undefined, 0, -1, 1.5]) {
  const result = await execGitNetwork(ctx, env, {
    op: 'fetch',
    dir: '/home/user/repo',
    pid,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /positive process pid/);
}
assert.deepEqual(boundProps, [], 'invalid process identities must not mint a supervisor binding');

const result = await execGitNetwork(ctx, env, {
  op: 'fetch',
  dir: '/home/user/repo',
  pid: 42,
});
assert.equal(result.success, true, result.error);
assert.deepEqual(boundProps, [{ doId: 'git-identity-test', pid: 42, mutationOwner: undefined }]);

console.log('git network facet process identity: ok');
