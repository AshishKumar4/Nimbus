#!/usr/bin/env bun
// sdk/new/live-sdk-exec-id — a listening port names the exec that started
// its server.
//
// Kinu links a listening port to the job that started it, so a dev server
// reads as "serving" for that job (Nimbus ask 1, 2026-10-01). An exec takes
// an `execId`; every process it starts carries it, and so does everything
// those spawn, and the port's listener record reports it. Driven through the
// remote SDK: `node server.js` started by an exec named 'j1' listens on 8080
// and spawns a child; the listener and the child report 'j1'. A background
// job and the `vite` builtin's dev server report their own; an exec with no
// execId tags nothing; an invalid one is refused.

import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('sdk/new/live-sdk-exec-id');
console.log(`sdk/new/live-sdk-exec-id — BASE=${BASE}`);

const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');

const box = Nimbus.connect({
  endpoint: BASE,
  ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}),
}).sandbox(`exec-id-${Date.now()}`);

const APP = '/home/user/exec-id-app';
const server = (port) => [
  "const http = require('http');",
  "const fs = require('fs');",
  "const { spawn } = require('child_process');",
  `http.createServer((req, res) => res.end('serving ${port}')).listen(${port}, () => {`,
  "  const child = spawn('sleep', ['600']);",
  // The pid is the session's, known once the spawn is acknowledged.
  `  child.once('spawn', () => fs.writeFileSync('${APP}/child-${port}.pid', String(child.pid)));`,
  '});',
  '',
].join('\n');

/** Poll until `read` answers something, or fail loud after `ms`. */
async function until(what, read, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const listener = (port) => until(`a listener on ${port}`, async () => (await box.ports.list()).find((p) => p.port === port));

try {
  await box.files.mkdir(APP);
  for (const port of [8080, 8081, 8082]) await box.files.write(`${APP}/server-${port}.js`, server(port));

  const ran = await box.exec('node server-8080.js', { execId: 'j1', cwd: APP });
  a.check('exec { execId: j1 } starts node server-8080.js', ran.exitCode === 0, JSON.stringify(ran));
  const tagged = await listener(8080);
  console.log(`  listener: ${JSON.stringify(tagged)}`);
  a.check('the listener on 8080 reports j1', tagged.execId === 'j1', JSON.stringify(tagged));
  const serverProcess = (await box.processes.list()).find((p) => p.pid === tagged.pid);
  a.check('the server process reports j1', serverProcess?.execId === 'j1', JSON.stringify(serverProcess));

  const childPid = Number(await until('the child pid file', () => box.files.read(`${APP}/child-8080.pid`)));
  const child = await until(`child ${childPid} in the process table`, async () => (await box.processes.list()).find((p) => p.pid === childPid));
  console.log(`  child: ${JSON.stringify(child)}`);
  a.check('a child the server spawns reports j1', child.execId === 'j1', JSON.stringify(child));

  const job = await box.startProcess('node server-8081.js', { execId: 'j2', cwd: APP });
  a.check('startProcess reports its execId on the process', job.process.execId === 'j2', JSON.stringify(job.process));
  const jobListener = await listener(8081);
  a.check('the background job\'s listener reports j2', jobListener.execId === 'j2', JSON.stringify(jobListener));

  const plain = await box.exec('node server-8082.js', { cwd: APP });
  a.check('an exec with no execId starts its server', plain.exitCode === 0, JSON.stringify(plain));
  const untagged = await listener(8082);
  a.check('its listener carries no execId', !('execId' in untagged), JSON.stringify(untagged));

  await box.files.mkdir(`${APP}/web`);
  await box.files.write(`${APP}/web/index.html`, '<!doctype html><title>exec-id</title>\n');
  const vite = await box.exec('vite --port 5173', { execId: 'v1', cwd: `${APP}/web` });
  a.check('exec { execId: v1 } starts the vite dev server', vite.exitCode === 0, JSON.stringify(vite));
  const viteListener = await listener(5173);
  a.check('the vite listener reports v1', viteListener.execId === 'v1', JSON.stringify(viteListener));

  const refused = await box.exec('echo ran', { execId: 'not valid' }).then(() => 'ran', (e) => String(e?.message ?? e));
  a.check('an invalid execId is refused', /execId must be 1 to 160 characters/.test(refused), refused);
} finally {
  // The probe made this sandbox, so its cleanup is the probe's, and a
  // failed one is a failed probe (an error above still propagates).
  const destroyed = await box.destroy({ reason: 'live-sdk-exec-id-complete' })
    .then((result) => result, (error) => ({ ok: false, error: String(error?.message ?? error) }));
  a.check('the sandbox is destroyed', destroyed.ok === true && typeof destroyed.destroyedAt === 'number', JSON.stringify(destroyed));
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
