#!/usr/bin/env bun
// Behavior test: the generated Node fetch shim routes in-session loopback
// requests through the supervisor. A facet's fetch to 127.0.0.1/localhost:<port>
// must be handed to SUPERVISOR.routeLoopback (which forwards to the facet owning
// <port> via the port registry) so one facet can reach another facet's server —
// e.g. `opencode attach` → `opencode serve`. Everything non-loopback falls
// through to real fetch with the Node default UA preserved.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/worker/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const routed = [];
const supervisor = {
  routeLoopback: (port, request) => {
    routed.push({ port, url: request.url, method: request.method });
    return new Response('served', { status: 200, headers: { 'X-Served-By': 'loopback' } });
  },
};

// Stub the origin fetch BEFORE the shim binds __origFetch, so non-loopback
// requests are captured here instead of hitting the network.
const originCalls = [];
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const ua = init?.headers ? new Headers(init.headers).get('user-agent') : null;
  originCalls.push({ url, ua });
  return Promise.resolve(new Response('origin', { status: 299 }));
};

const code = generateShimsCode();
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + code + '\n;return null;',
);
factory(
  {}, {}, {}, {}, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);

// ── loopback via 127.0.0.1 is routed to the supervisor ───────────────────────
{
  const res = await globalThis.fetch('http://127.0.0.1:4096/doc');
  assert.equal(res.status, 200, 'loopback fetch served by routeLoopback');
  assert.equal(res.headers.get('X-Served-By'), 'loopback');
  assert.equal(await res.text(), 'served');
  assert.equal(routed[0].port, 4096, 'the target port is threaded to routeLoopback');
  assert.equal(new URL(routed[0].url).pathname, '/doc');
}

// ── loopback via localhost is routed too ─────────────────────────────────────
{
  await globalThis.fetch('http://localhost:5000/session?x=1', { method: 'POST' });
  assert.equal(routed[1].port, 5000);
  assert.equal(routed[1].method, 'POST');
}

// ── a Request object to loopback is routed ───────────────────────────────────
{
  await globalThis.fetch(new Request('http://127.0.0.1:4096/event'));
  assert.equal(routed[2].port, 4096);
  assert.equal(new URL(routed[2].url).pathname, '/event');
}

// ── non-loopback falls through to real fetch with the Node UA ────────────────
{
  const res = await globalThis.fetch('https://api.anthropic.com/v1/models');
  assert.equal(res.status, 299, 'external fetch went to the origin, not the loopback router');
  assert.equal(originCalls.at(-1).ua, 'node', 'Node default UA injected on the passthrough');
  assert.equal(routed.length, 3, 'external host was NOT routed as loopback');
}

console.log('ok: fetch shim routes loopback via SUPERVISOR.routeLoopback, passes external through');
