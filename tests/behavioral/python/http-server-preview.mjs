#!/usr/bin/env bun
// python/http-server-preview — python -m http.server registers a live preview
// port backed by supervisor VFS reads.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi, fetchPort } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'python/http-server-preview';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);
await t.run('mkdir -p /home/user/py-site && cd /home/user/py-site', 10_000);
await t.run(heredocCommand('index.html', '<!doctype html><h1>nimbus python static server</h1>'), 10_000);

let pid = 0;
{
  const { output } = await t.run('python -m http.server 8123', 30_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/pid=(\d+)/);
  pid = m ? Number(m[1]) : 0;
  a.check('python http.server returns a long-running Nimbus process',
    pid > 0 && /Serving HTTP/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const r = await fetchPort(sid, 8123);
  a.check('port proxy serves index.html from live VFS',
    r.status === 200 && /nimbus python static server/.test(r.body),
    `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`);
}

await t.run(heredocCommand('index.html', '<!doctype html><h1>updated live vfs</h1>'), 10_000);
{
  const r = await fetchPort(sid, 8123);
  a.check('static server sees edits after startup',
    r.status === 200 && /updated live vfs/.test(r.body),
    `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`);
}

if (pid > 0) await t.run(`kill ${pid}`, 10_000).catch(() => {});
await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
