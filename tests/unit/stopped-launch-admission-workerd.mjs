// @serial
// @tier slow — drives a local workerd; CI median 16 s wall, 15 s CPU, 1.2 GiB peak (6 runs, 2026-10-06)
// A parent plus nine children at fs.readFileSync(0) used to retain all ten
// launch admissions after their Workers stopped. B then waited forever,
// and the parent could not close the stopped children's stdins until B
// finished. The same program under Node has no such circular wait.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const PROGRAM = `
const { spawn } = require('child_process');
const children = [];
const outputs = Array.from({ length: 9 }, () => '');
let ready = 0;
let closed = 0;
for (let i = 0; i < 9; i++) {
  const c = spawn('node', ['-e', "console.log('READY'); const s = require('fs').readFileSync(0, 'utf8'); console.log('GOT ' + s);"]);
  children.push(c);
  c.stderr.on('data', (d) => process.stderr.write(d));
  c.stdout.on('data', (d) => {
    const before = outputs[i].includes('READY\\n');
    outputs[i] += d;
    if (!before && outputs[i].includes('READY\\n') && ++ready === 9) {
      console.log('ALL READY');
      const b = spawn('node', ['-e', "console.log('B ran')"]);
      b.stderr.on('data', (d) => process.stderr.write(d));
      b.stdout.on('data', (d) => process.stdout.write(d));
      b.on('close', (code) => {
        console.log('B close ' + code);
        for (const [j, child] of children.entries()) child.stdin.end('input' + j);
      });
    }
  });
  c.on('close', (code) => {
    console.log('C' + i + ' ' + code + ' ' + JSON.stringify(outputs[i]));
    if (++closed === 9) console.log('ALL CLOSED');
  });
}
`;

const lines = (text) => text.split('\n').filter((s) => /^(ALL |B |C\d )/.test(s)).sort();
const host = spawnSync('node', ['-e', PROGRAM], { encoding: 'utf8', timeout: 30_000 });
assert.equal(host.status, 0, host.stderr);
assert.equal(host.stderr, '');
const expected = lines(host.stdout);
assert.equal(expected.length, 13);
const probe = await startLocalProbe({ runtimes: [] });
let terminal;
try {
  terminal = await localTerminal(probe, { install: [] });
  const write = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/stopped-admissions.js', Buffer.from('${Buffer.from(PROGRAM).toString('base64')}', 'base64'))"`);
  assert.equal(write.status, 0, write.stdout);
  // Bound the pre-fix deadlock without killing an unrelated process. The
  // finally deletes this test's session and its children through the API.
  const result = await terminal.run('node /home/user/stopped-admissions.js', 90_000);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(lines(result.stdout), expected, 'B runs despite nine stopped children, then each child completes with its output delivered once');
  const ledger = (await terminal.memory()).loader;
  assert.deepEqual(ledger.inFlightWorkers, [], 'all launch and replay holds ended');
  assert.equal(ledger.waiting, 0, 'no replay waiter leaked');
  assert.ok(ledger.peak <= ledger.limit, 'readmission never exceeded the ledger limit');
} catch (error) {
  console.error(probe.log().slice(-6000));
  throw error;
} finally {
  if (terminal) await terminal.close();
  await probe.stop();
}
console.log('ok - stopped-launch-admission-workerd (B runs beside nine stopped READY children; each completes once stdin closes; no ledger leaks)');
