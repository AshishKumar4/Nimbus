#!/usr/bin/env bun
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
