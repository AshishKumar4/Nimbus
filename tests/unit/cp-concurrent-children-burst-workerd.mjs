// @serial
// @tier slow — drives a local workerd; 82-168 s alone, 86-235 s on 2 CPUs beside 8 busy loops
// child_process children of one session past the Durable Object's Dynamic
// Worker limit, under workerd. The burst's lines are compared with the same
// program under host node; tsburst, which host node has no ledger for, is
// asserted on its own.
//
// What has to hold:
//   - a burst wider than the Durable Object's Dynamic Worker limit waits on
//     the ledger for room and completes, never past the limit.
//   - with the parent and nine children filling the limit, a TypeScript
//     child waits for room before its transform: its transform, its
//     prebundle and its program are one admission on the ledger, which never
//     counts past the limit (before, the transform facet was an eleventh
//     worker, refused on the platform), and it runs once a child ends.
//
// Children within the limit: cp-concurrent-children-workerd.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const SCENARIOS = {
  burst: `
const { spawn } = require('child_process');
const N = 14;
const results = [];
for (let i = 0; i < N; i++) {
  const c = spawn('node', ['-e', 'setTimeout(() => console.log("C' + i + '"), 3000)']);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => {
    results.push('C' + i + ':' + code + ':' + out.trim());
    if (results.length === N) console.log('ALL ' + results.sort().join(' '));
  });
}
`,
  tsburst: `
const { spawn } = require('child_process');
require('fs').writeFileSync('/home/user/child.ts', "const n: number = 40 + 2;\\nconsole.log('TS ' + n);\\n");
const results = [];
const done = (label) => (code) => { results.push(label + ':' + code); if (results.length === 10) console.log('ALL ' + results.sort().join(' ')); };
// Once all nine run, with the parent they fill the limit.
let up = 0;
for (let i = 0; i < 9; i++) {
  const c = spawn('node', ['-e', "console.log('up'); setTimeout(() => {}, 3000)"]);
  c.stdout.once('data', () => { if (++up === 9) startTs(); });
  c.on('close', done('C' + i));
}
function startTs() {
  const ts = spawn('node', ['/home/user/child.ts']);
  let out = '';
  ts.stdout.on('data', (d) => { out += d; });
  ts.on('close', (code) => { console.log('TS said ' + out.trim()); done('TS')(code); });
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

// Host node has no Dynamic Worker ledger to wait on; tsburst is asserted on its own.
const NO_DIFFERENTIAL = new Set(['tsburst']);
const host = {};
for (const [name, source] of Object.entries(SCENARIOS)) {
  if (NO_DIFFERENTIAL.has(name)) continue;
  const r = spawnSync('node', ['-e', source], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `host node ${name}: ${r.stderr}`);
  host[name] = split(r.stdout);
}

console.log('cp-concurrent-children-burst-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    for (const [name, source] of Object.entries(SCENARIOS)) {
      const b64 = Buffer.from(source).toString('base64');
      const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/${name}.js', Buffer.from('${b64}', 'base64'))"`);
      assert.equal(w.status, 0, w.stdout);
    }
    // A scenario's family can take minutes on a loaded machine, one launch
    // after another: what tells a hang from that is the session's Dynamic
    // Worker ledger, which stops changing.
    const ledger = async () => { const { loader } = await terminal.memory(); return [loader.holders, loader.waiters, loader.news]; };
    const run = async (name, { poll, args = '' } = {}) => {
      const samples = [];
      let polling = !!poll;
      const poller = (async () => {
        while (polling) {
          samples.push((await terminal.memory()).loader);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })();
      const r = await terminal.run(`node /home/user/${name}.js ${args}`, 280_000, { progress: ledger, stalledMs: 120_000 });
      polling = false;
      await poller;
      assert.equal(r.status, 0, `${name}: ${r.stdout.slice(-800)}`);
      const got = split(r.stdout);
      if (!NO_DIFFERENTIAL.has(name)) assert.deepEqual(got.lines, host[name].lines, `${name}: the same lines, in the same order, as under host node`);
      return { ...got, samples };
    };

    const burst = await run('burst', { poll: true });
    const waited = Math.max(...burst.samples.map((s) => s.waiting));
    const peak = Math.max(...burst.samples.map((s) => s.peak));
    console.log(`  burst: 14 children, at most ${waited} waiting for room at once, ledger peak ${peak}`);
    assert.ok(waited > 0, 'the burst was wider than the room: some children waited on the ledger');
    assert.ok(peak <= burst.samples[0].limit, `and none went past the Dynamic Worker limit (peak ${peak})`);

    const tsburst = await run('tsburst', { poll: true });
    const tsPeak = Math.max(...tsburst.samples.map((s) => s.peak));
    console.log(`  tsburst: ledger peak ${tsPeak}`);
    assert.deepEqual(tsburst.lines, ['TS said TS 42', 'ALL C0:0 C1:0 C2:0 C3:0 C4:0 C5:0 C6:0 C7:0 C8:0 TS:0']);
    assert.ok(tsPeak <= tsburst.samples[0].limit, `the TypeScript child's transform waited inside its admission: peak ${tsPeak}`);
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-concurrent-children-burst-workerd (a burst past the limit waits for room; a TypeScript child waits inside its admission)');
