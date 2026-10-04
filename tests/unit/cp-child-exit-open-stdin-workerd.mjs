// @serial
// process.exit() ends a Nimbus process as it ends a Node one: at once,
// whatever it still holds open. Two cases, each run under host node and in a
// Nimbus session, with equal output and about the same time:
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
  children: `
const { spawn } = require('child_process');
const t0 = Date.now();
const c = spawn('node', ['-e', "console.log('up'); setTimeout(() => {}, 60000)"]);
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

console.log('cp-child-exit-open-stdin-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
const failures = [];
try {
  // A session per scenario: one that hangs holds its terminal.
  for (const [name, source] of Object.entries(SCENARIOS)) {
    const terminal = await localTerminal(probe, { install: [] });
    try {
      const b64 = Buffer.from(source).toString('base64');
      const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/${name}.js', Buffer.from('${b64}', 'base64'))"`);
      assert.equal(w.status, 0, w.stdout);
      const started = Date.now();
      const r = await terminal.run(`node /home/user/${name}.js`, 30_000);
      const ms = Date.now() - started;
      console.log(`  ${name}: ${ms} ms (host node ${host[name].ms} ms; the program's own T ${elapsed(r.stdout)} ms)`);
      assert.equal(r.status, 0, r.stdout);
      assert.deepEqual(lines(r.stdout), host[name].lines, `${name}: the same output as under host node`);
      assert.ok(ms < 15_000, `${name}: the program ended when it exited (${ms} ms), not when what it held did`);
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
console.log('ok - cp-child-exit-open-stdin-workerd (a child exits with its stdin open; a parent exits with a child running)');
