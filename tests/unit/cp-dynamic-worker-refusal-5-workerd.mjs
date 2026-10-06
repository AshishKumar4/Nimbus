// @serial
// @tier slow — drives a local workerd; bun and two spawnSync chains: 75-221 s under a 1-CPU quota
// The Dynamic Worker ledger's refusal of a wait no release can satisfy
// (fabric budgets.ts), under workerd, for bun and spawnSync children: a
// family that can still go on is never refused, and one that fills the limit
// with each level blocked on the next gets one EAGAIN. Host node has no such
// limit, so these are asserted on their own. ES modules:
// cp-dynamic-worker-refusal-2-workerd (which lists the rest).
//
// What has to hold:
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
  bun10: `
const { spawn } = require('child_process');
// Eight children and their parent hold nine workers; a bun child takes the tenth.
const kids = [];
let up = 0;
// The kids live 10 min: the bun child waiting on room they hold would wait that long.
for (let i = 0; i < 8; i++) {
  const c = spawn('node', ['-e', "console.log('up'); setTimeout(() => {}, 600000)"]);
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
    const by = new Set();
    for (const k of kids) { k.on('close', (code, signal) => { by.add(signal || 'exit ' + code); if (++closed === kids.length) console.log('kids closed by ' + [...by].join(',')); }); k.kill(); }
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

console.log('cp-dynamic-worker-refusal-5-workerd: starting local workerd');
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

    // A bun child taking the tenth worker runs on its launch's admission,
    // though Bun's runner runs it under a pid of its own. Waiting for room
    // its own admission held, it would wait out the kids (10 min) with the
    // ledger still, and the run would stall; it runs while they live, and
    // they end by the parent's kill.
    const bun10 = await run('bun10');
    console.log(`  bun10: bun printed ${bun10.timings['bun data']} ms after its spawn`);
    assert.deepEqual(bun10.lines, ['bun said B 0', 'kids closed by SIGTERM'], 'the bun child did not wait for room its own admission held: it ran while the kids lived');

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
console.log('ok - cp-dynamic-worker-refusal-5-workerd (bun never refused; spawnSync chains: one EAGAIN when they fill the limit)');
