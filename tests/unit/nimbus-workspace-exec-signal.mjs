#!/usr/bin/env bun
// NimbusWorkspace.exec forwards RunOptions.signal/timeout into the command's
// own AbortSignal: an active call aborts, a timeout aborts, a queued call on
// an already-aborted signal answers 130 without running, and the workspace
// still runs commands afterwards. Before the forwarding fix the caller's
// signal died in a detached controller and every one of these hung or ran.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';

const openWorkspace = () => {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  return NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
};

const ws = await openWorkspace();

// ── An active call aborts on the caller's signal ────────────────────────────
{
  const controller = new AbortController();
  const started = Date.now();
  const pending = ws.exec('sleep 30', { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  assert.ok(Date.now() - started < 10_000, 'sleep outlived the caller abort');
  assert.notEqual(result.exitCode, 0, 'an aborted command reported success');
}

// ── timeout: aborts the same way ────────────────────────────────────────────
{
  const started = Date.now();
  const result = await ws.exec('sleep 30', { timeout: 80 });
  assert.ok(Date.now() - started < 10_000, 'sleep outlived the exec timeout');
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
