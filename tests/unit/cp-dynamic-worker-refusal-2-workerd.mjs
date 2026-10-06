// @serial
// The Dynamic Worker ledger's refusal of a wait no release can satisfy
// (fabric budgets.ts), under workerd: children of one session that fill the
// Durable Object's limit, each doing nothing but wait on a grandchild of its
// own, get one EAGAIN, as Node's spawn does at a process limit, and the rest
// run; a family that can still go on is never refused. Host node has no such
// limit, so these are asserted on their own. Here ES modules; callbacks:
// cp-dynamic-worker-refusal-workerd; a pipeline's next step: -3; npm
// scripts: -4; bun and spawnSync: -5; shell lines: -6; scheduled exits: -7.
// (The rest of child_process concurrency: cp-concurrent-children-workerd.)
// Each file is its own local workerd, so each fits the suite's per-file
// budget on a loaded machine (ES modules, scheduled exits, bun and spawnSync
// took 452 s in one file under a 1-CPU quota, and the first two 230-300 s).
//
// What has to hold:
//   - nine children, each an ES module blocked inside its top-level await
//     on a grandchild of its own (tladeadlock), fill the limit with their
//     parent: one grandchild's spawn fails EAGAIN and the other eight run.
//     Before, such children never reported their state, and all ten hung.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const SCENARIOS = {
  tladeadlock: `
const { spawn } = require('child_process');
const fs = require('fs');
const N = 9;
// As deadlock, but each child is an ES module whose top-level await waits
// on its grandchild's close: still evaluating, and blocked on its child.
fs.writeFileSync('/home/user/tla-child.mjs', [
  "import { spawn } from 'node:child_process';",
  "import { promises as fs } from 'node:fs';",
  "console.log('ready');",
  "for (;;) { try { await fs.access('/home/user/tla-go'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }",
  "const said = await new Promise((resolve) => {",
  "  const g = spawn('node', ['-e', 'console.log(1+1)']);",
  "  let o = '';",
  "  g.stdout.on('data', (d) => { o += d; });",
  "  g.on('error', (e) => resolve('error ' + e.code));",
  "  g.on('close', (code) => resolve('close ' + code + ' ' + o.trim()));",
  "});",
  "console.log(said);",
].join('\\n'));
try { fs.unlinkSync('/home/user/tla-go'); } catch {}
const results = [];
let ready = 0;
for (let i = 0; i < N; i++) {
  const c = spawn('node', ['/home/user/tla-child.mjs']);
  let out = '';
  c.stdout.on('data', (d) => {
    out += d;
    if (String(d).includes('ready') && ++ready === N) fs.promises.writeFile('/home/user/tla-go', 'go');
  });
  c.on('close', (code) => {
    results.push(out.replace('ready\\n', '').trim() + ' ; ' + code);
    if (results.length === N) console.log(results.sort().join('\\n'));
  });
}
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

console.log('cp-dynamic-worker-refusal-2-workerd: starting local workerd');
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

    // The same nine as ES modules, blocked inside their top-level await: they
    // report it as callbacks do (before, they never did, and all ten hung).
    const tla = await run('tladeadlock');
    console.log('  tladeadlock:\n    ' + tla.lines.join('\n    '));
    assert.deepEqual(tla.lines, ['close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'error EAGAIN ; 0'],
      "one grandchild's spawn fails EAGAIN, and the other eight run, with every child inside its top-level await");
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-dynamic-worker-refusal-2-workerd (ES modules stuck in top-level await: one EAGAIN)');
