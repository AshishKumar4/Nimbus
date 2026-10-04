// @serial
// A child_process child ended by a signal looks, to its parent, as it does
// under Node: 'exit' and 'close' carry (null, signal), `exitCode` is null,
// `signalCode` names the signal and `killed` is true; spawnSync's result has
// `status: null` and the signal; execFile's error carries `code: null`,
// `signal` and `killed`. Each program runs under host node and
// in a Nimbus session, and their output must be equal.
//
// Before, a killed child reported the shell's status instead: 'exit' (143,
// 'SIGTERM') for every signal but SIGKILL's 137, a SIGINT included;
// spawnSync took no `timeout`; execFile's error carried code 143 and no
// signal.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const LONG = "console.log('up'); setTimeout(() => {}, 60000)";
const PROGRAM = `
const { spawn, spawnSync, execFile } = require('child_process');
const LONG = ${JSON.stringify(LONG)};

const killed = (label, sig) => new Promise((resolve) => {
  const c = spawn('node', ['-e', LONG]);
  const seen = [];
  c.on('exit', (code, signal) => seen.push('exit ' + code + ' ' + signal));
  c.on('close', (code, signal) => {
    seen.push('close ' + code + ' ' + signal);
    console.log(label + ': ' + seen.join(', ') + ' | exitCode=' + c.exitCode + ' signalCode=' + c.signalCode + ' killed=' + c.killed);
    resolve();
  });
  c.stdout.once('data', () => seen.push('kill ' + (sig === undefined ? c.kill() : c.kill(sig))));
});

const sync = async (label, opts) => {
  const r = spawnSync('node', ['-e', 'setTimeout(() => {}, 60000)'], opts);
  const done = r.__deferred ? await r.__deferred : r;
  console.log(label + ': status=' + done.status + ' signal=' + done.signal + ' error=' + (done.error && done.error.code));
};

const callback = (label, start) => new Promise((resolve) => {
  start((err, stdout) => {
    console.log(label + ': code=' + err.code + ' signal=' + err.signal + ' killed=' + err.killed
      + ' cmd=' + JSON.stringify(err.cmd) + ' message=' + JSON.stringify(err.message.split('\\n')[0]) + ' stdout=' + JSON.stringify(stdout));
    resolve();
  });
});

(async () => {
  await killed('kill()');
  await killed("kill('SIGKILL')", 'SIGKILL');
  await killed("kill('SIGINT')", 'SIGINT');
  await sync('spawnSync timeout', { timeout: 2000 });
  await sync('spawnSync timeout SIGKILL', { timeout: 2000, killSignal: 'SIGKILL' });
  await callback('execFile kill()', (cb) => {
    const c = execFile('node', ['-e', LONG], cb);
    c.stdout.once('data', () => c.kill());
  });
  await callback('execFile timeout', (cb) => execFile('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 2000 }, cb));
})();
`;

const lines = (text) => text.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0 && !l.startsWith('[facet started'));

const host = spawnSync('node', ['-e', PROGRAM], { encoding: 'utf8', timeout: 60_000 });
assert.equal(host.status, 0, host.stderr);
const expected = lines(host.stdout);
assert.equal(expected.length, 7, host.stdout);

console.log('cp-child-signals-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const b64 = Buffer.from(PROGRAM).toString('base64');
    const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/signals.js', Buffer.from('${b64}', 'base64'))"`);
    assert.equal(w.status, 0, w.stdout);
    const r = await terminal.run('node /home/user/signals.js', 120_000);
    assert.equal(r.status, 0, r.stdout);
    const got = lines(r.stdout);
    for (const line of got) console.log('  ' + line);
    assert.deepEqual(got, expected, 'what the parent sees of a killed child, as under host node');
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-child-signals-workerd (exit/close, exitCode/signalCode/killed, spawnSync and execFile match node)');
