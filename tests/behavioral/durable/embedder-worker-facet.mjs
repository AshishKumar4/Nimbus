#!/usr/bin/env bun
// durable/embedder-worker-facet — an embedder spawns a worker with a text
// module and a custom main module through the programmatic surface, and
// fetches through the facet the spawn returns.
//
// WHAT IT PROVES
//   `spawnWorker` (reached as the session's `_rpcSpawnWorker` by a colocated
//   embedder) boots a Worker-class program whose main module is `runner.js`
//   — not the historical `worker.js` — and whose `lib.js` is a
//   content-addressed text module read from the session filesystem by path
//   at load. The boot payload is the runner's own; the returned facet routes
//   a request to that process (the body names the main module and the value
//   the text module exported, and echoes the request path); `killProcess(pid)`
//   ends it, and the facet does not answer afterwards. No port is involved.
//
// HOW IT'S DRIVEN
//   The probe embedder (apps/probe) exposes POST /api/embedder/<sid>/spawn-worker,
//   which does exactly what an embedder does in-isolate and reports what it
//   saw; this probe mints the session, drives that route with the probe
//   token, and checks the report against what the SDK sees.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, requestHeaders } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('durable/embedder-worker-facet');
console.log(`durable/embedder-worker-facet — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);

try {
  const r = await fetch(`${BASE}/api/embedder/${encodeURIComponent(sid)}/spawn-worker`, {
    method: 'POST',
    headers: requestHeaders({ 'content-type': 'application/json' }),
    body: '{}',
  });
  const text = await r.text();
  a.check('the embedder route answers 200', r.status === 200, `status=${r.status} body=${text.slice(0, 300)}`);
  let report = null;
  try { report = JSON.parse(text); } catch { /* checked below */ }
  a.check('with a JSON report', report !== null && typeof report === 'object', text.slice(0, 200));
  if (report) {
    a.check('the spawn answered a pid', Number.isInteger(report.pid) && report.pid > 0, `pid=${report.pid}`);
    a.check('the boot payload is the runner\'s own, from the custom main module',
      report.boot?.ok === true && report.boot?.main === 'runner.js', JSON.stringify(report.boot));
    a.check('the boot payload carries the value the text module exported',
      report.boot?.answer === 'forty-two', JSON.stringify(report.boot));
    a.check('a request through the returned facet reaches the process',
      report.first?.status === 200, JSON.stringify(report.first));
    a.check('the process served it from runner.js with lib.js resolved by path',
      report.first?.body?.main === 'runner.js' && report.first?.body?.answer === 'forty-two',
      JSON.stringify(report.first?.body));
    a.check('the request path reached the handler intact',
      report.first?.body?.path === '/hello', JSON.stringify(report.first?.body));
    a.check('killProcess(pid) is the lifecycle owner: the kill succeeded',
      report.killed?.ok === true && report.killed?.pid === report.pid, JSON.stringify(report.killed));
    a.check('the facet does not answer after the kill',
      report.afterKill && ('error' in report.afterKill || report.afterKill.status >= 500),
      JSON.stringify(report.afterKill));
    const stat = await box.files.stat(report.libPath);
    a.check('the text module is an ordinary file on the session disk, named by its digest',
      stat?.type === 'file' && /\/[0-9a-f]{64}\.js$/.test(report.libPath), `${report.libPath} stat=${JSON.stringify(stat)}`);
    const procs = await box.processes.list();
    const live = procs.find((p) => p.pid === report.pid && p.state === 'running');
    a.check('the process table no longer runs the pid', live === undefined, JSON.stringify(procs.filter((p) => p.pid === report.pid)));
  }
} finally {
  await deleteSession(sid, 'durable-embedder-worker-facet');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
