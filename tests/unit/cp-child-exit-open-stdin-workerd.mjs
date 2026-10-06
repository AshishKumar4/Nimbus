// @serial
// @tier slow — drives a local workerd; CI median 20 s wall, 18 s CPU, 1.3 GiB peak (6 runs, 2026-10-06)
// process.exit() ends a Nimbus process as it ends a Node one: at once,
// whatever it still holds open. Each case runs under host node and in a
// Nimbus session, with equal output, and ends there though what it holds
// outlives the run's bound:
//
//   - stdin: children each read one chunk of a stdin their parent keeps open,
//     print it and call process.exit(0). Before, each child's run, having
//     drained to its exit, then awaited its live stdin pump, which ends only
//     when stdin does: the child never ended, its Dynamic Worker stayed held,
//     and the parent waited on it forever. Traced on 312210f89, per child:
//     the broker queued 3 bytes, the child's poll took 3, its pump handed 3 to
//     the program, which printed "got go" and exited 0; its run reported
//     "drained, awaiting stdin pump" and no exit reached the broker.
//   - children: a parent calls process.exit(0) while a child it listens to
//     still runs. Before, the parent's run waited for the child to close
//     (its close listener was pending I/O), so the parent ended only when the
//     child did.
//   - written: a parent writes each child's script with writeFileSync and
//     spawns it at once, eight times over, and tells each one "go" on stdin
//     after writing the file it reads. The child sees both writes, as in
//     Node: the parent's parked writes reach the authority before the launch
//     and before the stdin write. Before, a child could fail `cannot find
//     module` (seen 1 run in 5 with ES-module children).
//   - unread: a child fails, writing its error to a stderr its parent never
//     reads. Its parent still gets 'close', as Node's flushStdio gives it.
//     Before, the unread stderr held 'close' back for good.
//   - exitcapture: a program run by a shell line (`sh -c 'node x'`, its
//     output captured for the line) calls process.exit(0) with a callback
//     still queued: nothing it would print after the exit is printed.
//     Before, the captured form kept writing (`after` and a child's 'close').
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const SCENARIOS = {
  stdin: `
const { spawn } = require('child_process');
const t0 = Date.now();
const N = 3;
const results = [];
for (let i = 0; i < N; i++) {
  const c = spawn('node', ['-e', "process.stdin.once('data', (d) => { console.log('got ' + String(d).trim()); process.exit(0); }); console.log('ready');"]);
  let out = '';
  c.stdout.on('data', (d) => { out += d; if (/ready/.test(String(d))) c.stdin.write('go\\n'); });
  c.on('close', (code) => {
    results.push('C' + i + ' ' + code + ' ' + JSON.stringify(out));
    if (results.length === N) { console.log(results.sort().join('\\n')); console.log('T ' + (Date.now() - t0)); }
  });
}
`,
  written: `
const { spawn } = require('child_process');
const fs = require('fs');
const t0 = Date.now();
const N = 8;
const results = [];
for (let i = 0; i < N; i++) {
  fs.writeFileSync('/tmp/written-' + i + '.mjs', "import { readFileSync } from 'node:fs'; process.stdin.once('data', () => { console.log('" + i + " ' + readFileSync('/tmp/written-" + i + ".txt', 'utf8')); process.exit(0); });");
  const c = spawn('node', ['/tmp/written-' + i + '.mjs']);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  fs.writeFileSync('/tmp/written-' + i + '.txt', 'v' + i);
  c.stdin.write('go\\n');
  c.on('close', (code) => {
    results.push(out.trim() + ' ; ' + code);
    if (results.length === N) { console.log(results.sort().join('\\n')); console.log('T ' + (Date.now() - t0)); }
  });
}
`,
  exitcapture: `
const { spawn } = require('child_process');
require('fs').writeFileSync('/tmp/exitcapture.js', "Promise.resolve().then(() => console.log('after')); process.on('exit', () => console.log('exit handler')); console.log('first'); process.exit(0);");
const c = spawn('sh', ['-c', 'node /tmp/exitcapture.js']);
let out = '';
c.stdout.on('data', (d) => { out += d; });
c.on('close', (code) => console.log(JSON.stringify(out) + ' ' + code));
`,
  unread: `
const { spawn } = require('child_process');
const t0 = Date.now();
const c = spawn('node', ['-e', "console.error('boom'); process.exit(3)"]);
c.on('exit', (code) => console.log('exit ' + code));
c.on('close', (code) => { console.log('close ' + code); console.log('T ' + (Date.now() - t0)); });
`,
  children: `
const { spawn } = require('child_process');
const t0 = Date.now();
// The child lives 10 min, or until its stdin ends, which the parent's exit does.
const c = spawn('node', ['-e', "console.log('up'); setTimeout(() => {}, 600000); process.stdin.on('end', () => process.exit(0)).resume()"]);
c.on('close', (code) => console.log('child closed ' + code));
c.stdout.once('data', () => { console.log('parent exits'); console.log('T ' + (Date.now() - t0)); process.exit(0); });
`,
};

const lines = (text) => text.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0 && !l.startsWith('[facet started') && !/^T \d+$/.test(l));
const elapsed = (text) => Number(/^T (\d+)$/m.exec(text)?.[1] ?? NaN);

const host = {};
for (const [name, source] of Object.entries(SCENARIOS)) {
  const started = Date.now();
  const r = spawnSync('node', ['-e', source], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `host node ${name}: ${r.stderr}`);
  host[name] = { lines: lines(r.stdout), ms: Date.now() - started };
}
assert.ok(host.children.ms < 10_000, `host node's parent exits without waiting for its child (${host.children.ms} ms)`);
assert.equal(host.written.lines.length, 8, host.written.lines.join('\n'));

console.log('cp-child-exit-open-stdin-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
const failures = [];
try {
  // A session per scenario: one that hangs holds its terminal.
  for (const [name, source] of Object.entries(SCENARIOS)) {
    const terminal = await localTerminal(probe, { install: [] });
    try {
      await terminal.writeFile(`/home/user/${name}.js`, source);
      const started = Date.now();
      // What a scenario holds when it exits it holds for good (stdin, an
      // unread stream) or for 10 min (children, until the parent's exit
      // ends its stdin): a program that ended only when what it held did
      // never ends within this bound. Not a deadline on how fast it ends:
      // eight ES-module children (written) took 20 to 41 s to launch and
      // end on a loaded machine, against 11 s alone.
      let r;
      try {
        r = await terminal.run(`node /home/user/${name}.js`, 240_000);
      } catch (error) {
        throw new Error(`${name}: the program did not end when it exited: still running after ${Date.now() - started} ms, held by what it held open (${String(error.message).split('\n')[0].slice(0, 300)})`);
      }
      const ms = Date.now() - started;
      console.log(`  ${name}: ${ms} ms (host node ${host[name].ms} ms; the program's own T ${elapsed(r.stdout)} ms)`);
      assert.equal(r.status, 0, r.stdout);
      assert.deepEqual(lines(r.stdout), host[name].lines, `${name}: the same output as under host node`);
    } catch (error) {
      console.log(`  ${name}: FAILED ${String(error.message).split('\n')[0].slice(0, 300)}`);
      failures.push(`${name}: ${error.message.slice(0, 800)}`);
    } finally {
      await terminal.close().catch(() => {});
    }
  }
} finally {
  await probe.stop();
}
assert.deepEqual(failures, [], failures.join('\n\n'));
console.log('ok - cp-child-exit-open-stdin-workerd (a child exits with its stdin open; a parent exits with a child running; a child sees the writes before its spawn and its stdin; unread output still closes)');
