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
//   - with the parent and nine children filling the limit, a TypeScript
//     child waits for room before its transform: its transform, its
//     prebundle and its program are one admission on the ledger, which never
//     counts past the limit (before, the transform facet was an eleventh
//     worker, refused on the platform), and it runs once a child ends.
//   - nine children, each waiting on a grandchild of its own, fill the limit
//     with their parent: no grandchild can ever start. The newest one's
//     spawn fails as Node's does at a process limit ('error', EAGAIN, no
//     'exit', no pid, 'close' with -11), its parent ends, and the other
//     eight grandchildren run. Host node has no such limit, so this one is
//     not compared with it. Before, all of them waited for good.
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

// Host node has no Dynamic Worker limit to deadlock on; that scenario is asserted on its own.
const NO_DIFFERENTIAL = new Set(['deadlock', 'tsburst']);
const host = {};
for (const [name, source] of Object.entries(SCENARIOS)) {
  if (NO_DIFFERENTIAL.has(name)) continue;
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
      if (!NO_DIFFERENTIAL.has(name)) assert.deepEqual(got.lines, host[name].lines, `${name}: the same lines, in the same order, as under host node`);
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
    // One at a time they take 8 × (a launch + 4 s); a launch is CPU this
    // machine's workerd runs in turn, the 4 s are not.
    const serial = 8 * (floor + 4_000);
    assert.ok(many.timings['all closed'] < serial - 3 * 4_000,
      `their lives overlapped: one at a time they take ${serial} ms or more`);

    const burst = await run('burst', { poll: true });
    const waited = Math.max(...burst.samples.map((s) => s.waiting));
    const peak = Math.max(...burst.samples.map((s) => s.peak));
    console.log(`  burst: 14 children, at most ${waited} waiting for room at once, ledger peak ${peak}`);
    assert.ok(waited > 0, 'the burst was wider than the room: some children waited on the ledger');
    assert.ok(peak <= burst.samples[0].limit, `and none went past the Dynamic Worker limit (peak ${peak})`);

    await run('nested');

    const tsburst = await run('tsburst', { poll: true });
    const tsPeak = Math.max(...tsburst.samples.map((s) => s.peak));
    console.log(`  tsburst: ledger peak ${tsPeak}`);
    assert.deepEqual(tsburst.lines, ['TS said TS 42', 'ALL C0:0 C1:0 C2:0 C3:0 C4:0 C5:0 C6:0 C7:0 C8:0 TS:0']);
    assert.ok(tsPeak <= tsburst.samples[0].limit, `the TypeScript child's transform waited inside its admission: peak ${tsPeak}`);

    const deadlock = await run('deadlock');
    console.log('  deadlock:\n    ' + deadlock.lines.join('\n    '));
    const ran = 'exit 0 | close 0 null 2 ; 0';
    const refused = 'error EAGAIN -11 spawn node node ["-e","console.log(1+1)"] spawn node EAGAIN pid=undefined | close -11 null ; 0';
    assert.deepEqual(deadlock.lines, [refused, ...Array(8).fill(ran)],
      "the newest grandchild's spawn fails EAGAIN, as Node's at a process limit, and the other eight run");
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-concurrent-children-workerd (B beside a live A, kill frees at once, N together, a burst past the limit, nested)');
