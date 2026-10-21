// @serial
// @tier slow — drives a local workerd
// A Node child with a SIGTERM handler hears its parent's kill('SIGTERM') and
// does what its handler says, as under Node: one that exits does so with its
// own code; one that only logs runs on, until SIGKILL ends it; one with no
// handler ends by the signal. Each program runs under host node and in a
// Nimbus session, and their output must be equal (Kinu ask 67.4; ticket
// broker-signals-to-node-handlers).
//
// Before, the child broker's kill took the signal's default action on every
// Node child: a handler never ran, and a child that would have exited 7 ended
// by SIGTERM.
//
// And a signal it catches while it waits in a synchronous read of stdin (a
// run Nimbus stops and runs again once the input is there) waits for it, as
// Node runs a handler once the read returns (libuv restarts the read): its
// parent's kill('SIGTERM') while it waits, then its input, prints the read
// and then the handler's line, and it exits 0. Before, the wait took SIGTERM
// as the end (143).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const HEARS = "process.on('SIGTERM', () => { console.log('heard SIGTERM'); process.exit(7); }); console.log('ready'); setInterval(() => {}, 1000)";
const STUBBORN = "process.on('SIGTERM', () => { console.log('ignored SIGTERM'); }); console.log('ready'); setInterval(() => {}, 1000)";
const ONCE = "process.once('SIGTERM', () => { console.log('once'); }); console.log('ready'); setInterval(() => {}, 1000)";
const PLAIN = "console.log('ready'); setInterval(() => {}, 1000)";
const PARKED = "process.on('SIGTERM', () => console.log('heard SIGTERM')); console.log('waiting'); console.log('read [' + require('fs').readFileSync(0, 'utf8').trim() + ']'); setTimeout(() => {}, 500)";
const PROGRAM = `
const { spawn } = require('child_process');
const run = (label, code, signals) => new Promise((resolve) => {
  console.log('begin ' + label);
  const child = spawn('node', ['-e', code]);
  let out = '';
  let sent = false;
  child.stdout.on('data', (data) => {
    out += data;
    if (sent || !out.includes('ready')) return;
    sent = true;
    let at = 0;
    const next = () => {
      if (at >= signals.length) return;
      child.kill(signals[at++]);
      setTimeout(next, 1000);
    };
    next();
  });
  child.on('close', (code, signal) => {
    console.log(label + ': code=' + code + ' signal=' + signal + ' out=' + JSON.stringify(out.split('\\n').filter(Boolean)));
    resolve();
  });
});
const parked = () => new Promise((resolve) => {
  console.log('begin parked');
  const child = spawn('node', ['-e', ${JSON.stringify(PARKED)}]);
  let out = '';
  let err = '';
  let sent = false;
  child.stderr.on('data', (data) => { err += data; });
  child.stdout.on('data', (data) => {
    out += data;
    if (sent || !out.includes('waiting')) return;
    sent = true;
    setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.stdin.end('x'), 1000);
    }, 1000);
  });
  child.on('close', (code, signal) => {
    console.log('parked: code=' + code + ' signal=' + signal + ' out=' + JSON.stringify(out.split('\\n').filter(Boolean)) + ' err=' + JSON.stringify(err));
    resolve();
  });
});
(async () => {
  await run('a handler that exits', ${JSON.stringify(HEARS)}, ['SIGTERM']);
  await run('a handler that does not', ${JSON.stringify(STUBBORN)}, ['SIGTERM', 'SIGKILL']);
  await run('a handler once, then the default', ${JSON.stringify(ONCE)}, ['SIGTERM', 'SIGTERM']);
  await run('no handler', ${JSON.stringify(PLAIN)}, ['SIGTERM']);
  await parked();
})();
`;

const lines = (text) => text.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0 && !l.startsWith('[facet started'));

const host = spawnSync('node', ['-e', PROGRAM], { encoding: 'utf8', timeout: 60_000 });
assert.equal(host.status, 0, host.stderr);
const expected = lines(host.stdout);
assert.equal(expected.length, 10, host.stdout);

console.log('node-signal-handlers-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const b64 = Buffer.from(PROGRAM).toString('base64');
    const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/handlers.js', Buffer.from('${b64}', 'base64'))"`);
    assert.equal(w.status, 0, w.stdout);
    const r = await terminal.run('node /home/user/handlers.js', 120_000).catch((error) => ({ status: -1, stdout: String(error) }));
    assert.equal(r.status, 0, r.stdout);
    const got = lines(r.stdout);
    for (const line of got) console.log('  ' + line);
    assert.deepEqual(got, expected, 'what a child\'s signal handlers do, as under host node');

  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - node-signal-handlers-workerd (a Node child\'s SIGTERM handler hears its parent\'s kill)');
