// @serial
// child_process children of one session run concurrently, as Node's do,
// under workerd. Each scenario's lines are compared with the same program
// under host node (its timing lines, `T <ms> ...`, set aside), and each
// property is a barrier the scenario cannot pass otherwise, not a deadline.
//
// What has to hold:
//   - a child that is still running (a server, a watcher) does not hold back
//     a second child: A waits for B to close, and both end. Before, B waited
//     the whole of A's life (15.6 s on a 15 s A), queued behind A on the one
//     slot of the spawn pool that relayed it.
//   - killing A frees what it held at once: A's Dynamic Worker is off the
//     ledger by the time its parent hears A closed, and a child spawned
//     after runs (before, A's program ran on to its natural end and held
//     both).
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

import { localTerminal, startLocalProbe, splitScenarioOutput } from './lib/workerd-probe.mjs';

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
const fs = require('fs');
// A waits for B: it ends only once B has closed, when the parent writes the
// file A looks for (or after 120 s, saying so). Had B waited on anything A
// held, neither would ever end.
const go = require('os').tmpdir() + '/ab-go-' + process.pid;
const a = spawn('node', ['-e', "const f = require('fs'); const t0 = Date.now(); (async () => { for (;;) { try { await f.promises.access(process.argv[1]); console.log('A done'); return; } catch {} if (Date.now() - t0 > 120000) { console.log('A gave up waiting for B'); return; } await new Promise((r) => setTimeout(r, 50)); } })();", go]);
const b = spawn('node', ['-e', "console.log('B ran')"]);
b.stdout.on('data', (d) => process.stdout.write(String(d)));
b.on('close', (code) => { console.log('B close ' + code); fs.promises.writeFile(go, 'go'); });
a.stdout.on('data', (d) => process.stdout.write(String(d)));
a.on('close', (code) => { console.log('A close ' + code); fs.promises.rm(go, { force: true }); });
`,
  kill: `
const { spawn } = require('child_process');
const fs = require('fs');
// Given a path, the parent stops twice for the case to read the session's
// ledger: once A is up (it writes A's pid to <path>.up and waits for
// <path>.kill) and once A has closed (<path>.closed, then <path>.go).
const stop = process.argv[2];
const until = async (file) => { for (;;) { try { await fs.promises.access(file); return; } catch { await new Promise((r) => setTimeout(r, 50)); } } };
const a = spawn('node', ['-e', "console.log('A up'); setTimeout(() => console.log('A done'), 120000)"]);
a.stdout.once('data', async (d) => {
  process.stdout.write(String(d));
  if (stop) { await fs.promises.writeFile(stop + '.up', String(a.pid)); await until(stop + '.kill'); }
  console.log('kill ' + a.kill());
});
a.on('close', async (_code, signal) => {
  console.log('A closed by ' + signal);
  if (stop) { await fs.promises.writeFile(stop + '.closed', String(a.pid)); await until(stop + '.go'); }
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

const host = {};
for (const [name, source] of Object.entries(SCENARIOS)) {
  const r = spawnSync('node', ['-e', source], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `host node ${name}: ${r.stderr}`);
  host[name] = splitScenarioOutput(r.stdout);
}

console.log('cp-concurrent-children-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    for (const [name, source] of Object.entries(SCENARIOS)) await terminal.writeFile(`/home/user/${name}.js`, source);
    // A scenario's family can take minutes on a loaded machine, one launch
    // after another: what tells a hang from that is the session's Dynamic
    // Worker ledger, which stops changing.
    const ledger = async () => { const { loader } = await terminal.memory(); return [loader.holders, loader.waiters, loader.news]; };
    const run = async (name) => {
      const r = await terminal.run(`node /home/user/${name}.js`, 280_000, { progress: ledger, stalledMs: 120_000 });
      assert.equal(r.status, 0, `${name}: ${r.stdout.slice(-800)}`);
      const got = splitScenarioOutput(r.stdout);
      assert.deepEqual(got.lines, host[name].lines, `${name}: the same lines, in the same order, as under host node`);
      return got;
    };

    const solo = await run('solo');
    console.log(`  solo: B printed ${solo.timings['B data']} ms after its spawn`);

    // A and B launch together, and A ends only once B has closed (the
    // scenario's barrier). B queued behind anything A holds would deadlock
    // the two, and A would say it gave up: the lines differ from host node's.
    await run('ab');

    // Killing A gives its Dynamic Worker back to the ledger as part of the
    // kill: the broker runs the session's kill of the pid (its launch's
    // terminator, which aborts the program's run and ends its admission)
    // before it stamps the exit the parent hears as 'close' (facets/
    // process.ts kill). So at A's close the ledger holds nothing of A's. The
    // parent stops there while the case reads the ledger, and once before
    // the kill, where A's hold must show, so the check names the right pid.
    // Before, A's program ran on to its natural end (120 s) and held its
    // worker; a kill acknowledged at once with the release behind it fails
    // here however fast the machine.
    const stop = '/home/user/kill-stop';
    const file = async (path) => {
      for (const until = Date.now() + 240_000; ;) {
        const r = await terminal.run(`cat ${path} 2>/dev/null`);
        if (/^\d+$/.test(r.stdout.trim())) return Number(r.stdout.trim());
        if (Date.now() > until) throw new Error(`kill: ${path} never came: ${(await terminal.run('cat /home/user/kill.out')).stdout.slice(-800)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const heldBy = (loader, pid) => Object.entries(loader.holders).filter(([, pids]) => pids.includes(pid)).map(([key]) => key);
    await terminal.run(`rm -f ${stop}.up ${stop}.kill ${stop}.closed ${stop}.go; node /home/user/kill.js ${stop} > /home/user/kill.out 2>&1 &`);
    const aPid = await file(`${stop}.up`);
    const beforeKill = (await terminal.memory()).loader;
    assert.notDeepEqual(heldBy(beforeKill, aPid), [], `A (pid ${aPid}) holds a Dynamic Worker while it runs: ${JSON.stringify(beforeKill.holders)}`);
    await terminal.run(`touch ${stop}.kill`);
    assert.equal(await file(`${stop}.closed`), aPid);
    const atClose = (await terminal.memory()).loader;
    assert.deepEqual(heldBy(atClose, aPid), [], `A's Dynamic Worker left the ledger before its parent heard it closed: ${JSON.stringify(atClose.holders)}`);
    await terminal.run(`touch ${stop}.go`);
    const ended = await terminal.run('wait', 280_000, { progress: ledger, stalledMs: 120_000 });
    assert.equal(ended.status, 0, ended.stdout);
    const killed = splitScenarioOutput((await terminal.run('cat /home/user/kill.out')).stdout);
    assert.deepEqual(killed.lines, host.kill.lines, 'kill: the same lines, in the same order, as under host node');
    console.log(`  kill: A's worker gone at its close; B printed ${killed.timings['B data']} ms after its spawn`);

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
