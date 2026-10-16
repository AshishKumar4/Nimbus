#!/usr/bin/env bun
// @tier quiet-cpu — asserts a 1.5 s deadline ends the wait within 2.5 s of wall time
// tests/differential/lib/apps.mjs page(): how the interpreter differential
// and its speed benchmark wait for a dev server's page. It is bounded by a
// wall-clock deadline whatever the server does, says what the server last
// answered when the page never came, and tells the latency of the request
// that rendered apart from the time it took to get there.

import assert from 'node:assert/strict';

import { page } from '../differential/lib/apps.mjs';

let requests = 0;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    requests++;
    if (pathname === '/broken') return new Response('compile error in page', { status: 500 });
    // Answers 500 once, then sends headers and a body that stalls: the stall ends the wait, the 500 is what it names.
    if (pathname === '/stalls') {
      if (requests === 1) return new Response('compile error in page', { status: 500 });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<p>')); } }));
    }
    // Renders on the third request, as a dev server does once its first compile ends.
    if (pathname === '/compiling') return requests >= 3 ? new Response('<p>rendered-marker</p>') : new Response('<p>placeholder</p>');
    return new Response('not found', { status: 404 });
  },
});

try {
  {
    requests = 0;
    const started = performance.now();
    const error = await page(server.port, '/broken', 'rendered-marker', 1_500).then(() => null, (e) => e);
    const elapsed = performance.now() - started;
    assert.ok(error instanceof Error, 'a page that never renders is an error');
    assert.match(error.message, /within 1500 ms/);
    assert.match(error.message, /500 compile error in page/, 'the error names the last answer');
    assert.ok(elapsed < 2_500, `the deadline bounds the wait: ${elapsed.toFixed(0)} ms`);
  }
  {
    requests = 0;
    const error = await page(server.port, '/stalls', 'rendered-marker', 1_500).then(() => null, (e) => e);
    assert.ok(error instanceof Error);
    assert.match(error.message, /within 1500 ms/, 'a stalled body ends the wait at the deadline, as an answer that never came');
    assert.match(error.message, /500 compile error in page/, 'the error still names the last answer the server gave');
  }
  {
    requests = 0;
    const rendered = await page(server.port, '/compiling', 'rendered-marker', 10_000);
    assert.equal(rendered.body, '<p>rendered-marker</p>');
    assert.equal(rendered.attempts, 3);
    assert.ok(rendered.readyMs >= rendered.latencyMs, JSON.stringify(rendered));
    assert.ok(rendered.readyMs >= 900, `two refused attempts and their pauses come before the render: ${JSON.stringify(rendered)}`);
  }
} finally {
  server.stop(true);
}
console.log('ok - differential-page-readiness: bounded, diagnosed, latency apart from time to ready');
