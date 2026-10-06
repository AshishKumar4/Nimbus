// @serial
// @tier slow — drives a local workerd; CI median 13 s wall, 11 s CPU, 0.9 GiB peak (6 runs, 2026-10-06)
// A launch too large for one Durable Object turn is paced across turns
// (turn-budget.ts): it suspends, and a fresh turn (the session's launch
// alarm) resumes it. A parent whose own launch was paced, and which then
// waits on a child, must not hold that turn for its whole run: the child's
// launch needs one too.
//
// Reported as: after `npm install` in a session, every later child_process
// child hangs, even `console.log('x')`, while terminal one-shots still run.
// The install put enough into the working tree that every launch there
// crossed a chunk and was paced. NIMBUS_LAUNCH_CHUNK_BYTES forces the same
// pacing on an ordinary launch, without the network.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const PARENT = `
const { spawn } = require('child_process');
const t0 = Date.now();
const c = spawn('node', ['-e', "console.log('child ran')"]);
let out = '';
c.stdout.on('data', (d) => { out += d; });
const stuck = setTimeout(() => { console.log('STUCK ' + JSON.stringify(out)); c.kill(); process.exit(0); }, 60000);
c.on('close', (code) => { clearTimeout(stuck); console.log('CLOSED ' + code + ' ' + JSON.stringify(out) + ' T ' + (Date.now() - t0)); });
`;

console.log('cp-paced-launch-workerd: starting local workerd, every launch paced');
const probe = await startLocalProbe({ runtimes: [], vars: { NIMBUS_LAUNCH_CHUNK_BYTES: '50000' } });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const b64 = Buffer.from(PARENT).toString('base64');
    const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/paced.js', Buffer.from('${b64}', 'base64'))"`);
    assert.equal(w.status, 0, w.stdout);
    const alone = await terminal.run(`node -e "console.log('one-shot ran')"`);
    assert.match(alone.stdout, /^one-shot ran$/m, 'a paced one-shot runs');
    const r = await terminal.run('node /home/user/paced.js', 120_000);
    console.log('  ' + r.stdout.trim().split('\n').at(-1));
    assert.match(r.stdout, /^CLOSED 0 "child ran\\n" T \d+$/m, "a paced parent's child is launched and runs");
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-paced-launch-workerd (a paced parent does not hold the launch turn its child needs)');
