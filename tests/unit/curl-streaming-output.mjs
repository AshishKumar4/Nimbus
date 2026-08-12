#!/usr/bin/env bun
// Behavior test: the shell `curl` streams a loopback response body to stdout
// as chunks arrive, instead of buffering to stream-end.
//
// Root cause this guards against (live-diagnosed 2026-07-16): curl's loopback
// path did `await response.text()` before writing anything, so an SSE /
// chunked body (a facet server's live event stream) rendered as one batched
// flush when the server closed the stream — `curl -N http://127.0.0.1:<port>`
// against a live SSE endpoint showed nothing until the stream ended.

import assert from 'node:assert/strict';
import { createCurlCommand } from '../../packages/core/src/substrate/lifo/commands/net/curl.ts';

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx(args) {
  const writes = [];
  return {
    writes,
    ctx: {
      args,
      env: {},
      cwd: '/home/user',
      vfs: { writeFile: () => { throw new Error('no file output expected'); } },
      stdout: { write: (s) => writes.push(s) },
      stderr: { write: (s) => writes.push('[err]' + s) },
      signal: new AbortController().signal,
    },
  };
}

// ── loopback SSE streams incrementally ───────────────────────────────────────
{
  let push, close;
  const body = new ReadableStream({
    start(c) {
      push = (s) => c.enqueue(enc.encode(s));
      close = () => c.close();
    },
  });
  const kernel = {
    portRegistry: { get: () => undefined },
    routeLoopback: async (port, request) => {
      assert.equal(port, 8080);
      assert.equal(new URL(request.url).pathname, '/events');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  };
  const curl = createCurlCommand(kernel);
  const { ctx, writes } = makeCtx(['-sN', 'http://127.0.0.1:8080/events']);

  const exitPromise = curl(ctx);
  // Wait for the command to reach the read loop, then feed tick 1.
  await sleep(20);
  push('data: tick1\n\n');
  await sleep(20);
  assert.deepEqual(writes, ['data: tick1\n\n'], 'tick1 reached stdout while the stream is still open');

  push('data: tick2\n\n');
  await sleep(20);
  assert.deepEqual(writes, ['data: tick1\n\n', 'data: tick2\n\n'], 'tick2 arrived as its own write');

  close();
  assert.equal(await exitPromise, 0, 'curl exits 0 once the stream closes');
}

// ── Ctrl-C (ctx.signal) cancels a live stream read ───────────────────────────
{
  let push;
  const body = new ReadableStream({ start(c) { push = (s) => c.enqueue(enc.encode(s)); } });
  const kernel = {
    portRegistry: { get: () => undefined },
    routeLoopback: async () => new Response(body, { status: 200 }),
  };
  const curl = createCurlCommand(kernel);
  const abort = new AbortController();
  const { ctx, writes } = makeCtx(['-sN', 'http://127.0.0.1:8080/events']);
  ctx.signal = abort.signal;

  const exitPromise = curl(ctx);
  await sleep(20);
  push('data: one\n\n');
  await sleep(20);
  assert.deepEqual(writes, ['data: one\n\n']);
  abort.abort();
  assert.equal(await exitPromise, 0, 'aborting the signal releases the read loop');
}

console.log('curl-streaming-output: ok');
