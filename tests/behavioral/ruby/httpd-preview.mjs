#!/usr/bin/env bun
// ruby/httpd-preview — ruby -run -e httpd registers a live preview port
// backed by supervisor VFS reads.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi, fetchPort } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/httpd-preview';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install ruby', 180_000);
await t.run('mkdir -p /home/user/ruby-site && cd /home/user/ruby-site', 10_000);
await t.run(heredocCommand('index.html', '<!doctype html><h1>nimbus ruby static server</h1>'), 10_000);

let pid = 0;
{
  const { output } = await t.run('ruby -run -e httpd . -p 8124', 30_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/pid=(\d+)/);
  pid = m ? Number(m[1]) : 0;
  a.check('ruby httpd returns a long-running Nimbus process',
    pid > 0 && /Serving HTTP/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const r = await fetchPort(sid, 8124);
  a.check('port proxy serves index.html from live VFS',
    r.status === 200 && /nimbus ruby static server/.test(r.body),
    `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`);
}

await t.run(heredocCommand('index.html', '<!doctype html><h1>ruby live update</h1>'), 10_000);
{
  const r = await fetchPort(sid, 8124);
  a.check('ruby static server sees edits after startup',
    r.status === 200 && /ruby live update/.test(r.body),
    `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`);
}

if (pid > 0) await t.run(`kill ${pid}`, 10_000).catch(() => {});
await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
