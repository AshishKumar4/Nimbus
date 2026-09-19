#!/usr/bin/env bun
// curl and wget are bound to their workspace's kernel: the same numeric port
// answers differently in two workspaces, a redirect that lands on loopback
// is classified and served locally rather than fetched, and nothing listens
// means refused — never an external attempt. These two properties are what
// keep an embedder holding two workspaces from leaking one into the other.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const openWorkspace = (options = {}) => {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  return NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, ...options });
};

// ── The same port answers differently in two workspaces ───────────────────
{
  const ws1 = await openWorkspace();
  const ws2 = await openWorkspace();

  ws1.kernel.portRegistry.set(8080, (_req, res) => {
    res.statusCode = 200;
    res.headers = { 'content-type': 'text/plain' };
    res.body = 'A';
  });
  ws2.kernel.portRegistry.set(8080, (_req, res) => {
    res.statusCode = 200;
    res.body = 'B';
  });

  const a = await ws1.exec('curl -s http://localhost:8080/');
  const b = await ws2.exec('curl -s http://localhost:8080/');
  assert.equal(a.exitCode, 0, a.stderr);
  assert.equal(b.exitCode, 0, b.stderr);
  assert.equal(a.stdout.trim(), 'A');
  assert.equal(b.stdout.trim(), 'B');
}

// ── A redirect onto loopback is classified and served locally ─────────────
{
  const ws = await openWorkspace();
  ws.kernel.portRegistry.set(8080, (_req, res) => {
    res.statusCode = 302;
    res.headers = { location: 'http://localhost:8081/target' };
    res.body = '';
  });
  ws.kernel.portRegistry.set(8081, (_req, res) => {
    res.statusCode = 200;
    res.body = 'LOCAL';
  });

  let fetched = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetched++; return origFetch(...args); };
  try {
    // wget follows redirects by default; the hop onto loopback is classified
    // and served by 8081's in-kernel handler.
    const first = await ws.exec('wget -q -O /tmp/first.txt http://localhost:8080/');
    assert.equal(first.exitCode, 0, `unexpected: ${JSON.stringify(first)}`);
    assert.equal(ws.vfs.as(CRED_KERNEL).readFileString('/tmp/first.txt'), 'LOCAL');

    // curl -L walks the hop through the kernel: 8081 answers locally.
    const followed = await ws.exec('curl -sL http://localhost:8080/');
    assert.equal(followed.exitCode, 0, followed.stderr);
    assert.equal(followed.stdout.trim(), 'LOCAL');
    assert.equal(fetched, 0, 'a loopback redirect hop reached external fetch');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── Nothing listens: refused, never fetched ────────────────────────────────
{
  const ws = await openWorkspace();
  let fetched = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetched++; return origFetch(...args); };
  try {
    const curl = await ws.exec('curl -s http://localhost:9999/');
    assert.equal(curl.exitCode, 7);
    assert.match(curl.stderr, /Failed to connect/);

    const wget = await ws.exec('wget -q http://localhost:9999/');
    assert.equal(wget.exitCode, 1);
    assert.match(wget.stderr, /unable to connect/);
    assert.equal(fetched, 0, 'a refused loopback request reached external fetch');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── routeLoopback is the second hop source, still per-kernel ──────────────
{
  const routed = [];
  const ws = await openWorkspace();
  // The host owns the router — the worker sets it after create the same way.
  ws.kernel.routeLoopback = async (port, request) => {
    routed.push(port);
    return new Response(`routed-${port}`);
  };
  const got = await ws.exec('curl -s http://localhost:7777/');
  assert.equal(got.exitCode, 0, got.stderr);
  assert.equal(got.stdout.trim(), 'routed-7777');
  assert.deepEqual(routed, [7777]);
}

// ── routeLoopback sees the caller's abort, never an external fetch ─────────
// (Exercised at the command seam: ctx.signal is what the workspace's command
// dispatch hands curl — ws.exec's RunOptions.signal is the host's own path.)
{
  const { createCurlCommand } = await import('../../packages/core/src/substrate/lifo/commands/net/curl.ts');
  const ws = await openWorkspace();
  let observed;
  ws.kernel.routeLoopback = (port, request) => new Promise((resolve) => {
    request.signal.addEventListener('abort', () => { observed = request.signal; }, { once: true });
    setTimeout(() => resolve(new Response('late')), 5000);
  });
  let fetched = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetched++; return origFetch(...args); };
  try {
    const controller = new AbortController();
    const out = [];
    const curl = createCurlCommand(ws.kernel);
    const pending = curl({
      args: ['-s', 'http://localhost:8888/'],
      env: {},
      cwd: '/home/user',
      vfs: ws.vfs.as(CRED_KERNEL),
      stdout: { write: (s) => out.push(['out', s]) },
      stderr: { write: (s) => out.push(['err', s]) },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const exitCode = await pending;
    assert.equal(observed?.aborted, true, 'routeLoopback never saw the caller abort');
    assert.equal(exitCode, 130, JSON.stringify(out));
    assert.equal(fetched, 0, 'an aborted loopback hop reached external fetch');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ── --max-time aborts a parked local request the same way ──────────────────
{
  const { createCurlCommand } = await import('../../packages/core/src/substrate/lifo/commands/net/curl.ts');
  const ws = await openWorkspace();
  let observed;
  ws.kernel.routeLoopback = (port, request) => new Promise((resolve) => {
    request.signal.addEventListener('abort', () => { observed = request.signal; }, { once: true });
    setTimeout(() => resolve(new Response('late')), 5000);
  });
  const out = [];
  const curl = createCurlCommand(ws.kernel);
  const exitCode = await curl({
    args: ['-s', '--max-time', '0.2', 'http://localhost:8889/'],
    env: {},
    cwd: '/home/user',
    vfs: ws.vfs.as(CRED_KERNEL),
    stdout: { write: (s) => out.push(['out', s]) },
    stderr: { write: (s) => out.push(['err', s]) },
    signal: new AbortController().signal,
  });
  assert.equal(observed?.aborted, true, 'routeLoopback never saw the --max-time abort');
  assert.equal(exitCode, 7);
  assert.match(out.filter(([ch]) => ch === 'err').map(([, s]) => s).join(''), /timed out/i);
}
// ── An external redirect into loopback is served in-kernel or refused ──────
{
  const ws = await openWorkspace();
  ws.kernel.portRegistry.set(8081, (_req, res) => {
    res.statusCode = 200;
    res.body = 'LOCAL';
  });
  let fetches = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    return new Response('', { status: 302, headers: { location: 'http://localhost:8081/' } });
  };
  try {
    const followed = await ws.exec('curl -sL http://ext.test/redir');
    assert.equal(followed.exitCode, 0, followed.stderr);
    assert.equal(followed.stdout.trim(), 'LOCAL');
    assert.equal(fetches, 1, 'the loopback redirect hop reached external fetch');
  } finally {
    globalThis.fetch = origFetch;
  }

  globalThis.fetch = async () => {
    fetches++;
    return new Response('', { status: 302, headers: { location: 'http://localhost:9999/' } });
  };
  try {
    const refused = await ws.exec('curl -sL http://ext.test/redir');
    assert.equal(refused.exitCode, 7);
    assert.match(refused.stderr, /Failed to connect/);
    assert.equal(fetches, 2, 'a refused redirect hop reached external fetch');

    const wget = await ws.exec('wget -q -O /tmp/x http://ext.test/redir');
    assert.equal(wget.exitCode, 1);
    assert.equal(fetches, 3, "wget's refused redirect hop reached external fetch");
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log('nimbus-workspace-net: all assertions passed');
