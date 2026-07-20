#!/usr/bin/env bun
// Server-shaped `node <file>` scripts must be PROMOTED to the keyed
// long-running facet (facetMgr.spawnNode) instead of the one-shot exec facet.
//
// Why it matters: only the keyed long-running facet exposes a
// NimbusLoadedEntrypoint route stub that PortRegistry.routeRequest can
// re-resolve in a LATER request's context. The one-shot exec facet is
// LOADER.load (unkeyed) and its stub cannot be re-entered across requests, so a
// port it binds is never reachable (external /port/<n> and loopback curl 501).
// This pins the routing DECISION so a regression can't quietly send servers
// back to the unreachable one-shot path.

import assert from 'node:assert/strict';
import { looksLikeServer, runFresh } from '../../packages/worker/src/runtime/node-runner.ts';

// ── looksLikeServer signal ───────────────────────────────────────────────────
for (const src of [
  `const http = require('http'); http.createServer((q,s)=>s.end('hi')).listen(5000);`,
  `require('http').createServer(h).listen(8765, '0.0.0.0');`,
  `const app = require('express')(); app.listen(3000);`,
  `import { serve } from './x'; Bun.serve({ port: 4000, fetch() {} });`,
  `net.createServer(onConn).listen(9000);`,
]) {
  assert.equal(looksLikeServer(src), true, `should detect server: ${src.slice(0, 40)}`);
}
for (const src of [
  `console.log('build done'); process.exit(0);`,
  `const x = 1 + 2; require('fs').writeFileSync('/tmp/o', String(x));`,
  `for (const f of files) transform(f); // preserve, deserve, observer`,
  `const s = "the server listens"; console.log(s);`, // prose, not a call
]) {
  assert.equal(looksLikeServer(src), false, `should NOT detect server: ${src.slice(0, 40)}`);
}

// ── runFresh routing decision (behaviour through the public entry) ────────────
function makeFacetMgr() {
  const calls = { exec: [], spawnNode: [] };
  return {
    calls,
    async exec(code, opts) {
      calls.exec.push({ code, opts });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async spawnNode(code, opts) {
      calls.spawnNode.push({ code, opts });
      return { pid: 4242, facetStub: {} };
    },
  };
}

const SERVER = `require('http').createServer((q,s)=>s.end('hello-from-http-server\\n')).listen(5000);`;
const PLAIN = `console.log('one-shot'); process.exit(0);`;

// server script (no --watch) → promoted to spawnNode
{
  const fm = makeFacetMgr();
  const r = await runFresh(fm, SERVER, { argv: [], filename: '/home/user/server.js' });
  assert.equal(fm.calls.spawnNode.length, 1, 'server script routes to spawnNode');
  assert.equal(fm.calls.exec.length, 0, 'server script does NOT hit the one-shot exec facet');
  assert.equal(r.longRunning, true);
  assert.equal(r.spawnedPid, 4242);
}

// plain script → stays on the one-shot exec fast path
{
  const fm = makeFacetMgr();
  const r = await runFresh(fm, PLAIN, { argv: [], filename: '/home/user/build.js' });
  assert.equal(fm.calls.exec.length, 1, 'plain script stays on exec');
  assert.equal(fm.calls.spawnNode.length, 0, 'plain script is not promoted');
  assert.equal(r.longRunning, false);
}

// .bin wrapper (skipSpawn) with server-shaped code → NOT promoted (stays exec)
{
  const fm = makeFacetMgr();
  await runFresh(fm, SERVER, { argv: [], filename: '/home/user/node_modules/.bin/x', skipSpawn: true, callerPid: 9 });
  assert.equal(fm.calls.exec.length, 1, 'skipSpawn CLI keeps the one-shot fast path');
  assert.equal(fm.calls.spawnNode.length, 0, 'skipSpawn CLI is not promoted');
}

// explicit --watch on a plain script → still long-running (argv signal preserved)
{
  const fm = makeFacetMgr();
  await runFresh(fm, PLAIN, { argv: ['--watch'], filename: '/home/user/build.js' });
  assert.equal(fm.calls.spawnNode.length, 1, '--watch still forces the long-running path');
  assert.equal(fm.calls.exec.length, 0);
}

console.log('node-runner-server-promotion: ok');
