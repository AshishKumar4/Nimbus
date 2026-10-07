#!/usr/bin/env bun
// sleep ends with the status of the signal that aborted it, through the one
// abort-to-status mapping (exitCodeForAbortSignal): 143 for a SIGTERM, 130
// for a plain abort (Ctrl-C). It hand-rolled its own timer race and answered
// 130 whatever the signal; bash and cpython's runners and node's realm read
// the same mapping now, where they had a literal 130.
import assert from 'node:assert/strict';
import sleep from '../../packages/core/src/substrate/lifo/commands/system/sleep.ts';
import { signalAbortReason } from '../../packages/core/src/substrate/lifo/shell/signals.ts';

async function sleepUntil(abort) {
  const controller = new AbortController();
  const done = sleep({ args: ['30'], signal: controller.signal, stderr: { write() {} } });
  setTimeout(() => abort(controller), 10);
  return await done;
}

assert.equal(await sleepUntil((c) => c.abort(signalAbortReason('TERM'))), 143);
assert.equal(await sleepUntil((c) => c.abort(signalAbortReason('INT'))), 130);
assert.equal(await sleepUntil((c) => c.abort()), 130);
assert.equal(await sleep({ args: ['0.01'], signal: new AbortController().signal, stderr: { write() {} } }), 0);
const aborted = new AbortController();
aborted.abort(signalAbortReason('KILL'));
assert.equal(await sleep({ args: ['5'], signal: aborted.signal, stderr: { write() {} } }), 137);
console.log('sleep-abort-status: ok');
