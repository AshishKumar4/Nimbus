// @serial
// The Dynamic Worker ledger never refuses a wait while a shell line has a
// step still to run (fabric budgets.ts, the interpreter's WorkThread), under
// workerd. A parent and eight children, each waiting on a grandchild, fill
// the Durable Object's limit with an npm script's program, pipe.cjs, which
// waits on a grandchild of its own; its pipeline's other element sleeps,
// then kills pipe.cjs (pipekill):
//
//   npm run pipe   # node pipe.cjs | (sleep 8; kill -KILL $(cat pipe.pid))
//
// When `sleep` ends, the kill is the next step: it frees pipe.cjs's worker,
// and the grandchildren run one after another. Nothing may be refused.
// Before, the script's shell counted only its commands: with `sleep` over
// and `kill` not begun, its one unit of work was its await of pipe.cjs, the
// whole family looked stuck for that instant, and the ledger refused the
// newest grandchild (EAGAIN) on the synchronous path of `sleep`'s end. (The
// rest of the ledger's refusals: cp-dynamic-worker-refusal-workerd, -2, -4,
// -5, -6, -7.)
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe, splitScenarioOutput } from './lib/workerd-probe.mjs';

const SCENARIOS = {
  pipekill: `
const { spawn } = require('child_process');
const fs = require('fs');
const N = 8;
const dir = '/home/user/pipefam';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir + '/ready', { recursive: true });
// pipe.cjs's grandchild is spawned first, once the limit is full, so it is
// the oldest wait; the children's come after it.
const script = 'node pipe.cjs | (while [ ! -f ' + dir + '/armed ]; do sleep 1; done; sleep 8; kill -KILL $(cat ' + dir + '/pipe.pid))';
fs.writeFileSync(dir + '/package.json', JSON.stringify({ name: 'pipefam', version: '1.0.0', scripts: { pipe: script } }));
const UNTIL = "const until = async (f) => { for (;;) { try { await require('fs').promises.access(f); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } };";
fs.writeFileSync(dir + '/pipe.cjs', [
  UNTIL,
  "require('fs').writeFileSync('" + dir + "/pipe.pid', String(process.pid));",
  "require('fs').writeFileSync('" + dir + "/ready/pipe', 'ready');",
  "until('" + dir + "/go1').then(() => {",
  "  const g = require('child_process').spawn('node', ['-e', 'console.log(1+1)']);",
  "  require('fs').writeFileSync('" + dir + "/spawned', 'y');",
  "  g.on('close', () => process.exit(0));",
  "});",
].join('\\n'));
const inner = [
  UNTIL,
  "require('fs').writeFileSync('" + dir + "/ready/' + process.pid, 'ready');",
  "until('" + dir + "/go2').then(() => {",
  "  const g = require('child_process').spawn('node', ['-e', 'console.log(1+1)']);",
  "  let o = '';",
  "  g.stdout.on('data', (d) => { o += d; });",
  "  g.on('error', (e) => { console.log('error ' + e.code); process.exit(0); });",
  "  g.on('close', (code) => { console.log('close ' + code + ' ' + o.trim()); process.exit(0); });",
  "});",
].join('\\n');
const results = [];
const done = (line) => { results.push(line); if (results.length === N + 1) console.log(results.sort().join('\\n')); };
for (let i = 0; i < N; i++) {
  const c = spawn('node', ['-e', inner]);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => done(out.trim() + ' ; ' + code));
}
const npm = spawn('sh', ['-c', 'npm run pipe'], { cwd: dir });
npm.on('close', (code) => done((fs.existsSync(dir + '/spawned') ? 'killed pipe.cjs' : 'pipe.cjs never spawned') + ' ; ' + code));
const ticker = setInterval(() => {
  if (!fs.existsSync(dir + '/go1') && fs.readdirSync(dir + '/ready').length === N + 1) fs.writeFileSync(dir + '/go1', 'go');
  if (!fs.existsSync(dir + '/go2') && fs.existsSync(dir + '/spawned')) {
    fs.writeFileSync(dir + '/go2', 'go');
    fs.writeFileSync(dir + '/armed', 'go');
    clearInterval(ticker);
  }
}, 100);
`,
};

console.log('cp-dynamic-worker-refusal-3-workerd: starting local workerd');
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
      // After the kill the grandchildren run as room frees, one launch after
      // another: 100 s on a loaded machine.
      const r = await terminal.run(`node /home/user/${name}.js ${args}`, 280_000, { progress: ledger, stalledMs: 120_000 });
      assert.equal(r.status, 0, `${name}: ${r.stdout.slice(-800)}`);
      return splitScenarioOutput(r.stdout);
    };

    // The family is stuck but for the pipeline's `kill`, its next step once
    // `sleep` ends: nothing may be refused, and every grandchild runs once
    // the kill frees pipe.cjs's worker.
    const pipe = await run('pipekill');
    console.log('  pipekill:\n    ' + pipe.lines.join('\n    '));
    // The program's own lines (the session's report of pipe.cjs's kill goes
    // to the terminal too).
    const said = pipe.lines.filter((line) => / ; -?\d+$/.test(line));
    assert.deepEqual(said, [...Array(8).fill('close 0 2 ; 0'), 'killed pipe.cjs ; 0'],
      "between `sleep` and `kill` no grandchild's spawn is refused: all eight run, and the kill ends pipe.cjs");
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-dynamic-worker-refusal-3-workerd (a family stuck but for a pipeline\'s next step: nothing refused between `sleep` and `kill`)');
