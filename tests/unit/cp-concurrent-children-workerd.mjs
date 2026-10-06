// @serial
// child_process children of one session run concurrently, as Node's do,
// under workerd. Each scenario's deterministic lines are compared with the
// same program under host node; its timing lines (`T <ms> ...`) are asserted
// on their own.
//
// What has to hold:
//   - a child that never exits (a server, a watcher) does not hold back a
//     second child: B prints while A lives, in the first half of A's life.
//     Before, B waited the whole of A's life (15.6 s on a 15 s A), queued
//     behind A on the one slot of the spawn pool that relayed it.
//   - killing A frees what it held at once: a child spawned after the kill
//     runs at once, and A's Dynamic Worker leaves the ledger (before, A's
//     program ran on to its natural end and held both).
//   - N children spawned together all run at once and all complete.
//   - a child that spawns a grandchild and waits for it completes (before,
//     the grandchild queued behind its own parent: a deadlock).
//
// Children past the Durable Object's Dynamic Worker limit:
// cp-concurrent-children-burst-workerd. The ledger's refusal of a wait
// nothing can satisfy (children filling the limit, each waiting on a
// grandchild): cp-dynamic-worker-refusal-workerd.
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
// Each child says it is up, then waits for a word on stdin that the parent
// sends only once all N are up: they end only if all N ran at once.
const children = [];
let up = 0;
for (let i = 0; i < N; i++) {
  const c = spawn('node', ['-e', 'console.log("up"); process.stdin.once("data", () => console.log("C' + i + '"))']);
  children.push(c);
  let out = '';
  c.stdout.on('data', (d) => {
    const was = out;
    out += d;
    if (!was.startsWith('up') && out.startsWith('up') && ++up === N) {
      console.log('T ' + (Date.now() - t0) + ' all up');
      for (const child of children) child.stdin.end('go\\n');
    }
  });
  c.on('close', (code) => {
    results.push('C' + i + ':' + code + ':' + out.replace(/^up\\n/, '').trim());
    if (results.length === N) {
      console.log('T ' + (Date.now() - t0) + ' all closed');
      console.log('ALL ' + results.sort().join(' '));
    }
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
      assert.deepEqual(got.lines, host[name].lines, `${name}: the same lines, in the same order, as under host node`);
      return { ...got, samples };
    };

    // What a child held is measured against what holding it would cost, timed
    // beside it under the same load: never against a launch timed earlier,
    // which a loaded machine makes slower or faster at will (a solo launch of
    // 443 ms, then one of 2129 ms after a kill, with nothing held between).
    const solo = await run('solo');
    console.log(`  solo: B printed ${solo.timings['B data']} ms after its spawn`);

    // A and B launch together, A to live 12 s. Had B waited on anything A
    // held, it would print once A closed; it prints in the first half of
    // A's life, about when A itself is up.
    const ab = await run('ab');
    console.log(`  ab: B printed at ${ab.timings['B data']} ms while A ran to ${ab.timings['A close']} ms`);
    assert.ok(ab.timings['B data'] < ab.timings['A close'] - 6_000,
      `B printed while A was still running, in the first half of A's 12 s life (${ab.timings['B data']} ms, A closed at ${ab.timings['A close']} ms): A held nothing B needed`);

    // Had the kill not ended A's program, it would run on for the rest of
    // its 120 s holding its worker, and B would wait on it.
    const killed = await run('kill');
    console.log(`  kill: B printed ${killed.timings['B data']} ms after A was killed`);
    assert.ok(killed.timings['B data'] < 60_000,
      `a child spawned after the kill runs at once, not once A's program would have ended (${killed.timings['B data']} ms of A's 120 s)`);
    // The parent has exited; A's program must not run on, holding its worker,
    // for the rest of its 120 s: its worker leaves the ledger well before.
    let loader = (await terminal.memory()).loader;
    for (const until = Date.now() + 60_000; loader.inFlightWorkers.length > 0 && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      loader = (await terminal.memory()).loader;
    }
    assert.deepEqual(loader.inFlightWorkers, [], "the killed child's Dynamic Worker left the ledger with it");

    // Each of the eight ends only once all eight are up (the scenario's
    // barrier): one at a time, the first would wait for good.
    const many = await run('many');
    console.log(`  many: 8 children all up at ${many.timings['all up']} ms, all closed at ${many.timings['all closed']} ms`);
    assert.ok(Number.isFinite(many.timings['all up']) && many.timings['all up'] <= many.timings['all closed'], 'all eight were running at once, and then all ended');

    await run('nested');
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - cp-concurrent-children-workerd (B beside a live A, kill frees at once, N together, nested)');
