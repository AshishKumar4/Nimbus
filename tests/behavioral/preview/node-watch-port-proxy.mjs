#!/usr/bin/env bun
// behavioral/preview/node-watch-port-proxy — explicit long-running node
// server is reachable through the public /s/<sid>/port/<n>/ route.

import {
  fetchPort,
  heredocCommand,
  makeAsserter,
  mintSession,
  Terminal,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('preview/node-watch-port-proxy');
console.log(`behavioral/preview/node-watch-port-proxy — BASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(20_000);

await t.run('mkdir -p /home/user/app && cd /home/user/app', 15_000);

const serverJs = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('nimbus-node-watch:' + req.url + '\\n');
});
server.listen(3000, '0.0.0.0', () => console.log('LISTENING 3000'));
`.trim();

await t.run(heredocCommand('server.js', serverJs), 15_000);

const started = await t.run('node --watch server.js', 30_000);
const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
a.check('node --watch returns long-running pid', pid > 0, started.output.slice(-300));

let portResult = null;
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  portResult = await fetchPort(sid, 3000, 'hello?x=1');
  if (portResult.status === 200 && /nimbus-node-watch:\/hello\?x=1/.test(portResult.body)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

a.check(
  'GET /s/<sid>/port/3000 proxies to the node server',
  portResult?.status === 200 && /nimbus-node-watch:\/hello\?x=1/.test(portResult.body),
  portResult ? `status=${portResult.status} body=${portResult.body.slice(0, 160)}` : 'no response',
);

if (pid > 0) {
  await t.run(`kill ${pid}`, 15_000);
}
await t.close();

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
