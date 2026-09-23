#!/usr/bin/env bun
// A streaming exec hands the caller stdout and stderr while the command runs,
// at the caller's pace, on every embedder surface: in process
// (`rpcExecStream`, what `composeHostedRuntime().execStream` is), and through
// the SDK over the remote HTTP API, whose body is the same encoded stream the
// Durable Object RPC returns.
//
// Before it, exec returned one string at exit. `seq 1 2000000` (14.9 MB) was
// held whole several times over in the session isolate: the shell alone kept
// every write for its return value even with a sink attached.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { encodeExecStream } from '../../packages/core/src/runtime/exec-stream.ts';
import { rpcExec, rpcExecStream } from '../../packages/worker/src/session/programmatic.ts';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1 });
const kernelFs = ws.vfs.as(CRED_KERNEL);
const rows = new Map();
const host = {
  _w1SessionDestroyed: false,
  env: {},
  ctx: {
    waitUntil: () => {},
    storage: {
      get: async (key) => rows.get(key),
      put: async (key, value) => { rows.set(key, value); },
      delete: async (key) => { rows.delete(key); },
    },
  },
  shell: ws.shell,
  shellProcessPid: ws.shellProcessPid,
  sqliteFs: ws.vfs,
  processes: ws.processes,
  portRegistry: { getAll: () => [] },
  facetManager: null,
  viteDevServer: null,
  cirrusReal: null,
  _cpRegistry: ws.registry,
  _viteShimPid: null,
  _viteShimPort: null,
  terminal: null,
  ensureSqliteFs() {},
  ensureFacetManager() {},
  ensureRuntimeReady() {},
};

const text = (bytes) => new TextDecoder().decode(bytes);
const settledYet = (promise) => Promise.race([
  promise.then(() => true, () => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 0)),
]);
const SEQ_2M_BYTES = 14_888_896;

// ── Output arrives before the command exits ────────────────────────────────
{
  const run = await rpcExecStream(host, 'echo first; sleep 0.3; echo second');
  const reader = run.output.getReader();
  const first = await reader.read();
  assert.deepEqual({ stream: first.value.stream, data: text(first.value.data) }, { stream: 'stdout', data: 'first\n' });
  assert.equal(await settledYet(run.exit), false, 'the first line arrived while the command was still running');
  const second = await reader.read();
  assert.equal(text(second.value.data), 'second\n');
  assert.equal((await reader.read()).done, true);
  assert.equal((await run.exit).exitCode, 0);
}

// ── stderr is its own stream; the exit code is the command's ───────────────
{
  const run = await rpcExecStream(host, 'echo out; echo err >&2; false');
  const seen = { stdout: '', stderr: '' };
  for await (const chunk of run.output) seen[chunk.stream] += text(chunk.data);
  assert.deepEqual(seen, { stdout: 'out\n', stderr: 'err\n' });
  const exit = await run.exit;
  assert.equal(exit.exitCode, 1);
  assert.equal(exit.success, false);
}

// ── A reader that stops reading stops the command ──────────────────────────
{
  await ws.exec('rm -f /home/user/after-seq');
  const run = await rpcExecStream(host, 'seq 1 2000000; touch /home/user/after-seq');
  const reader = run.output.getReader();
  let bytes = (await reader.read()).value.data.byteLength;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await kernelFs.exists('/home/user/after-seq'), false,
    'the command waits for the reader instead of running ahead into a buffer');
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.data.byteLength;
  }
  assert.equal(bytes, SEQ_2M_BYTES);
  assert.equal((await run.exit).exitCode, 0);
  assert.equal(await kernelFs.exists('/home/user/after-seq'), true);
}

// ── Cancelling the output kills the command and rejects exit ───────────────
{
  const run = await rpcExecStream(host, 'seq 1 100000000');
  const reader = run.output.getReader();
  await reader.read();
  const pid = host.processes.getAll().find((p) => p.command === 'seq 1 100000000' && p.state === 'running')?.pid;
  assert.ok(pid, 'the command is running while its output is read');
  await reader.cancel(new Error('caller gave up'));
  await assert.rejects(run.exit, /caller gave up/);
  for (let i = 0; i < 100 && host.processes.get(pid)?.state === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.notEqual(host.processes.get(pid)?.state, 'running', 'the cancelled command stopped');
}

// ── timeoutMs ends the command with 124 and says so on stderr ──────────────
{
  const run = await rpcExecStream(host, 'sleep 5', { timeoutMs: 100 });
  let stderr = '';
  for await (const chunk of run.output) if (chunk.stream === 'stderr') stderr += text(chunk.data);
  assert.equal((await run.exit).exitCode, 124);
  assert.match(stderr, /timed out after 100ms/);
}

// ── The buffered exec reads the same stream ────────────────────────────────
{
  const result = await rpcExec(host, 'echo out; echo err >&2');
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'err\n');
  assert.equal(result.exitCode, 0);
}

// ── The SDK over the remote API: HTTP body in, typed chunks out ────────────
{
  const env = {
    NIMBUS_SESSION: {
      idFromName: (name) => ({ name }),
      get: () => ({
        _rpcReady: async () => ({ ok: true, preinstalled: [] }),
        _rpcExecStream: async (command, options) => encodeExecStream(await rpcExecStream(host, command, options)),
      }),
    },
  };
  const box = Nimbus.connect({
    endpoint: 'https://nimbus.test',
    fetch: async (url, init) => (await handleNimbusRemoteApi(
      new Request(url, init),
      env,
      { remote: { enabled: true, allowLegacy: true } },
    )) ?? new Response('not found', { status: 404 }),
  }).sandbox('remote-stream');

  const run = await box.execStream('seq 1 2000000; echo done >&2');
  let stdoutBytes = 0;
  let stderr = '';
  for await (const chunk of run.output) {
    if (chunk.stream === 'stdout') stdoutBytes += chunk.data.byteLength;
    else stderr += text(chunk.data);
  }
  assert.equal(stdoutBytes, SEQ_2M_BYTES, 'every byte crossed the wire');
  assert.equal(stderr, 'done\n');
  assert.equal((await run.exit).exitCode, 0);

  const buffered = await box.exec('echo hi; echo there >&2; false');
  assert.deepEqual(
    { stdout: buffered.stdout, stderr: buffered.stderr, exitCode: buffered.exitCode },
    { stdout: 'hi\n', stderr: 'there\n', exitCode: 1 },
  );

  await assert.rejects(box.execStream('pwd', { shellId: '!bad' }),
    'a refused call rejects execStream itself, before any stream exists');
}

console.log('exec-stream: all assertions passed');
