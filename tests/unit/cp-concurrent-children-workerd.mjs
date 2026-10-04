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
//     not compared with it. Before, all of them waited for good. The same
//     with each child an ES module blocked inside its top-level await
//     (tladeadlock): before, such children never reported
//     their state, and all ten hung. The same with each child a shell line
//     running the program (shdeadlock): the parent's children are shells,
//     which hold no worker; before, they were never stuck, and all ten hung.
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
  "  g.on('spawn', () => console.log('spawn'));",
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
  const c = spawn('node', ['-e', "console.log('up'); setTimeout(() => {}, 30000)"]);
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
const NO_DIFFERENTIAL = new Set(['deadlock', 'shdeadlock', 'tladeadlock', 'tsburst', 'exitsched', 'bun10', 'syncchain', 'syncfork']);
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
    const run = async (name, { poll, args = '' } = {}) => {
      const samples = [];
      let polling = !!poll;
      const poller = (async () => {
        while (polling) {
          samples.push((await terminal.memory()).loader);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })();
      const r = await terminal.run(`node /home/user/${name}.js ${args}`, 180_000);
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
    const ran = 'spawn | exit 0 | close 0 null 2 ; 0';
    const refused = 'error EAGAIN -11 spawn node node ["-e","console.log(1+1)"] spawn node EAGAIN pid=undefined | close -11 null ; 0';
    assert.deepEqual(deadlock.lines, [refused, ...Array(8).fill(ran)],
      "the newest grandchild's spawn fails EAGAIN, as Node's at a process limit (no 'spawn', no pid), and the other eight run");

    // The same nine as ES modules, blocked inside their top-level await: they
    // report it as callbacks do (before, they never did, and all ten hung).
    // The same nine as shell lines over their programs: the shell awaits its
    // program, and is stuck exactly when it is (before, the parent named
    // the shells, which held no worker and said nothing, and all ten hung).
    const sh = await run('shdeadlock');
    console.log('  shdeadlock:\n    ' + sh.lines.join('\n    '));
    assert.deepEqual(sh.lines, ['close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'close 0 2 ; 0', 'error EAGAIN ; 0'],
      "through sh -c, one grandchild's spawn fails EAGAIN, and the other eight run");

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
    // though Bun's runner runs it under a pid of its own.
    const bun10 = await run('bun10');
    console.log(`  bun10: bun printed ${bun10.timings['bun data']} ms after its spawn`);
    assert.deepEqual(bun10.lines, ['bun said B 0', 'kids closed']);
    assert.ok(bun10.timings['bun data'] < 10_000, `the bun child did not wait for room its own admission held (${bun10.timings['bun data']} ms)`);

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
console.log('ok - cp-concurrent-children-workerd (B beside a live A, kill frees at once, N together, a burst past the limit, nested)');
