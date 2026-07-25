#!/usr/bin/env bun
// execSync / execFileSync must refuse, not lie.
//
// Their Node contract is to RETURN the child's stdout, which is only
// meaningful once the child has run to completion. A facet has no
// synchronous I/O primitive — every path to a child process is an async
// supervisor RPC and JS in workerd cannot block on one — so the pre-fix shim
// started an async spawn and returned an empty, not-yet-populated result
// object. Callers shell out precisely because they need the answer NOW, so
// they read a blank stdout, or run their next step before the child has
// started, and report success.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__pendingIO',
  '"use strict";' + generateShimsCode() + '\n;return __childProcessMod;',
);
const cp = factory(
  {}, {}, {}, {}, {},
  { cpSpawn: async () => ({ childPid: 7 }) },
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user', [],
);

function refusal(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

for (const [name, call] of [
  ['execSync', () => cp.execSync('git rev-parse HEAD')],
  ['execFileSync', () => cp.execFileSync('git', ['rev-parse', 'HEAD'])],
]) {
  const err = refusal(call);
  assert.ok(err instanceof Error, `${name} must throw rather than return a result that is not the child's output`);
  assert.equal(err.code, 'ERR_NIMBUS_SYNC_CHILD_PROCESS', `${name} carries an identifiable code`);
  // Actionable: what is unsupported, why, and what to use instead.
  assert.match(err.message, new RegExp(`child_process\\.${name}`));
  assert.match(err.message, /no synchronous I\/O primitive/);
  assert.match(err.message, /exec\/execFile\/spawn/);
  // The command is named so the failure points at the offending call site.
  assert.match(err.message, /git rev-parse HEAD/);
}

// The async surface is unaffected — it is the documented replacement.
for (const name of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync']) {
  assert.equal(typeof cp[name], 'function', `child_process.${name} stays available`);
}

console.log('ok - node-shims-sync-child-process');
