#!/usr/bin/env bun
// durable/universal-scoped-survival — an UNNAMED `node server.js` survives a
// real isolate reset on demand, with no reservation and no expose ever made.
//
// WHAT IT PROVES
//   Under the universal model every resident is durable from the moment it
//   is spawned: the port it binds is stamped on its journal row whether or
//   not anything reserved it, and a request on its scoped URL after a reset
//   re-drives it. `POST /api/_diag/abort` is the deterministic reset. The
//   only surfaces touched are the terminal (to start the server) and the
//   scoped path URL — `ensureDurableApp`, `expose` and friends are never
//   called.
//
// HOW IT'S DRIVEN
//   Terminal: write server.js, `node server.js`, read the pid. Path URL:
//   answers before the abort. Abort. Path URL: answers again within a
//   bounded poll, and the boot nonce differs — the process was re-driven,
//   not merely surviving.

import { BASE, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, requestHeaders, fetchPort, sleep } from '../_driver.mjs';
import { afterReset } from './_reset-window.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('durable/universal-scoped-survival');
console.log(`durable/universal-scoped-survival — BASE=${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const PORT = 3000;

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

let t = null;
try {
  t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/plainapp && cd /home/user/plainapp', 15_000);
  const serverJs = `
const http = require('http');
const BOOT = process.pid + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('plain-app:' + req.url + '|boot=' + BOOT + '\\n');
}).listen(${PORT}, '0.0.0.0', () => console.log('LISTENING ${PORT} boot=' + BOOT));
`.trim();
  await t.run(heredocCommand('server.js', serverJs), 15_000);
  const started = await t.run('node server.js', 30_000);
  const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('a plain node server is running', pid > 0, started.output.slice(-200));

  // Warm: the scoped path URL answers, and nothing was ever reserved.
  const warm = await pollPort(PORT, 'plain-app:', 20_000);
  a.check('the scoped path URL answers before the reset', warm.ok,
    `status=${warm.last.status} body=${warm.last.body?.slice(0, 120)}`);
  const bootBefore = warm.last.body?.match(/boot=([^\s|]+)/)?.[1] ?? '';
  a.check('the server reports a boot nonce', bootBefore !== '', warm.last.body?.slice(0, 120));

  // The reset.
  const abort = await fetch(`${BASE}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders() });
  a.check('_diag/abort answers the reset', abort.status === 204, `status=${abort.status}`);

  // The same scoped URL answers again — re-driven on request, no reservation.
  // The 204 leaves before the isolate unwinds, so the first polls may still
  // reach the old instance: the proof is a DIFFERENT boot nonce on the same
  // URL within the budget, not merely a 200.
  let bootAfter = '';
  let last = { status: 0, body: '' };
  {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      last = await fetchPort(sid, PORT, '/');
      const boot = last.body?.match(/boot=([^\s|]+)/)?.[1] ?? '';
      if (last.status === 200 && last.body.includes('plain-app:') && boot && boot !== bootBefore) { bootAfter = boot; break; }
      await sleep(500);
    }
  }
  a.check('the scoped path URL answers again after the reset with no expose ever called, from a re-driven process (new boot nonce)',
    bootAfter !== '', `before=${bootBefore} last status=${last.status} body=${last.body?.slice(0, 120)}`);

  // apps.list sees the identity, derived, unnamed, scoped, running.
  const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
  const box = Nimbus.connect({ endpoint: BASE, ...(process.env.NIMBUS_PROBE_TOKEN ? { token: process.env.NIMBUS_PROBE_TOKEN } : {}) }).sandbox(sid);
  let apps = await afterReset(() => box.apps.list());
  let app = apps.find((row) => row.port === PORT);
  {
    // The re-driven launch settles a beat after its port answers.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && app?.status !== 'running') {
      await sleep(500);
      apps = await afterReset(() => box.apps.list());
      app = apps.find((row) => row.port === PORT);
    }
  }
  a.check('apps.list reports the resident under a derived identity', app !== undefined && /^auto:[a-f0-9]{24}$/.test(app.owner),
    JSON.stringify(apps));
  if (app) {
    a.check('the identity is unnamed and scoped', app.name === null && app.visibility === 'scoped', JSON.stringify(app));
    a.check('the identity is running with a pid', app.status === 'running' && typeof app.pid === 'number', JSON.stringify(app));
    a.check('the identity carries a scoped URL', typeof app.url === 'string' && app.url.includes(`/port/${PORT}/`) || (typeof app.url === 'string' && app.url.includes(`${PORT}--`)),
      `url=${app.url}`);
  }
} finally {
  if (t) await t.close().catch(() => {});
  await deleteSession(sid, 'durable-universal-scoped-survival');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
