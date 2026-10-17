// @serial
// @tier slow — drives a local workerd
// A program that listens serves, however it was started and whatever it
// looks like before it runs. One no rule names as a server starts as a
// one-shot; its first listen() stops it, and Nimbus runs it on as a resident
// from what its run started from (each file the run changed put back), that
// replays the run's draws and output up to that listen, and serves.
//
//   plain: `node srv.js`, where srv.js builds its server through a helper
//     the static server check cannot follow: it serves on its port.
//   wrote: it writes a file before it listens: the resident writes it
//     again, and serves.
//   awaited: as Vite loads its config, it awaits a mkdir -p of a directory
//     that is not there, then a write into it of a file named for the clock
//     and a random draw, imports the file, removes it, and listens. Run again,
//     the directory is not there again: it makes it again, and serves.
//   stamped: it writes the times fstat gives its stdout to a file before it
//     listens: a run again is handed the same times, makes the same write,
//     and serves.
//   appended: it appends to a file before it listens. Made again, the append
//     would land twice: it cannot be run again, and its listen says why.
//   child: a child_process child that listens: its parent reaches it.
//   spawned: it starts a child before it listens: it cannot be run again,
//     and its listen fails, naming why.
//   piped: it reads its piped stdin before it listens, and serves what it
//     read: the resident is handed the same bytes.
//   redirected: the same from a \`< file\`: the resident reads the file again.
//   once: it awaits a write of a marker, and ends instead of listening when
//     the marker is there. Run again, the marker is not there: it listens,
//     and serves. (Before, the run again found the marker, ended, and failed.)
//   crowded: it writes more files than a run's changes are kept for before
//     it listens: it is run again from its start over the files as they
//     are, printing again what it printed, says so, and serves.
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
  'awaited.js': [
    "const fs = require('fs');",
    "const path = require('path');",
    '(async () => {',
    "  await fs.promises.mkdir('node_modules/.vite-temp/', { recursive: true });",
    "  const name = path.resolve('node_modules/.vite-temp/config.timestamp-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.mjs');",
    "  await fs.promises.writeFile(name, 'export default 4109;');",
    "  const port = (await import(require('url').pathToFileURL(name).href)).default;",
    '  fs.unlink(name, () => {});',
    '  ' + SERVE(4109, 'awaited').split('\n').join('\n  ').replace('4109,', 'port,'),
    '})();',
  ].join('\n'),
  'stamped.js': [
    "const fs = require('fs');",
    "fs.writeFileSync('stamped.txt', String(fs.fstatSync(1).mtimeMs));",
    SERVE(4110, 'stamped'),
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
  'piped.js': [
    "const config = require('fs').readFileSync(0, 'utf8').trim();",
    SERVE(4106, 'piped').replace(JSON.stringify('piped'), 'config'),
  ].join('\n'),
  'redirected.js': [
    "const config = require('fs').readFileSync(0, 'utf8').trim();",
    SERVE(4108, 'redirected').replace(JSON.stringify('redirected'), 'config'),
  ].join('\n'),
  'once.js': [
    "const fs = require('fs');",
    '(async () => {',
    "  if (fs.existsSync('once.marker')) return;",
    "  await fs.promises.writeFile('once.marker', 'x');",
    '  ' + SERVE(4107, 'once').split('\n').join('\n  '),
    '})();',
  ].join('\n'),
  'crowded.js': [
    "const fs = require('fs');",
    '(async () => {',
    "  fs.mkdirSync('crowd', { recursive: true });",
    "  for (let i = 0; i < 4100; i++) fs.writeFileSync('crowd/' + i, '');",
    // Awaited, a write goes with every one before it: all of them are the session's before it listens.
    "  await fs.promises.writeFile('crowd/done', '');",
    '  ' + SERVE(4111, 'crowded').split('\n').join('\n  '),
    '})();',
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
    check(/\[facet started: pid=(\d+)[^\n]*\n[\s\S]*LISTENING 4101[\s\S]*\[facet started \(long-running\): pid=\1 cmd="node plain\.js"\]/.test(plain.stdout)
      && (plain.stdout.match(/long-running/g) ?? []).length === 1,
      `plain: started as a one-shot (no static check names it a server), then said once to run on as a resident\n  ${JSON.stringify(plain.stdout.slice(-400))}`);
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

    const awaited = await run(`cd ${W} && node awaited.js`, 120_000);
    check(awaited.status === 0 && /LISTENING 4109/.test(awaited.stdout), `awaited: started and listened\n  ${JSON.stringify(awaited.stdout.slice(-600))}`);
    const awaitedGot = await curl(4109);
    check(/GOT 200 awaited/.test(awaitedGot), `awaited: it serves\n  ${JSON.stringify(awaitedGot)}`);

    const stamped = await run(`cd ${W} && node stamped.js`, 120_000);
    check(stamped.status === 0 && /LISTENING 4110/.test(stamped.stdout), `stamped: started and listened\n  ${JSON.stringify(stamped.stdout.slice(-600))}`);
    const stampedGot = await curl(4110);
    check(/GOT 200 stamped/.test(stampedGot), `stamped: it serves\n  ${JSON.stringify(stampedGot)}`);

    const appended = await run(`cd ${W} && node appended.js`, 120_000);
    check(appended.status !== 0 && /before it listened it appended to .*appended\.log, which a second run would append again/.test(appended.stdout),
      `appended: an append before its listen fails it loudly\n  ${JSON.stringify(appended.stdout.slice(-600))}`);

    const child = await run(`cd ${W} && node parent.js`, 120_000);
    check(/PARENT GOT 200 child/.test(child.stdout), `child: a child_process child that listens is reachable\n  ${JSON.stringify(child.stdout.slice(-600))}`);

    const piped = await run(`cd ${W} && echo from-stdin | node piped.js`, 120_000);
    check(/LISTENING 4106/.test(piped.stdout), `piped: started and listened\n  ${JSON.stringify(piped.stdout.slice(-400))}`);
    const pipedGot = await curl(4106);
    check(/GOT 200 from-stdin/.test(pipedGot), `piped: the resident read the same stdin\n  ${JSON.stringify(pipedGot)}\n  ${JSON.stringify(piped.stdout.slice(-400))}`);

    await client.writeFile(`${W}/config.txt`, 'from-file\n');
    const redirected = await run(`cd ${W} && node redirected.js < config.txt`, 120_000);
    check(/LISTENING 4108/.test(redirected.stdout), `redirected: a \`< file\` server started and listened\n  ${JSON.stringify(redirected.stdout.slice(-400))}`);
    const redirectedGot = await curl(4108);
    check(/GOT 200 from-file/.test(redirectedGot), `redirected: the resident read the same file\n  ${JSON.stringify(redirectedGot)}\n  ${JSON.stringify(redirected.stdout.slice(-400))}`);

    const once = await run(`cd ${W} && node once.js; echo ONCE_RC=$?`, 120_000);
    check(/ONCE_RC=0/.test(once.stdout) && /LISTENING 4107/.test(once.stdout),
      `once: run again from what its run started from, it listens again\n  ${JSON.stringify(once.stdout.slice(-600))}`);
    const onceGot = await curl(4107);
    check(/GOT 200 once/.test(onceGot), `once: it serves\n  ${JSON.stringify(onceGot)}`);

    const crowded = await run(`cd ${W} && node crowded.js`, 240_000);
    check(crowded.status === 0 && /runs it again as one from its start, over the files as they are: it changed more than 4096 files and directories/.test(crowded.stdout),
      `crowded: past the bound, it is run again from its start, and says why\n  ${JSON.stringify(crowded.stdout.slice(-600))}`);
    const crowdedGot = await curl(4111);
    check(/GOT 200 crowded/.test(crowdedGot), `crowded: it serves\n  ${JSON.stringify(crowdedGot)}`);

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
console.log('server-promotion-workerd: a program that listens serves, from what its run started from or else from its start, a cp child server is reachable, and a run that cannot be run again says why');
