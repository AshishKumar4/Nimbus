// @serial
// @tier slow — drives a local workerd; nine children and their grandchildren: 35-271 s under a 1-CPU quota
// The Dynamic Worker ledger's refusal of a wait no release can satisfy
// (fabric budgets.ts), under workerd, never refuses a family that can still
// go on: nine children that fill the Durable Object's limit with their
// parent, each waiting on a grandchild of its own but with process.exit(0)
// scheduled (exitsched), end on their own, so no grandchild's spawn is
// refused (before, it was refused from ancestry alone). Host node has no
// such limit, so this is asserted on its own. ES modules stuck in their
// top-level await: cp-dynamic-worker-refusal-2-workerd (which lists the
// rest).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe, splitScenarioOutput } from './lib/workerd-probe.mjs';

const SCENARIOS = {
  exitsched: `
const { spawn } = require('child_process');
const fs = require('fs');
const N = 9;
// As deadlock, but each child also has process.exit(0) scheduled: it will
// end on its own, so its grandchild's wait is not refused.
const inner = [
  "const go = async () => { for (;;) { try { await require('fs').promises.access('/home/user/exitsched-go'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } };",
  "go().then(() => {",
  "  setTimeout(() => process.exit(0), 3000);",
  "  const g = require('child_process').spawn('node', ['-e', 'console.log(1+1)']);",
  "  g.on('error', (e) => console.log('error ' + e.code));",
  "});",
  "console.log('ready');",
].join('\\n');
try { fs.unlinkSync('/home/user/exitsched-go'); } catch {}
const results = [];
let ready = 0;
for (let i = 0; i < N; i++) {
  const c = spawn('node', ['-e', inner]);
  let out = '';
  c.stdout.on('data', (d) => {
    out += d;
    if (String(d).includes('ready') && ++ready === N) fs.promises.writeFile('/home/user/exitsched-go', 'go');
  });
  c.on('close', (code) => {
    results.push(out.replace('ready\\n', '').trim() + ';' + code);
    if (results.length === N) console.log('CHILDREN ' + results.sort().join(' '));
  });
}
`,
};

console.log('cp-dynamic-worker-refusal-7-workerd: starting local workerd');
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

    // The same nine, each with process.exit(0) scheduled: they end on their
    // own, so no grandchild is refused (refused from ancestry alone before).
    const exitsched = await run('exitsched');
    console.log('  exitsched: ' + exitsched.lines.join(' '));
    assert.deepEqual(exitsched.lines, ['CHILDREN ' + Array(9).fill(';0').join(' ')],
      'children with a process.exit scheduled are not blocked: no spawn of theirs is refused, and all exit 0');
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-dynamic-worker-refusal-7-workerd (children with a scheduled exit are never refused)');
