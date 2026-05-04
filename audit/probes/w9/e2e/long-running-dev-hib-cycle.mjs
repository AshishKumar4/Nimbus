// W9 e2e: long-running facet survives a hibernation simulation.
//
// Real hibernation only happens in prod (wrangler dev keeps the DO
// state across requests). To test the cross-hibernation code path
// LOCALLY, we hit a NIMBUS_DEBUG-gated test endpoint that nukes the
// in-memory Map (resetting `processLogs.pids` + `_hydratedPids`).
// The next read MUST trigger the SQL hydrate path and return the
// pre-simulation logs intact.
//
// Gate: NIMBUS_W9_E2E=1 + a running `wrangler dev --port 8787 --ip 0.0.0.0`
// with NIMBUS_DEBUG=1. Default skip — same convention as W5's e2e.

import { ok, eq, gte, group, summary } from '../_tap.mjs';

const E2E_ENABLED = process.env.NIMBUS_W9_E2E === '1';
const BASE = process.env.NIMBUS_W9_BASE || 'http://127.0.0.1:8787';

if (!E2E_ENABLED) {
  console.log('# W9 e2e skipped (set NIMBUS_W9_E2E=1 with wrangler dev running)');
  console.log('# 0 passed, 0 failed');
  process.exit(0);
}

async function getJson(path) {
  const r = await fetch(BASE + path);
  ok(`GET ${path} returns 2xx`, r.ok);
  return await r.json();
}

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  ok(`POST ${path} returns 2xx`, r.ok);
  return await r.json();
}

// group() in _tap.mjs is sync — for async work we just print headings.
console.log('# hibernation simulation endpoint exists (NIMBUS_DEBUG=1)');
{
  const r = await fetch(BASE + '/api/_test/hib/simulate', { method: 'POST' });
  ok('simulate endpoint reachable', r.ok);
  if (r.ok) {
    const body = await r.json();
    ok('cleared field present', 'cleared' in body);
  }
}

console.log('# logs survive a hibernation simulation');
{
  const spawn = await postJson('/api/_test/spawn-emitter', {
    lines: 50,
    lineText: 'hello-w9-line',
  });
  ok('spawn returned a pid', typeof spawn.pid === 'number' && spawn.pid > 0);
  const pid = spawn.pid;

  await new Promise(r => setTimeout(r, 500));

  const pre = await getJson(`/api/_test/log-tail?pid=${pid}&lines=50`);
  gte('pre-hib lines available', pre.lines.length, 50);

  await postJson('/api/_test/hib/simulate', {});

  const post = await getJson(`/api/_test/log-tail?pid=${pid}&lines=50`);
  gte('post-hib lines preserved', post.lines.length, 50);
  eq('last line matches', post.lines[post.lines.length - 1], pre.lines[pre.lines.length - 1]);

  const diag = await getJson('/api/_diag/memory');
  ok('hib counters present', diag.hib && typeof diag.hib === 'object');
  gte('rehydratedPids advanced (post-simulate hydrate)', diag.hib.rehydratedPids ?? 0, 1);
}

console.log('# auto-response config is reported as on');
{
  const diag = await getJson('/api/_diag/memory');
  ok('autoResponseConfigured present', 'autoResponseConfigured' in (diag.hib ?? {}));
  if (!diag.hib?.autoResponseConfigured) {
    console.log('#   (runtime does not expose setWebSocketAutoResponse — graceful degrade path)');
  } else {
    ok('autoResponseConfigured is true on this runtime', diag.hib.autoResponseConfigured === true);
    eq('hibernationEventTimeoutMs is 5000', diag.hib.hibernationEventTimeoutMs, 5000);
  }
}

summary('w9/e2e/long-running-dev-hib-cycle');
