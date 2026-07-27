#!/usr/bin/env bun
// A successful request to a resident Node server is a VFS durability boundary:
// sync writes must be immediately visible through the authoritative SQLite VFS,
// and an awaited async append must not be replayed by later request boundaries.

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
  await t.run('printf "base\\n" > /home/user/request-append.txt', 15_000);

  const source = `
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
http.createServer(async (req, res) => {
  try {
    if (req.url === '/commit') {
      fs.writeFileSync('/home/user/request-durable.txt', 'durable:' + req.url + '\\n');
    } else if (req.url === '/append') {
      await fsp.appendFile('/home/user/request-append.txt', 'once\\n');
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('handled:' + req.url);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(error?.stack || String(error));
  }
}).listen(4387);
`;
  await t.run(heredocCommand('/home/user/request-durable-server.js', source), 15_000);
  const started = await t.run('node --watch /home/user/request-durable-server.js', 30_000);
  pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('resident Node server started', pid > 0, JSON.stringify(started.output.slice(-500)));

  let ready;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    ready = await fetchPort(sid, 4387, 'ready');
    if (ready.status === 200 && ready.body === 'handled:/ready') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  a.check(
    'resident Node server became ready within the bounded poll',
    ready?.status === 200 && ready.body === 'handled:/ready',
    ready ? `status=${ready.status} body=${JSON.stringify(ready.body)}` : 'no response',
  );

  const response = await fetchPort(sid, 4387, 'commit');
  a.check(
    'request handler returned success',
    response.status === 200 && response.body === 'handled:/commit',
    response ? `status=${response.status} body=${JSON.stringify(response.body)}` : 'no response',
  );

  const visible = await t.run('cat /home/user/request-durable.txt', 15_000);
  const output = stripAnsi(visible.output);
  a.check(
    'sync write is durable immediately after the successful response',
    /durable:\/commit/.test(output) && !/No such file or directory/.test(output),
    JSON.stringify(output.slice(-600)),
  );

  const appended = await fetchPort(sid, 4387, 'append');
  a.check(
    'async append request returned success',
    appended.status === 200 && appended.body === 'handled:/append',
    `status=${appended.status} body=${JSON.stringify(appended.body)}`,
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    const noop = await fetchPort(sid, 4387, 'noop');
    a.check(
      `no-op request ${attempt} returned success`,
      noop.status === 200 && noop.body === 'handled:/noop',
      `status=${noop.status} body=${JSON.stringify(noop.body)}`,
    );
  }

  const begin = '__NIMBUS_APPEND_CONTENT_BEGIN__';
  const end = '__NIMBUS_APPEND_CONTENT_END__';
  const appendVisible = await t.run(
    `printf '${begin}'; cat /home/user/request-append.txt; printf '${end}\\n'`,
    15_000,
  );
  const appendOutput = stripAnsi(appendVisible.output).replace(/\r/g, '');
  const contentStart = appendOutput.lastIndexOf(begin);
  const contentEnd = appendOutput.indexOf(end, contentStart + begin.length);
  const appendContent = contentStart >= 0 && contentEnd >= 0
    ? appendOutput.slice(contentStart + begin.length, contentEnd)
    : null;
  a.check(
    'async append is durable exactly once after two later request boundaries',
    appendContent === 'base\nonce\n',
    JSON.stringify({ appendContent, outputTail: appendOutput.slice(-600) }),
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
