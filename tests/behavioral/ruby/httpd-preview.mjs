#!/usr/bin/env bun
// ruby/httpd-preview — ruby -run -e httpd reaches Ruby's WEBrick path
// and serves through Nimbus virtual sockets.

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
await t.run('gem install webrick', 180_000);
await t.run('mkdir -p /home/user/ruby-site && cd /home/user/ruby-site', 10_000);
await t.run(heredocCommand('index.html', '<!doctype html><h1>nimbus ruby httpd</h1>'), 10_000);

let pid = 0;
{
  const { output } = await t.run('ruby -run -e httpd . -p 8124', 30_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/pid=(\d+)/);
  pid = m ? Number(m[1]) : 0;
  a.check('ruby httpd starts as a long-running virtual-socket process',
    pid > 0 && /port=8124/.test(stripped),
    JSON.stringify(stripped.slice(-800)));
}

{
  const r = await fetchPort(sid, 8124);
  a.check('port proxy serves index.html through Ruby WEBrick',
    r.status === 200 && /nimbus ruby httpd/.test(r.body),
    `status=${r.status} body=${JSON.stringify(r.body.slice(0, 200))}`);
}

if (pid > 0) await t.run(`kill ${pid}`, 10_000).catch(() => {});
await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
