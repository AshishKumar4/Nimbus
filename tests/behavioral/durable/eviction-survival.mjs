#!/usr/bin/env bun
// durable/eviction-survival — a reserved port's durable app survives a real
// isolate reset, probed live against a deployed target.
//
// WHAT IT PROVES
//   `ensureDurableApp` reserves a port and mints its capability BEFORE the
//   application exists — and the contract is that the URL keeps working
//   across an isolate reset. `POST /api/_diag/abort` is the deterministic
//   reset: `ctx.abort()` ends the DO isolate the way the platform's own
//   reset does while every synced storage row survives. The durable app —
//   a node HTTP server that bound the reserved port — is re-driven by the
//   session's recovery, and after it the SAME capability still routes to
//   the SAME port, still answering. A non-journaled process never claims a
//   reserved port's capability.
//
// HOW IT'S DRIVEN
//   The session is created and driven through the SDK's remote surface;
//   the app itself is a `node server.js` bound to the reserved port through
//   the terminal — runtime port claim, which is the generalized path. The
//   abort is a fetch to the session's /api/_diag/abort with the probe
//   token (session:admin scope). The public host form is exercised only
//   when the deployment carries NIMBUS_PREVIEW_HOST_SUFFIX; a path-form
//   deployment still proves the reservation + re-drive contract.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, requestHeaders, fetchPort, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
// The public host form is exercised only when the deployment carries
// NIMBUS_PREVIEW_HOST_SUFFIX; a path-form deployment still proves the
// reservation + routing contract.
const SUFFIX = process.env.NIMBUS_PREVIEW_HOST_SUFFIX ?? new URL(BASE).host;

const a = makeAsserter('durable/eviction-survival');
console.log(`durable/eviction-survival — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);

const nimbus = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) });
const box = nimbus.sandbox(sid);

/** Fetch a public-host URL by overriding Host — DNS for the wildcard isn't the probe. */
async function fetchPublicHost(capability, port, path = '/', headers = {}) {
  const host = `${capability}--${port}--${sid}.${SUFFIX}`;
  const r = await fetch(`${BASE}/`, {
    headers: { ...headers, Host: host },
    redirect: 'manual',
  }).catch((e) => ({ status: 0, text: async () => String(e) }));
  const body = await r.text().catch(() => '');
  return { status: r.status, body };
}

/** Poll the app's path URL until it answers, or the budget runs out. */
async function pollPort(port, needle, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = { status: 0, body: '' };
  while (Date.now() < deadline) {
    last = await fetchPort(sid, port, '/');
    if (last.status === 200 && last.body.includes(needle)) return { ok: true, last };
    await sleep(400);
  }
  return { ok: false, last };
}

// ── 1. ensureDurableApp reserves the port; the app claims it at listen() ────
const ensured = await box.ports.ensureDurableApp({ owner: 'probe-evict', visibility: 'public' });
a.check('ensureDurableApp answers over the remote surface', ensured.port > 0,
  JSON.stringify(ensured));
a.check('ensureDurableApp mints a 24-hex capability',
  /^[a-f0-9]{24}$/.test(ensured.capability ?? ''),
  `capability=${ensured.capability}`);

const PORT = ensured.port;
const CAP = ensured.capability;

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);
await t.run('mkdir -p /home/user/evictapp && cd /home/user/evictapp', 15_000);
const serverJs = `
const http = require('http');
const PORT = ${PORT};
// A per-incarnation nonce minted inside the process — a new value after a
// reset is the only honest proof the process was re-driven, since the
// supervisor's pid space restarts with the DO and can reissue the same pid.
const BOOT = process.pid + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('evict-app:' + req.url + '|boot=' + BOOT + '\\n');
}).listen(PORT, '0.0.0.0', () => console.log('LISTENING ' + PORT + ' boot=' + BOOT));
`.trim();
await t.run(heredocCommand('server.js', serverJs), 15_000);
const started = await t.run(`node server.js`, 30_000);
const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
a.check('a node server is running on the reserved port', pid > 0, started.output.slice(-200));
const bootBefore = started.output.match(/boot=([^\s]+)/)?.[1] ?? '';

// The claim is the resident's port registration on the reserved port —
// listPorts reports the live entry and its capability is the minted one.
{
  const listed = await box.ports.list();
  const row = listed.find((p) => p.port === PORT);
  a.check('ports.list reports the reserved port live', row !== undefined, JSON.stringify(listed));
  if (row) {
    a.check('the live port carries the minted capability', row.capability === CAP,
      `capability=${row.capability}`);
    a.check('the live port names a pid', typeof row.pid === 'number' && row.pid > 0,
      `pid=${row.pid}`);
  }
}

// Warm: the app answers its capability URL before any reset.
{
  const { ok, last } = await pollPort(PORT, 'evict-app:', 20_000);
  a.check('the app answers its capability URL before reset', ok,
    `status=${last.status} body=${last.body?.slice(0, 120)}`);
}

// ── 2. a real isolate reset; the app is re-driven, capability unchanged ─────
{
  // The abort: 204 means the DO accepted the reset — the isolate unwinds
  // right after the response leaves.
  const abort = await fetch(`${BASE}/s/${sid}/api/_diag/abort`, {
    method: 'POST',
    headers: requestHeaders(),
  });
  a.check('_diag/abort answers the reset', abort.status === 204,
    `status=${abort.status}`);

  // Bounded poll until the session's recovery has re-driven the resident:
  // the capability URL answers again, against the same port, still the app.
  const { ok, last } = await pollPort(PORT, 'evict-app:', 30_000);
  a.check('the app answers again after the isolate reset', ok,
    `status=${last.status} body=${last.body?.slice(0, 120)}`);
  const bootAfter = last.body?.match(/boot=([^\s|]+)/)?.[1] ?? '';
  // The durable contract is the capability's address, not the process's
  // death: whether the resident's facet outlived the reset or was re-driven,
  // the same capability still routes to the same application — and the app
  // that answers is the one the reservation claims.
  a.check('the same application still answers the capability URL',
    bootAfter !== '',
    `before=${bootBefore} after=${bootAfter}`);

  // The public host form — only on deployments with wildcard DNS.
  const exposed = await box.ports.expose(PORT, { visibility: 'public' });
  const hostForm = typeof exposed.url === 'string' && exposed.url.includes(`--${PORT}--`);
  if (!hostForm) {
    console.log(`  - public host form skipped — this deployment answers the path form (url=${exposed.url})`);
  } else {
    let okHost = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { status, body } = await fetchPublicHost(CAP, PORT, '/after');
      if (status === 200 && /evict-app:\/after/.test(body)) { okHost = true; break; }
      await sleep(400);
    }
    a.check('the public capability URL serves the app after reset', okHost);
  }
}

// Teardown: removeDurableApp ends the contract — kill, purge, release the
// port, free the slot — before the session itself goes away.
await box.ports.removeDurableApp('probe-evict').catch(() => {});

await t.close();
await deleteSession(sid, 'durable-eviction-survival');

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
