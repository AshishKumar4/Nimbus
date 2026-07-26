#!/usr/bin/env bun
// A successful request to a resident Node server is a VFS durability boundary:
// a sync write in the handler must be immediately visible to the next shell
// command, which reads through the session's authoritative SQLite VFS.

import {
  deleteSession,
  fetchPort,
  heredocCommand,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'agentic-cli/new/node-request-sync-write-durable';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
let pid = 0;

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const source = `
const fs = require('node:fs');
const http = require('node:http');
http.createServer((req, res) => {
  fs.writeFileSync('/home/user/request-durable.txt', 'durable:' + req.url + '\\n');
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('written:' + req.url);
}).listen(4387);
`;
  await t.run(heredocCommand('/home/user/request-durable-server.js', source), 15_000);
  const started = await t.run('node --watch /home/user/request-durable-server.js', 30_000);
  pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('resident Node server started', pid > 0, JSON.stringify(started.output.slice(-500)));

  let response;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    response = await fetchPort(sid, 4387, 'commit');
    if (response.status === 200 && response.body === 'written:/commit') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  a.check(
    'request handler returned success',
    response?.status === 200 && response.body === 'written:/commit',
    response ? `status=${response.status} body=${JSON.stringify(response.body)}` : 'no response',
  );

  const visible = await t.run('cat /home/user/request-durable.txt', 15_000);
  const output = stripAnsi(visible.output);
  a.check(
    'sync write is durable immediately after the successful response',
    /durable:\/commit/.test(output) && !/No such file or directory/.test(output),
    JSON.stringify(output.slice(-600)),
  );
} finally {
  if (pid > 0) await t.run(`kill ${pid}`, 15_000).catch(() => {});
  await t.close().catch(() => {});
  const cleanup = await deleteSession(sid);
  a.check(
    'probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`,
  );
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
