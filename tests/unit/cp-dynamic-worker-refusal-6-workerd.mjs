// @serial
// @tier slow — drives a local workerd; nine shell lines and their grandchildren: 85-204 s under a 1-CPU quota
// The Dynamic Worker ledger's refusal of a wait no release can satisfy
// (fabric budgets.ts), under workerd, through shell lines: nine children of
// one session, each `sh -c 'node <program>'` whose program waits on a
// grandchild of its own, fill the limit with their parent. Host node has no
// such limit, so this is asserted on its own. Callbacks:
// cp-dynamic-worker-refusal-workerd (which lists the rest).
//
// What has to hold:
//   - the parent's children are shells, which hold no worker: each shell
//     awaits its program, and is stuck exactly when it is, so one
//     grandchild's spawn fails EAGAIN and the other eight run. Before, the
//     parent named the shells, which held no worker and said nothing, and
//     all ten hung.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const SCENARIOS = {
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

/**
 * The scenario's lines with its timing lines set aside, and the session's
 * own banners (a facet's start, an npm script's), which go to the terminal.
 */
function split(text) {
  const lines = text.split('\n').map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !l.startsWith('[facet started') && !l.startsWith('[shell started'));
  const timings = {};
  for (const line of lines) {
    const m = /^T (\d+) (.+)$/.exec(line);
    if (m) timings[m[2]] = Number(m[1]);
  }
  return { lines: lines.filter((l) => !/^T \d+ /.test(l)), timings };
}

console.log('cp-dynamic-worker-refusal-6-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    for (const [name, source] of Object.entries(SCENARIOS)) {
      const b64 = Buffer.from(source).toString('base64');
      const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/${name}.js', Buffer.from('${b64}', 'base64'))"`);
      assert.equal(w.status, 0, w.stdout);
    }
    // A family here can take minutes on a loaded machine, one launch after
    // another, and the session's own later turn (the ledger's refusal) came
    // 1 to 23 s late under contention: what tells a hang from that is the
    // session's Dynamic Worker ledger, which stops changing.
    const ledger = async () => { const { loader } = await terminal.memory(); return [loader.holders, loader.waiters, loader.news]; };
    const run = async (name, { args = '' } = {}) => {
      const r = await terminal.run(`node /home/user/${name}.js ${args}`, 280_000, { progress: ledger, stalledMs: 120_000 });
      assert.equal(r.status, 0, `${name}: ${r.stdout.slice(-800)}`);
      return split(r.stdout);
    };

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
console.log('ok - cp-dynamic-worker-refusal-6-workerd (nine children stuck on grandchildren through shell lines: one EAGAIN, eight runs)');
