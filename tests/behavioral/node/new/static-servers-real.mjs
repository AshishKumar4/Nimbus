#!/usr/bin/env bun
// node/new/static-servers-real — the static file servers people actually run.
//
// WHAT IT PROVES
//   Each of http-server, serve, sirv-cli, an express.static app and
//   node-static starts on a small VFS directory as a session process, binds
//   its port, and serves a file's exact bytes through the scoped port route
//   (/s/<sid>/port/<n>/). The file is UTF-8 with multi-byte characters, so a
//   server that answers 200 with anything else — a listing, an error page, a
//   mangled body — fails.
//
// WHY THESE FIVE
//   Each exercises a different part of the Node guest: http-server's
//   `EventEmitter.call(this)` inheritance (union), serve's top-level-await
//   ESM entry with a multi-line import, sirv-cli's ESM/CommonJS default
//   interop (tinydate), express 4's depd (`new Function` on module load:
//   refused in its first launch, compiled for the next), node-static's file
//   resolution.
//
// RELAUNCH RULE
//   Code a program generates at runtime is refused in the launch that
//   produced it and, when that launch fails, staged for the next launch of
//   the same command (ERR_NIMBUS_CODE_NEXT_LAUNCH). A program that compiles
//   several texts in sequence (serve's ajv validators) reaches the next one
//   only after the previous is staged, so a relaunch is allowed while the
//   previous launch exited reporting staged code, up to MAX_LAUNCHES. Any
//   other exit fails.

import {
  BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, fetchPort, sleep,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('node/new/static-servers-real');
console.log(`node/new/static-servers-real — BASE=${BASE}`);

const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);

const SITE = '/home/user/static-site';
const EXPRESS_APP = '/home/user/express-static';
const CONTENT = `static-servers-real ${Date.now().toString(36)} — Grüße ✓ 静的\n`;
const LAUNCH_BUDGET_MS = 180_000;
// depd (express 4) and ajv (serve) build one function per call site or schema,
// in sequence, so each failed launch reveals one more text.
const MAX_LAUNCHES = 10;

const SERVERS = [
  { name: 'http-server', port: 8101, cwd: '/home/user', command: `npx http-server ${SITE} -p 8101` },
  { name: 'serve', port: 8102, cwd: '/home/user', command: `npx serve ${SITE} -l 8102` },
  // sirv-cli reads $PORT before --port, and a Nimbus session exports PORT=3000.
  // sirv answers If-None-Match only (with --etag), never If-Modified-Since
  // (sirv/build.js), so its conditional GET is 200 under Node as well.
  { name: 'sirv-cli', port: 8103, cwd: '/home/user', command: `PORT=8103 npx sirv-cli ${SITE} --port 8103`, conditional: false },
  { name: 'express.static', port: 8104, cwd: EXPRESS_APP, command: 'node app.js' },
  { name: 'node-static', port: 8105, cwd: '/home/user', command: `npx node-static -p 8105 ${SITE}` },
];

/** Poll the port route until it answers the file, or the process exits. */
async function served(port, pid) {
  const deadline = Date.now() + LAUNCH_BUDGET_MS;
  let last = { status: 0, body: '' };
  while (Date.now() < deadline) {
    last = await fetchPort(sid, port, 'hello.txt').catch((e) => ({ status: 0, body: String(e) }));
    if (last.status === 200 && last.body === CONTENT) return { ok: true, last };
    const logs = await box.processes.logs(pid).catch(() => null);
    if (logs?.exit) return { ok: false, last, exit: logs.exit, logs: logs.text };
    await sleep(1000);
  }
  const logs = await box.processes.logs(pid).catch(() => null);
  return { ok: false, last, logs: logs?.text ?? '' };
}

try {
  await box.ready();
  await box.files.mkdir(SITE).catch(() => {});
  await box.files.write(`${SITE}/hello.txt`, CONTENT);
  await box.files.mkdir(EXPRESS_APP).catch(() => {});
  await box.files.write(`${EXPRESS_APP}/package.json`, JSON.stringify({ name: 'express-static', private: true }));
  await box.files.write(`${EXPRESS_APP}/app.js`, [
    "const express = require('express');",
    'const app = express();',
    `app.use(express.static(${JSON.stringify(SITE)}));`,
    "app.listen(8104, () => console.log('express.static listening on 8104'));",
  ].join('\n'));
  const install = await box.exec('npm install express@4', { cwd: EXPRESS_APP });
  a.check('express@4 installs', install.exitCode === 0, (install.stderr || install.stdout || '').slice(-400));

  for (const server of SERVERS) {
    let started = await box.startProcess(server.command, { cwd: server.cwd });
    let result = await served(server.port, started.pid);
    for (let launch = 2; launch <= MAX_LAUNCHES && !result.ok && result.exit && /ERR_NIMBUS_CODE_NEXT_LAUNCH/.test(result.logs ?? ''); launch++) {
      console.log(`  · ${server.name}: launch ${launch - 1} staged runtime code; relaunching`);
      started = await box.startProcess(server.command, { cwd: server.cwd });
      result = await served(server.port, started.pid);
    }
    a.check(`${server.name} serves the file's exact bytes on port ${server.port}`, result.ok,
      `status=${result.last.status} body=${JSON.stringify(result.last.body.slice(0, 400))}`
      + `${result.exit ? ` exit=${JSON.stringify(result.exit)}` : ''} logs=${JSON.stringify((result.logs ?? '').slice(-600))}`);
    // A browser's conditional GET: the server's own Last-Modified sent back
    // as If-Modified-Since (an HTTP date, with a comma) must answer 304.
    const lastModified = result.ok ? result.last.headers.get('last-modified') : null;
    if (lastModified && server.conditional !== false) {
      const conditional = await fetchPort(sid, server.port, 'hello.txt', { headers: { 'if-modified-since': lastModified } });
      a.check(`${server.name} answers a conditional GET 304`, conditional.status === 304,
        `status=${conditional.status} if-modified-since=${lastModified}`);
    }
    await box.processes.kill(started.pid).catch(() => {});
  }
} finally {
  await deleteSession(sid, 'node-new-static-servers-real');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
