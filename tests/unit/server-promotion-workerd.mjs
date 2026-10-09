// @serial
// @tier slow — drives a local workerd
// A program that listens serves, however it was started and whatever it
// looks like before it runs. One no rule names as a server starts as a
// one-shot; its first listen() stops it, and Nimbus runs it on as a resident
// that replays its run up to that listen, checked against it, and serves.
//
//   plain: `node srv.js`, where srv.js builds its server through a helper
//     the static server check cannot follow: it serves on its port.
//   wrote: it writes a file before it listens: the resident makes the same
//     write again, checked against the first, and serves.
//   appended: it appends to a file before it listens. Made again, the append
//     would land twice: it cannot be run again, and its listen says why.
//   child: a child_process child that listens: its parent reaches it.
//   spawned: it starts a child before it listens: it cannot be run again,
//     and its listen fails, naming why.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/promote';
// The server is made and listens where no static check sees it: through
// names built at run time. Each is started as a one-shot, and promoted.
const SERVE = (port, body) => [
  "const http = require('h' + 'ttp');",
  `const server = http['create' + 'Server']((req, res) => res.end(${JSON.stringify(body)}));`,
  `server['li' + 'sten'](${port}, () => console.log('LISTENING ${port}'));`,
].join('\n');
const FILES = {
  'plain.js': SERVE(4101, 'plain'),
  'wrote.js': [
    "const fs = require('fs');",
    "fs.mkdirSync('state', { recursive: true });",
    "fs.writeFileSync('state/wrote.txt', 'written ' + process.argv.length);",
    SERVE(4102, 'wrote'),
  ].join('\n'),
  'appended.js': [
    "require('fs').appendFileSync('appended.log', 'once\\n');",
    SERVE(4105, 'appended'),
  ].join('\n'),
  'child-server.js': SERVE(4103, 'child'),
  'parent.js': [
    "const { spawn } = require('child_process');",
    "const child = spawn('node', ['child-server.js'], { stdio: ['ignore', 'pipe', 'inherit'] });",
    "child.stdout.on('data', async (d) => {",
    "  if (!/LISTENING/.test(String(d))) return;",
    "  const r = await fetch('http://localhost:4103/');",
    "  console.log('PARENT GOT ' + r.status + ' ' + await r.text());",
    '  child.kill();',
    '});',
  ].join('\n'),
  'spawned.js': [
    "require('child_process').spawnSync('true');",
    SERVE(4104, 'spawned'),
  ].join('\n'),
};

console.log('server-promotion-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
try {
  const client = await localTerminal(probe, { install: [] });
  const { run } = client;
  const curl = async (port) => (await run(`node -e "fetch('http://localhost:${port}/').then(async (r) => console.log('GOT ' + r.status + ' ' + await r.text()), (e) => console.log('ERR ' + e.message))"`)).stdout;
  try {
    await run(`mkdir -p ${W}`);
    for (const [name, content] of Object.entries(FILES)) await client.writeFile(`${W}/${name}`, content);

    const plain = await run(`cd ${W} && node plain.js`, 120_000);
    check(!/facet started \(long-running\)/.test(plain.stdout), `plain: started as a one-shot (no static check names it a server)\n  ${JSON.stringify(plain.stdout.slice(-400))}`);
    check(plain.status === 0 && /LISTENING 4101/.test(plain.stdout), `plain: started and listened once\n  ${JSON.stringify(plain.stdout.slice(-400))}`);
    check((plain.stdout.match(/LISTENING 4101/g) ?? []).length === 1, `plain: what it printed before its listen is shown once\n  ${JSON.stringify(plain.stdout.slice(-400))}`);
    const plainGot = await curl(4101);
    check(/GOT 200 plain/.test(plainGot), `plain: it serves\n  ${JSON.stringify(plainGot)}`);

    const wrote = await run(`cd ${W} && node wrote.js`, 120_000);
    check(wrote.status === 0 && /LISTENING 4102/.test(wrote.stdout), `wrote: started and listened\n  ${JSON.stringify(wrote.stdout.slice(-400))}`);
    const wroteGot = await curl(4102);
    check(/GOT 200 wrote/.test(wroteGot), `wrote: it serves\n  ${JSON.stringify(wroteGot)}`);
    const written = await run(`cat ${W}/state/wrote.txt`);
    check(written.stdout === 'written 2', `wrote: what it wrote before its listen is there\n  ${JSON.stringify(written.stdout)}`);

    const appended = await run(`cd ${W} && node appended.js`, 120_000);
    check(appended.status !== 0 && /before it listened it appended to .*appended\.log, which a second run would append again/.test(appended.stdout),
      `appended: an append before its listen fails it loudly\n  ${JSON.stringify(appended.stdout.slice(-600))}`);

    const child = await run(`cd ${W} && node parent.js`, 120_000);
    check(/PARENT GOT 200 child/.test(child.stdout), `child: a child_process child that listens is reachable\n  ${JSON.stringify(child.stdout.slice(-600))}`);

    const spawned = await run(`cd ${W} && node spawned.js`, 120_000);
    check(spawned.status !== 0 && /listens as a server, so Nimbus runs it again as one, but it cannot: before it listened it did something outside itself first \(cpSpawn/.test(spawned.stdout),
      `spawned: an effect before its listen fails it loudly, naming the effect\n  ${JSON.stringify(spawned.stdout.slice(-600))}`);
  } finally {
    await client.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
if (failures.length > 0) {
  console.error(`server-promotion-workerd: ${failures.length} failed`);
  process.exit(1);
}
console.log('server-promotion-workerd: a program that listens serves, a cp child server is reachable, and a run that cannot be run again says why');
