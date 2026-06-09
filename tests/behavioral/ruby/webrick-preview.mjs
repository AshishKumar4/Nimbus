#!/usr/bin/env bun
// ruby/webrick-preview — WEBrick runs through Nimbus Ruby virtual sockets.

import { deleteSession, mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi, fetchPort } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/webrick-preview';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await t.run('nimbus install ruby', 180_000);
  await t.run('gem install webrick', 180_000);
  await t.run('mkdir -p /home/user/webrick-app && cd /home/user/webrick-app', 10_000);
  await t.run(heredocCommand('server.rb', [
    'require "webrick"',
    'server = WEBrick::HTTPServer.new(',
    '  Port: 8125,',
    '  BindAddress: "0.0.0.0",',
    '  Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN),',
    '  AccessLog: []',
    ')',
    'server.mount_proc("/") do |req, res|',
    '  res["Content-Type"] = "text/plain"',
    '  res.body = "webrick ok #{req.path}"',
    'end',
    'server.start',
  ].join('\n')), 10_000);

  let pid = 0;
  {
    const { output } = await t.run('ruby server.rb', 60_000);
    const stripped = stripAnsi(output);
    const m = stripped.match(/pid=(\d+)/);
    pid = m ? Number(m[1]) : 0;
    a.check('ruby WEBrick starts as a long-running virtual-socket process',
      pid > 0 && /port=8125/.test(stripped),
      JSON.stringify(stripped.slice(-1200)));
  }

  {
    const r = await fetchPort(sid, 8125, '/hello-ruby');
    a.check('WEBrick preview responds through the port proxy',
      r.status === 200 && /webrick ok \/hello-ruby/.test(r.body),
      `status=${r.status} body=${JSON.stringify(r.body.slice(0, 300))}`);
  }

  {
    const r = await fetchPort(sid, 8125, '/hello-ruby', { method: 'HEAD' });
    a.check('WEBrick preview responds to HEAD without waiting for a body',
      r.status === 200 && r.body === '',
      `status=${r.status} body=${JSON.stringify(r.body)} contentLength=${r.headers.get('content-length')} elapsed=${r.elapsed}ms`);
  }

  if (pid > 0) await t.run(`kill ${pid}`, 10_000).catch(() => {});
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
