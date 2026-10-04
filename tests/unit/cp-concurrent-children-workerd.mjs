// @serial
// child_process children of one session run concurrently, as Node's do,
// under workerd. Each scenario's deterministic lines are compared with the
// same program under host node; its timing lines (`T <ms> ...`) are asserted
// on their own.
//
// What has to hold:
//   - a child that never exits (a server, a watcher) does not hold back a
//     second child: B prints while A lives, about as soon as a child spawned
//     alone does. Before, B waited the whole of A's life (15.6 s on a 15 s A),
//     queued behind A on the one slot of the spawn pool that relayed it.
//   - killing A frees what it held at once: a child spawned after the kill
//     runs at once, and A's Dynamic Worker leaves the ledger (before, A's
//     program ran on to its natural end and held both).
//   - N children spawned together all run at once and all complete.
//   - a burst wider than the Durable Object's Dynamic Worker limit waits on
//     the ledger for room and completes, never past the limit.
//   - a child that spawns a grandchild and waits for it completes (before,
//     the grandchild queued behind its own parent: a deadlock).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const SCENARIOS = {
  solo: `
const { spawn } = require('child_process');
const t0 = Date.now();
const b = spawn('node', ['-e', "console.log('B ran')"]);
b.stdout.once('data', () => console.log('T ' + (Date.now() - t0) + ' B data'));
b.stdout.on('data', (d) => process.stdout.write(String(d)));
b.on('close', (code) => console.log('B close ' + code));
`,
  ab: `
const { spawn } = require('child_process');
const t0 = Date.now();
const a = spawn('node', ['-e', "setTimeout(() => console.log('A done'), 12000)"]);
const b = spawn('node', ['-e', "console.log('B ran')"]);
b.stdout.once('data', () => console.log('T ' + (Date.now() - t0) + ' B data'));
b.stdout.on('data', (d) => process.stdout.write(String(d)));
b.on('close', (code) => console.log('B close ' + code));
a.stdout.on('data', (d) => process.stdout.write(String(d)));
a.on('close', (code) => { console.log('T ' + (Date.now() - t0) + ' A close'); console.log('A close ' + code); });
`,
  kill: `
const { spawn } = require('child_process');
const a = spawn('node', ['-e', "console.log('A up'); setTimeout(() => console.log('A done'), 120000)"]);
a.stdout.once('data', (d) => {
  process.stdout.write(String(d));
  console.log('kill ' + a.kill());
});
a.on('close', (_code, signal) => {
  console.log('A closed by ' + signal);
  const t0 = Date.now();
  const b = spawn('node', ['-e', "console.log('B ran')"]);
  b.stdout.once('data', () => console.log('T ' + (Date.now() - t0) + ' B data'));
  b.stdout.on('data', (d) => process.stdout.write(String(d)));
  b.on('close', (code) => console.log('B close ' + code));
});
`,
  many: `
const { spawn } = require('child_process');
const t0 = Date.now();
const N = 8;
const results = [];
for (let i = 0; i < N; i++) {
  const c = spawn('node', ['-e', 'setTimeout(() => console.log("C' + i + '"), 4000)']);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => {
    results.push('C' + i + ':' + code + ':' + out.trim());
    if (results.length === N) {
      console.log('T ' + (Date.now() - t0) + ' all closed');
      console.log('ALL ' + results.sort().join(' '));
    }
  });
}
`,
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
  nested: `
const { spawn } = require('child_process');
const inner = "const g = require('child_process').spawn('node', ['-e', 'console.log(1+1)']); let o = ''; g.stdout.on('data', (d) => { o += d; }); g.on('close', (code) => console.log('G said ' + o.trim() + ' code ' + code));";
const c = spawn('node', ['-e', inner]);
c.stdout.on('data', (d) => process.stdout.write(String(d)));
c.on('close', (code) => console.log('C close ' + code));
`,
};

/** The scenario's lines with its timing lines set aside. */
function split(text) {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0 && !l.startsWith('[facet started'));
  const timings = {};
  for (const line of lines) {
    const m = /^T (\d+) (.+)$/.exec(line);
    if (m) timings[m[2]] = Number(m[1]);
  }
  return { lines: lines.filter((l) => !/^T \d+ /.test(l)), timings };
}

const host = {};
for (const [name, source] of Object.entries(SCENARIOS)) {
  const r = spawnSync('node', ['-e', source], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `host node ${name}: ${r.stderr}`);
  host[name] = split(r.stdout);
}

console.log('cp-concurrent-children-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    for (const [name, source] of Object.entries(SCENARIOS)) {
      const b64 = Buffer.from(source).toString('base64');
      const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/${name}.js', Buffer.from('${b64}', 'base64'))"`);
      assert.equal(w.status, 0, w.stdout);
    }
    const run = async (name, { poll } = {}) => {
      const samples = [];
      let polling = !!poll;
      const poller = (async () => {
        while (polling) {
          samples.push((await terminal.memory()).loader);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })();
      const r = await terminal.run(`node /home/user/${name}.js`, 180_000);
      polling = false;
      await poller;
      assert.equal(r.status, 0, `${name}: ${r.stdout.slice(-800)}`);
      const got = split(r.stdout);
      assert.deepEqual(got.lines, host[name].lines, `${name}: the same lines, in the same order, as under host node`);
      return { ...got, samples };
    };

    // A child spawned alone: the floor a second child is measured against.
    const solo = await run('solo');
    const floor = solo.timings['B data'];
    console.log(`  solo: B printed ${floor} ms after its spawn`);

    const ab = await run('ab');
    console.log(`  ab: B printed at ${ab.timings['B data']} ms while A ran to ${ab.timings['A close']} ms`);
    assert.ok(ab.timings['B data'] < ab.timings['A close'] - 5_000, 'B printed while A was still running, well before A ended');
    assert.ok(ab.timings['B data'] < floor + 2_000,
      `B printed about as soon as a child spawned alone (${ab.timings['B data']} ms against ${floor} ms): A held nothing B needed`);

    const killed = await run('kill');
    console.log(`  kill: B printed ${killed.timings['B data']} ms after A was killed`);
    assert.ok(killed.timings['B data'] < floor + 2_000, `a child spawned after the kill runs at once (${killed.timings['B data']} ms)`);
    // The parent has exited; A's program must not run on, holding its worker, for the rest of its 120 s.
    let ledger = (await terminal.memory()).loader;
    for (let i = 0; i < 20 && ledger.inFlightWorkers.length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ledger = (await terminal.memory()).loader;
    }
    assert.deepEqual(ledger.inFlightWorkers, [], "the killed child's Dynamic Worker left the ledger with it");

    const many = await run('many');
    console.log(`  many: 8 children of 4 s each all closed at ${many.timings['all closed']} ms`);
    assert.ok(many.timings['all closed'] < 8 * 4_000 * 0.75, 'their lives overlapped: run one at a time they take 32 s or more');

    const burst = await run('burst', { poll: true });
    const waited = Math.max(...burst.samples.map((s) => s.waiting));
    const peak = Math.max(...burst.samples.map((s) => s.peak));
    console.log(`  burst: 14 children, at most ${waited} waiting for room at once, ledger peak ${peak}`);
    assert.ok(waited > 0, 'the burst was wider than the room: some children waited on the ledger');
    assert.ok(peak <= burst.samples[0].limit, `and none went past the Dynamic Worker limit (peak ${peak})`);

    await run('nested');
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-concurrent-children-workerd (B beside a live A, kill frees at once, N together, a burst past the limit, nested)');
