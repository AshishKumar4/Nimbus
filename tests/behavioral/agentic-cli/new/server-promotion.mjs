#!/usr/bin/env bun
// A program that listens serves through its port, however it was started and
// whatever its code looks like before it runs: no rule names these servers,
// so each starts as a one-shot and its first listen() runs it on as a
// resident (FacetManager._promote). A bin that served is learned, and its
// next launch starts as a server directly.
import { mintSession, Terminal, makeAsserter, heredocCommand, deleteSession, requestHeaders, termBody } from '../../_driver.mjs';

if (!process.env.BASE) process.exit(2);
const label = 'agentic-cli/new/server-promotion';
const a = makeAsserter(label);
const W = '/home/user/promo';
// Made and listened through names built at run time: no static check sees them.
const SERVE = (port, body) => [
  "const http = require('h' + 'ttp');",
  `const server = http['create' + 'Server']((req, res) => res.end(${JSON.stringify(body)}));`,
  `server['li' + 'sten'](${port}, () => console.log('LISTENING ${port}'));`,
].join('\n');
const sid = await mintSession(), t = new Terminal(sid);
console.log(`${label} — ${process.env.BASE} SID=${sid}`);
const viaPort = async (port) => {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${process.env.BASE}/s/${sid}/port/${port}/`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(20_000) })
      .then(async (res) => ({ status: res.status, body: await res.text() }), (e) => ({ status: 0, body: e.message }));
    if (r.status === 200) return r;
    last = `${r.status} ${r.body.slice(0, 200)}`;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { status: -1, body: last };
};
const pidOf = (out) => /\[(?:facet|bin) started \(long-running\): pid=(\d+)/.exec(out)?.[1];
try {
  await t.connect(); await t.waitForPrompt(60_000);
  await t.run(`mkdir -p ${W}/node_modules/mysrv ${W}/node_modules/.bin && cd ${W}`, 15_000);
  await t.run(heredocCommand(`${W}/srv.js`, SERVE(4201, 'plain')), 15_000);
  await t.run(heredocCommand(`${W}/child.js`, SERVE(4203, 'child')), 15_000);
  await t.run(heredocCommand(`${W}/parent.js`, "require('child_process').spawn('node', ['child.js'], { stdio: 'inherit' });"), 15_000);
  await t.run(heredocCommand(`${W}/node_modules/mysrv/package.json`, JSON.stringify({ name: 'mysrv', version: '1.0.0', bin: { mysrv: 'cli.js' } })), 15_000);
  await t.run(heredocCommand(`${W}/node_modules/mysrv/cli.js`, '#!/usr/bin/env node\n' + SERVE(4202, 'bin')), 15_000);
  await t.run(`ln -sf ../mysrv/cli.js node_modules/.bin/mysrv && chmod +x node_modules/mysrv/cli.js`, 15_000);

  const plain = termBody((await t.run('node srv.js', 120_000)).output);
  const plainServed = await viaPort(4201);
  a.check('an unlisted `node file` server serves through its port on its first launch', plainServed.status === 200 && plainServed.body === 'plain', `${plainServed.status} ${plainServed.body}\n${plain.slice(-600)}`);
  a.check('what it printed before its listen is shown once', (plain.match(/LISTENING 4201/g) ?? []).length === 1, plain.slice(-600));

  const bin = termBody((await t.run('./node_modules/.bin/mysrv serve', 120_000)).output);
  const binServed = await viaPort(4202);
  a.check('an unlisted bin serves on its first launch', binServed.status === 200 && binServed.body === 'bin', `${binServed.status} ${binServed.body}\n${bin.slice(-600)}`);
  a.check('its first launch was no resident until it listened', /\[facet started: pid=/.test(bin), bin.slice(-600));
  await t.run(`kill ${pidOf(bin)}`, 15_000);
  const again = termBody((await t.run('./node_modules/.bin/mysrv serve', 120_000)).output);
  a.check('it is learned: its next launch starts as a server', /\[facet started \(long-running\): pid=/.test(again), again.slice(-600));
  const againServed = await viaPort(4202);
  a.check('and serves', againServed.status === 200 && againServed.body === 'bin', `${againServed.status} ${againServed.body}`);

  t.cmd('node parent.js');
  const child = await viaPort(4203);
  a.check('a child_process child that listens serves through its port', child.status === 200 && child.body === 'child', `${child.status} ${child.body}`);
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid);
}
process.exit(a.summary().fail > 0 ? 1 : 0);
