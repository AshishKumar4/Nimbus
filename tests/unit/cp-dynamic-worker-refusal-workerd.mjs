// @serial
// @tier slow — drives a local workerd; CI median 25 s wall, 38 s CPU, 2.5 GiB peak (6 runs, 2026-10-06)
// The Dynamic Worker ledger's refusal of a wait no release can satisfy
// (fabric budgets.ts), under workerd: children of one session that fill the
// Durable Object's limit, each doing nothing but wait on a grandchild of its
// own, get one EAGAIN, as Node's spawn does at a process limit, and the rest
// run; a family that can still go on is never refused. Host node has no such
// limit, so these are asserted on their own. Here callbacks; shell lines:
// -6; ES modules: -2; scheduled exits: -7; bun and spawnSync: -5; a
// pipeline's next step: -3; npm scripts: -4. (The rest of child_process
// concurrency: cp-concurrent-children-workerd.) Each file is its own local
// workerd, so each fits the suite's per-file budget on a loaded machine
// (callbacks and shell lines took 283 s in one file under a 1-CPU quota).
//
// What has to hold:
//   - nine children, each waiting on a grandchild of its own, fill the limit
//     with their parent: no grandchild can ever start. The newest one's
//     spawn fails as Node's does at a process limit ('error', EAGAIN, no
//     'exit', no pid, 'close' with -11), its parent ends, and the other
//     eight grandchildren run. Before, all of them waited for good.
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
};

console.log('cp-dynamic-worker-refusal-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    for (const [name, source] of Object.entries(SCENARIOS)) await terminal.writeFile(`/home/user/${name}.js`, source);
    // A family here can take minutes on a loaded machine, one launch after
    // another, and the session's own later turn (the ledger's refusal) came
    // 1 to 23 s late under contention: what tells a hang from that is the
    // session's Dynamic Worker ledger, which stops changing.
    const ledger = async () => { const { loader } = await terminal.memory(); return [loader.holders, loader.waiters, loader.news]; };
    const run = async (name, { args = '' } = {}) => {
      const r = await terminal.run(`node /home/user/${name}.js ${args}`, 280_000, { progress: ledger, stalledMs: 120_000 });
      assert.equal(r.status, 0, `${name}: ${r.stdout.slice(-800)}`);
      return splitScenarioOutput(r.stdout);
    };

    const deadlock = await run('deadlock');
    console.log('  deadlock:\n    ' + deadlock.lines.join('\n    '));
    const ran = 'spawn | exit 0 | close 0 null 2 ; 0';
    const refused = 'error EAGAIN -11 spawn node node ["-e","console.log(1+1)"] spawn node EAGAIN pid=undefined | close -11 null ; 0';
    assert.deepEqual(deadlock.lines, [refused, ...Array(8).fill(ran)],
      "the newest grandchild's spawn fails EAGAIN, as Node's at a process limit (no 'spawn', no pid), and the other eight run");
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-dynamic-worker-refusal-workerd (nine children stuck on grandchildren, through callbacks: one EAGAIN, eight runs)');
