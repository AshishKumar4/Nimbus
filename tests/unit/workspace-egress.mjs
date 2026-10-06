#!/usr/bin/env bun
// A workspace whose host supplied an egress (NimbusWorkspaceOptions.egress)
// sends every request its commands make off the box through it, and nothing
// past it: curl (plain, -L, -D with -L), wget (one hop and redirects), dig,
// ping and npm view / search each reach the egress, and the isolate's own
// fetch is never called. Loopback stays local. Two workspaces, one with an
// egress and one without, do not share a network. A Dynamic Worker loaded
// for the workspace takes the egress as its globalOutbound; without one the
// key is absent (the loader's default).

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { loaderOutbound, workspaceNetwork } from '../../packages/core/src/_shared/workspace-network.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';

const openWorkspace = (options = {}) => {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  return NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, ...options });
};

/** An egress that answers every request itself and records it; a redirect for /hop. */
function recordingEgress() {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      seen.push(`${request.method} ${request.url}`);
      const url = new URL(request.url);
      if (url.pathname === '/hop') {
        return new Response(null, { status: 302, headers: { location: `${url.origin}/landed` } });
      }
      if (url.hostname === 'dns.google') {
        return Response.json({ Status: 0, Answer: [{ name: 'example.test', type: 1, TTL: 60, data: '192.0.2.7' }] });
      }
      if (url.hostname === 'registry.npmjs.org' && url.pathname.startsWith('/-/v1/search')) {
        return Response.json({ objects: [{ package: { name: 'via-egress', version: '1.0.0', description: 'answered by the egress' } }] });
      }
      if (url.hostname === 'registry.npmjs.org') {
        return Response.json({
          name: 'via-egress', version: '1.0.0', description: 'answered by the egress',
          'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'via-egress', version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/x.tgz' } } },
          dist: { tarball: 'https://registry.npmjs.org/x.tgz' },
        });
      }
      return new Response(`egress answered ${request.method} ${url.pathname}`, { headers: { 'x-egress': 'yes' } });
    },
  };
}

const realFetch = globalThis.fetch;
let isolateFetches = [];
globalThis.fetch = async (input, init) => {
  isolateFetches.push(String(input instanceof Request ? input.url : input));
  throw new Error('the isolate network was used: ' + String(input instanceof Request ? input.url : input));
};

try {
  // ── Every command that leaves the box goes through the egress ───────────
  {
    const egress = recordingEgress();
    const ws = await openWorkspace({ egress });
    assert.equal(ws.network.egress, egress);
    // npm's view and search, as the hosted session registers them: bound to the workspace's kernel.
    ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));

    const cases = [
      ['curl -s https://example.test/plain', /egress answered GET \/plain/, 'GET https://example.test/plain'],
      ['curl -sL https://example.test/hop', /egress answered GET \/landed/, 'GET https://example.test/landed'],
      ['curl -sL -D - https://example.test/hop', /x-egress: yes/i, 'GET https://example.test/landed'],
      ['wget -q -O /tmp/one https://example.test/one && cat /tmp/one', /egress answered GET \/one/, 'GET https://example.test/one'],
      ['wget -q -O /tmp/hop https://example.test/hop && cat /tmp/hop', /egress answered GET \/landed/, 'GET https://example.test/landed'],
      ['dig example.test', /192\.0\.2\.7/, 'GET https://dns.google/resolve?name=example.test&type=A'],
      ['ping -c 1 example.test', /1 packets transmitted/, 'HEAD https://example.test/'],
      ['npm view via-egress', /answered by the egress/, 'GET https://registry.npmjs.org/via-egress'],
      ['npm search via-egress', /via-egress/, null],
    ];
    for (const [command, expect, request] of cases) {
      const before = egress.seen.length;
      const run = await ws.exec(command);
      assert.equal(run.exitCode, 0, `${command}: ${run.stderr}`);
      assert.match(run.stdout + run.stderr, expect, command);
      assert.ok(egress.seen.length > before, `${command} did not reach the egress`);
      if (request) assert.ok(egress.seen.slice(before).some((r) => r.startsWith(request)), `${command}: ${egress.seen.slice(before)}`);
    }
    assert.deepEqual(isolateFetches, [], 'a command used the isolate network under an egress');

    // Loopback stays on the box: the port registry answers, the egress never sees it.
    ws.kernel.portRegistry.set(8080, (_req, res) => { res.statusCode = 200; res.body = 'LOCAL'; });
    const before = egress.seen.length;
    const local = await ws.exec('curl -s http://localhost:8080/');
    assert.equal(local.stdout.trim(), 'LOCAL');
    assert.equal(egress.seen.length, before, 'a loopback request reached the egress');
  }

  // ── Without an egress the workspace uses the isolate's network ──────────
  {
    const ws = await openWorkspace();
    assert.equal(ws.network.egress, undefined);
    isolateFetches = [];
    const run = await ws.exec('curl -s https://example.test/plain');
    assert.notEqual(run.exitCode, 0);
    assert.deepEqual(isolateFetches, ['https://example.test/plain'], 'without an egress, curl uses the isolate fetch');
    isolateFetches = [];
  }

  // ── Two workspaces, two networks ────────────────────────────────────────
  {
    const a = recordingEgress();
    const b = recordingEgress();
    const wsA = await openWorkspace({ egress: a });
    const wsB = await openWorkspace({ egress: b });
    await wsA.exec('curl -s https://example.test/a');
    await wsB.exec('curl -s https://example.test/b');
    assert.deepEqual(a.seen, ['GET https://example.test/a']);
    assert.deepEqual(b.seen, ['GET https://example.test/b']);
    assert.notEqual(wsA.network.id, wsB.network.id, 'two egresses share a cache identity');
  }

  // ── A Dynamic Worker loaded for the workspace ───────────────────────────
  {
    const egress = recordingEgress();
    assert.deepEqual(loaderOutbound(workspaceNetwork(egress)), { globalOutbound: egress });
    const without = loaderOutbound(workspaceNetwork());
    assert.ok(!('globalOutbound' in without), 'without an egress the loader config states no globalOutbound');
    assert.equal(workspaceNetwork().id, '');
  }

  console.log('workspace-egress: ok');
} finally {
  globalThis.fetch = realFetch;
}
