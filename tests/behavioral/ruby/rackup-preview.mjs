#!/usr/bin/env bun
// ruby/rackup-preview — rackup gem executable serves a Rack app via WEBrick.

import { deleteSession, mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi, fetchPort } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/rackup-preview';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await t.run('nimbus install ruby', 180_000);
  await t.run('gem install rack rackup webrick', 240_000);
  await t.run('mkdir -p /home/user/rack-app && cd /home/user/rack-app', 10_000);
  await t.run(heredocCommand('config.ru', [
    'require "rack"',
    'run ->(env) {',
    "  [200, {'content-type' => 'text/plain'}, [\"rack ok #{env['PATH_INFO']}\"]]",
    '}',
  ].join('\n')), 10_000);

  {
    const { output } = await t.run('which rackup', 20_000);
    const stripped = stripAnsi(output);
    a.check('rackup gem executable is exposed on PATH',
      /\/home\/user\/\.gem\/bin\/rackup/.test(stripped),
      JSON.stringify(stripped.slice(-500)));
  }

  let pid = 0;
  {
    const { output } = await t.run('rackup -o 0.0.0.0 -p 8126', 60_000);
    const stripped = stripAnsi(output);
    const m = stripped.match(/pid=(\d+)/);
    pid = m ? Number(m[1]) : 0;
    a.check('rackup starts as a long-running virtual-socket process',
      pid > 0 && /port=8126/.test(stripped),
      JSON.stringify(stripped.slice(-1500)));
  }

  {
    const r = await fetchPort(sid, 8126, '/from-rack');
    a.check('Rack app responds through the port proxy',
      r.status === 200 && /rack ok \/from-rack/.test(r.body),
      `status=${r.status} body=${JSON.stringify(r.body.slice(0, 300))}`);
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
