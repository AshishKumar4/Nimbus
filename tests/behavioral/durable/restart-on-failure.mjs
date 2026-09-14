#!/usr/bin/env bun
// durable/restart-on-failure — a server started with restart: 'on-failure'
// comes back after it crashes; one started without does not.
//
// WHAT IT PROVES
//   `startProcess(cmd, { restart: 'on-failure' })` carries the policy into
//   the resident's journal row. When the process exits non-zero on its own,
//   the session re-drives it after a backoff: the same scoped URL answers
//   again from a NEW process (new pid, new boot nonce). The default policy
//   ('never') leaves a crashed server stopped — its URL goes 502.
//
// HOW IT'S DRIVEN
//   The SDK's remote surface starts both servers. Each crashes itself once,
//   on a timer, the first time it boots — a marker file on the VFS tells the
//   re-driven instance not to crash again. The scoped path URL is polled.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, fetchPort, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('durable/restart-on-failure');
console.log(`durable/restart-on-failure — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);

const crashyServer = (port, marker) => `
const http = require('http');
const fs = require('fs');
const BOOT = process.pid + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('crashy:' + req.url + '|boot=' + BOOT + '\\n');
}).listen(${port}, '0.0.0.0', () => console.log('LISTENING ${port} boot=' + BOOT));
// Live VFS through the async bridge, so the marker the first boot writes is
// what the re-driven boot reads — never the startup snapshot.
fs.promises.readFile('${marker}').then(() => console.log('already crashed once, staying up'), async () => {
  await fs.promises.writeFile('${marker}', BOOT);
  setTimeout(() => { console.error('crashing on purpose'); process.exit(1); }, 2000);
});
`.trim();

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
async function pollNot200(port, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = { status: 0, body: '' };
  while (Date.now() < deadline) {
    last = await fetchPort(sid, port, '/');
    if (last.status !== 200) return { ok: true, last };
    await sleep(400);
  }
  return { ok: false, last };
}

try {
  await box.ready();
  await box.files.mkdir('/home/user/restartapp').catch(() => {});
  await box.files.write('/home/user/restartapp/crashy.js', crashyServer(4600, '/home/user/restartapp/crashed-once'));
  await box.files.write('/home/user/restartapp/plain.js', crashyServer(4601, '/home/user/restartapp/plain-crashed-once'));

  // ── 1. on-failure: the crash is followed by a re-drive ────────────────
  const started = await box.startProcess('node crashy.js', { cwd: '/home/user/restartapp', restart: 'on-failure' });
  a.check('startProcess accepts restart: on-failure', started.pid > 0, JSON.stringify(started.process));
  const warm = await pollPort(4600, 'crashy:', 20_000);
  a.check('the server answers before it crashes', warm.ok, `status=${warm.last.status} body=${warm.last.body?.slice(0, 100)}`);
  const bootBefore = warm.last.body?.match(/boot=([^\s|]+)/)?.[1] ?? '';
  const policy = (await box.apps.list()).find((app) => app.port === 4600);
  a.check('apps.list reports the on-failure policy', policy?.restart === 'on-failure', JSON.stringify(policy));
  const residentPid = policy?.pid ?? 0;
  a.check('apps.list names the resident pid', residentPid > 0, JSON.stringify(policy));

  // It crashes ~2.5s after boot; the re-drive lands after a 1s backoff.
  // Bounded poll for a different boot nonce on the same URL.
  const deadline = Date.now() + 40_000;
  let bootAfter = '';
  let last = null;
  while (Date.now() < deadline) {
    last = await fetchPort(sid, 4600, '/');
    const boot = last.body?.match(/boot=([^\s|]+)/)?.[1] ?? '';
    if (last.status === 200 && boot && boot !== bootBefore) { bootAfter = boot; break; }
    await sleep(500);
  }
  a.check('the crashed server was re-driven and answers again (new boot nonce)', bootAfter !== '',
    `before=${bootBefore} last status=${last?.status} body=${last?.body?.slice(0, 100)}`);
  const after = (await box.apps.list()).find((app) => app.port === 4600);
  a.check('apps.list reports the restarted process running under the same identity, a new pid',
    after?.status === 'running' && after?.owner === policy?.owner && typeof after?.pid === 'number' && after.pid !== residentPid,
    JSON.stringify({ before: policy, after }));
  const logs = await box.processes.logs(residentPid, { lines: 50 }).catch(() => null);
  a.check('the crashed pid recorded its non-zero exit',
    logs?.exit?.code === 1 || logs?.exit?.exitCode === 1 || /crashing on purpose/.test(logs?.text ?? ''),
    JSON.stringify(logs?.exit ?? logs?.text?.slice(-200)));

  // ── 2. the default: a crash leaves the server stopped ─────────────────
  const plain = await box.startProcess('node plain.js', { cwd: '/home/user/restartapp' });
  a.check('a plain startProcess runs', plain.pid > 0);
  const plainWarm = await pollPort(4601, 'crashy:', 20_000);
  a.check('the plain server answers before it crashes', plainWarm.ok, `status=${plainWarm.last.status}`);
  const plainPolicy = (await box.apps.list()).find((app) => app.port === 4601);
  a.check('apps.list reports the default policy never', plainPolicy?.restart === 'never', JSON.stringify(plainPolicy));
  const gone = await pollNot200(4601, 30_000);
  a.check('after its crash the plain server stops answering', gone.ok, `status=${gone.last.status} body=${gone.last.body?.slice(0, 100)}`);
  await sleep(4_000); // longer than any backoff the on-failure arm used
  const stillGone = await fetchPort(sid, 4601, '/');
  a.check('and is not restarted', stillGone.status !== 200, `status=${stillGone.status} body=${stillGone.body?.slice(0, 100)}`);
  const plainAfter = (await box.apps.list()).find((app) => app.port === 4601);
  a.check('apps.list no longer reports it running', plainAfter === undefined || plainAfter.status !== 'running', JSON.stringify(plainAfter));

  await box.apps.remove({ port: 4600 }).catch(() => {});
} finally {
  await deleteSession(sid, 'durable-restart-on-failure');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
