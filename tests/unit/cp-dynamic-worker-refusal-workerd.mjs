// @serial
// @tier slow — drives a local workerd; CI median 25 s wall, 38 s CPU, 2.5 GiB peak (6 runs, 2026-10-06)
// The Dynamic Worker ledger's refusal of a wait no release can satisfy
// (fabric budgets.ts), under workerd: children of one session that fill the
// Durable Object's limit, each doing nothing but wait on a grandchild of its
// own, get one EAGAIN, as Node's spawn does at a process limit, and the rest
// run; a family that can still go on is never refused. Host node has no such
// limit, so these are asserted on their own. Here callbacks and shell
// lines; ES modules, scheduled exits, bun and spawnSync: -2; a pipeline's
// next step: -3; npm scripts: -4. (The rest of child_process concurrency:
// cp-concurrent-children-workerd.)
//
// What has to hold:
//   - nine children, each waiting on a grandchild of its own, fill the limit
//     with their parent: no grandchild can ever start. The newest one's
//     spawn fails as Node's does at a process limit ('error', EAGAIN, no
//     'exit', no pid, 'close' with -11), its parent ends, and the other
//     eight grandchildren run. Before, all of them waited for good.
//   - the same with each child a shell line running the program
//     (shdeadlock): the parent's children are shells, which hold no worker;
//     before, they were never stuck, and all ten hung.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe, splitScenarioOutput } from './lib/workerd-probe.mjs';

const SCENARIOS = {
  deadlock: `
const { spawn } = require('child_process');
const fs = require('fs');
const N = 9;
// Each child spawns its grandchild once all nine are running: the parent
// writes /home/user/deadlock-go then, and each child polls for it.
const inner = [
  "const go = async () => { for (;;) { try { await require('fs').promises.access('/home/user/deadlock-go'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } };",
  "go().then(() => {",
  "  const g = require('child_process').spawn('node', ['-e', 'console.log(1+1)']);",
  "  let o = '';",
  "  g.stdout.on('data', (d) => { o += d; });",
  "  g.on('spawn', () => console.log('spawn'));",
  "  g.on('error', (e) => console.log('error ' + [e.code, e.errno, e.syscall, e.path, JSON.stringify(e.spawnargs), e.message, 'pid=' + g.pid].join(' ')));",
  "  g.on('exit', (code) => console.log('exit ' + code));",
  "  g.on('close', (code, signal) => { console.log('close ' + code + ' ' + signal + ' ' + o.trim()); process.exit(0); });",
  "});",
  "console.log('ready');",
].join('\\n');
try { fs.unlinkSync('/home/user/deadlock-go'); } catch {}
const results = [];
let ready = 0;
for (let i = 0; i < N; i++) {
  const c = spawn('node', ['-e', inner]);
  let out = '';
  c.stdout.on('data', (d) => {
    out += d;
    if (String(d).includes('ready') && ++ready === N) fs.promises.writeFile('/home/user/deadlock-go', 'go');
  });
  c.on('close', (code) => {
    results.push(out.replace('ready\\n', '').trim().split('\\n').join(' | ') + ' ; ' + code);
    if (results.length === N) console.log(results.sort().join('\\n'));
  });
}
`,
  shdeadlock: `
const { spawn } = require('child_process');
const fs = require('fs');
const N = 9;
// As deadlock, but each child is a shell line, sh -c 'node <program>': the
// parent's child is the shell, and the program, which spawns and waits on a
// grandchild, runs under a pid of its own the parent never names. A shell
// line hands its program's output back when the program ends, so readiness
// is a file each program writes.
fs.writeFileSync('/home/user/sh-child.js', [
  "const fs = require('fs');",
  "fs.writeFileSync('/home/user/shready/' + process.pid, 'ready');",
  "const go = async () => { for (;;) { try { await fs.promises.access('/home/user/shdeadlock-go'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } };",
  "go().then(() => {",
  "  const g = require('child_process').spawn('node', ['-e', 'console.log(1+1)']);",
  "  let o = '';",
  "  g.stdout.on('data', (d) => { o += d; });",
  "  g.on('error', (e) => { console.log('error ' + e.code); process.exit(0); });",
  "  g.on('close', (code) => { console.log('close ' + code + ' ' + o.trim()); process.exit(0); });",
  "});",
].join('\\n'));
try { fs.unlinkSync('/home/user/shdeadlock-go'); } catch {}
fs.rmSync('/home/user/shready', { recursive: true, force: true });
fs.mkdirSync('/home/user/shready');
const results = [];
for (let i = 0; i < N; i++) {
  const c = spawn('sh', ['-c', 'node /home/user/sh-child.js']);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => {
    results.push(out.trim() + ' ; ' + code);
    if (results.length === N) console.log(results.sort().join('\\n'));
  });
}
const poll = setInterval(() => {
  if (fs.readdirSync('/home/user/shready').length < N) return;
  clearInterval(poll);
  fs.writeFileSync('/home/user/shdeadlock-go', 'go');
}, 100);
`,
};

console.log('cp-dynamic-worker-refusal-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    for (const [name, source] of Object.entries(SCENARIOS)) await terminal.writeFile(`/home/user/${name}.js`, source);
    const run = async (name, { args = '' } = {}) => {
      const r = await terminal.run(`node /home/user/${name}.js ${args}`, 180_000);
      assert.equal(r.status, 0, `${name}: ${r.stdout.slice(-800)}`);
      return splitScenarioOutput(r.stdout);
    };

    const deadlock = await run('deadlock');
    console.log('  deadlock:\n    ' + deadlock.lines.join('\n    '));
    const ran = 'spawn | exit 0 | close 0 null 2 ; 0';
    const refused = 'error EAGAIN -11 spawn node node ["-e","console.log(1+1)"] spawn node EAGAIN pid=undefined | close -11 null ; 0';
    assert.deepEqual(deadlock.lines, [refused, ...Array(8).fill(ran)],
      "the newest grandchild's spawn fails EAGAIN, as Node's at a process limit (no 'spawn', no pid), and the other eight run");

    // The same nine as shell lines over their programs: the shell awaits its
    // program, and is stuck exactly when it is (before, the parent named
    // the shells, which held no worker and said nothing, and all ten hung).
    const sh = await run('shdeadlock');
    console.log('  shdeadlock:\n    ' + sh.lines.join('\n    '));
    assert.deepEqual(sh.lines, ['close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'error EAGAIN ; 0'],
      "through sh -c, one grandchild's spawn fails EAGAIN, and the other eight run");
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-dynamic-worker-refusal-workerd (nine children stuck on grandchildren, through callbacks or shell lines: one EAGAIN, eight runs)');
