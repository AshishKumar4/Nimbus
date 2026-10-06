#!/usr/bin/env bun
// NimbusWorkspace.exec forwards RunOptions.signal/timeout into the command's
// own AbortSignal: an active call aborts, a timeout aborts, a queued call on
// an already-aborted signal answers 130 without running, and the workspace
// still runs commands afterwards. Before the forwarding fix the caller's
// signal died in a detached controller and every one of these hung or ran.

import assert from 'node:assert/strict';
import { openWorkspace } from './lib/test-box.mjs';


const ws = await openWorkspace();

// The commands sleep an hour; a call that was not aborted fails the guard, a
// minute on, rather than being timed.
function ended(pending, what) {
  let guard;
  return Promise.race([
    pending,
    new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(what)), 60_000); }),
  ]).finally(() => clearTimeout(guard));
}

// ── An active call aborts on the caller's signal ────────────────────────────
{
  const controller = new AbortController();
  const pending = ws.exec('sleep 3600', { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await ended(pending, 'sleep outlived the caller abort');
  assert.notEqual(result.exitCode, 0, 'an aborted command reported success');
}

// ── timeout: aborts the same way ────────────────────────────────────────────
{
  const result = await ended(ws.exec('sleep 3600', { timeout: 80 }), 'sleep outlived the exec timeout');
  assert.notEqual(result.exitCode, 0, 'a timed-out command reported success');
}

// ── A call queued on an already-aborted signal answers 130, never runs ──────
{
  const controller = new AbortController();
  controller.abort();
  const result = await ws.exec('printf "should-never-run"', { signal: controller.signal });
  assert.equal(result.exitCode, 130);
  assert.equal(result.stdout, '', 'a pre-aborted call still produced output');
}

// ── The workspace still executes after aborts ───────────────────────────────
{
  const result = await ws.exec('printf "still-alive"');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'still-alive');
}

console.log('nimbus-workspace-exec-signal: all assertions passed');
