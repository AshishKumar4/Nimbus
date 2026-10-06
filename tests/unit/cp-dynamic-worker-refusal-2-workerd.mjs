// @serial
// The Dynamic Worker ledger's refusal of a wait no release can satisfy
// (fabric budgets.ts), under workerd: children of one session that fill the
// Durable Object's limit, each doing nothing but wait on a grandchild of its
// own, get one EAGAIN, as Node's spawn does at a process limit, and the rest
// run; a family that can still go on is never refused. Host node has no such
// limit, so these are asserted on their own. Here ES modules, scheduled
// exits, bun and spawnSync; callbacks and shell lines:
// cp-dynamic-worker-refusal-workerd; a pipeline's next step: -3; npm
// scripts: -4. (The rest of child_process concurrency:
// cp-concurrent-children-workerd.)
//
// What has to hold:
//   - nine children, each an ES module blocked inside its top-level await
//     on a grandchild of its own (tladeadlock), fill the limit with their
//     parent: one grandchild's spawn fails EAGAIN and the other eight run.
//     Before, such children never reported their state, and all ten hung.
//   - the same nine, each with process.exit(0) scheduled (exitsched), end on
//     their own: no grandchild is refused.
//   - a bun child taking the tenth worker (bun10) runs on its launch's
//     admission, though Bun's runner runs it under a pid of its own.
//   - a spawnSync chain within the limit completes (syncchain); two chains
//     and their parent filling it (syncfork) get one leaf's spawnSync
//     EAGAIN, and both chains finish.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe, splitScenarioOutput } from './lib/workerd-probe.mjs';

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
  bun10: `
const { spawn } = require('child_process');
// Eight children and their parent hold nine workers; a bun child takes the tenth.
const kids = [];
let up = 0;
for (let i = 0; i < 8; i++) {
  const c = spawn('node', ['-e', "console.log('up'); setTimeout(() => {}, 60000)"]);
  c.stdout.once('data', () => { if (++up === 8) runBun(); });
  kids.push(c);
}
function runBun() {
  const t0 = Date.now();
  const b = spawn('bun', ['-e', "console.log('B')"]);
  let out = '';
  b.stdout.on('data', (d) => { if (!out) console.log('T ' + (Date.now() - t0) + ' bun data'); out += d; });
  b.on('close', (code) => {
    console.log('bun said ' + out.trim() + ' ' + code);
    let closed = 0;
    for (const k of kids) { k.on('close', () => { if (++closed === kids.length) console.log('kids closed'); }); k.kill(); }
  });
}
`,
  syncchain: `
const { spawnSync } = require('child_process');
const depth = Number(process.argv[2] || 1), max = Number(process.argv[3] || 5);
(async () => {
  if (depth === max) { console.log('leaf ' + depth); return; }
  const r = spawnSync('node', ['/home/user/syncchain.js', String(depth + 1), String(max)], { encoding: 'utf8' });
  const done = r.__deferred ? await r.__deferred : r;
  const below = (done.stdout || '').trim().split('\\n').join(' / ');
  console.log('level ' + depth + ' status=' + done.status + ' error=' + (done.error && done.error.code) + (below ? ' [' + below + ']' : ''));
})();
`,
  syncfork: `
const { spawn } = require('child_process');
// Two spawnSync chains (syncchain.js), five and four levels deep, with this
// parent hold ten workers, every one waiting on the next level only: a
// leaf of each waits for room.
const results = [];
for (const max of ['6', '5']) {
  const c = spawn('node', ['/home/user/syncchain.js', '1', max]);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => {
    results.push(out.trim() + ' ; ' + code);
    if (results.length === 2) console.log(results.join('\\n'));
  });
}
`,
};

console.log('cp-dynamic-worker-refusal-2-workerd: starting local workerd');
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

    // The same nine as ES modules, blocked inside their top-level await: they
    // report it as callbacks do (before, they never did, and all ten hung).
    const tla = await run('tladeadlock');
    console.log('  tladeadlock:\n    ' + tla.lines.join('\n    '));
    assert.deepEqual(tla.lines, ['close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'error EAGAIN ; 0'],
      "one grandchild's spawn fails EAGAIN, and the other eight run, with every child inside its top-level await");

    // The same nine, each with process.exit(0) scheduled: they end on their
    // own, so no grandchild is refused (refused from ancestry alone before).
    const exitsched = await run('exitsched');
    console.log('  exitsched: ' + exitsched.lines.join(' '));
    assert.deepEqual(exitsched.lines, ['CHILDREN ' + Array(9).fill(';0').join(' ')],
      'children with a process.exit scheduled are not blocked: no spawn of theirs is refused, and all exit 0');

    // A bun child taking the tenth worker runs on its launch's admission,
    // though Bun's runner runs it under a pid of its own. Waiting for room
    // its own admission held, it would wait out the kids (60 s); a loaded
    // machine takes 10 s to launch it.
    const bun10 = await run('bun10');
    console.log(`  bun10: bun printed ${bun10.timings['bun data']} ms after its spawn`);
    assert.deepEqual(bun10.lines, ['bun said B 0', 'kids closed']);
    assert.ok(bun10.timings['bun data'] < 30_000, `the bun child did not wait for room its own admission held (${bun10.timings['bun data']} ms)`);

    // A spawnSync chain: each level waits on the next and nothing else.
    const shallow = await run('syncchain', { args: '1 5' });
    assert.deepEqual(shallow.lines, ['level 1 status=0 error=undefined [level 2 status=0 error=undefined [level 3 status=0 error=undefined [level 4 status=0 error=undefined [leaf 5]]]]'],
      'a chain within the limit completes');
    const fork = await run('syncfork');
    console.log('  syncfork:\n    ' + fork.lines.join('\n    '));
    const text = fork.lines.join('\n');
    assert.equal(fork.lines.length, 2, text);
    assert.equal((text.match(/error=EAGAIN/g) || []).length, 1,
      "two chains and their parent fill the limit, each level blocked on the next: one leaf's spawnSync fails EAGAIN");
    assert.equal((text.match(/\[leaf \d\]/g) || []).length, 1, 'and its chain unwinds, which lets the other chain finish');
    assert.ok(fork.lines.every((line) => line.endsWith(' ; 0')), text);
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-dynamic-worker-refusal-2-workerd (ES modules stuck in top-level await: one EAGAIN; scheduled exits and bun never refused; spawnSync chains)');
