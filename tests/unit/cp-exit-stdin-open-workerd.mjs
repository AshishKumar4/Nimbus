// @serial
// A child_process child ends when its command does, whether or not its
// parent has ended its stdin, as under Node.
//
// 2602b279b made a broker child's stdin a pipe its command reads as the
// parent writes it. A child whose command never reads stdin must still end
// when that command ends: `execFile('sh', ['-c', 'printf x > f'], cb)` calls
// back at once under Node, though nothing ever ends the child's stdin, and
// only a command that reads stdin waits for its end. On staging the callback
// never came (node-live-vfs-async-fs). What has to hold, against the host's
// Node: execFile of `sh -c` with a builtin and a redirect, with a pipeline,
// `exec('true')`, `spawn('sh', ['-c', 'echo x'])` with stdin left open, and a
// `#!/bin/sh` script of builtins run by path, and `head -n 0` / `head -c 0`
// (which read nothing), each end with their output and exit code; a child
// whose command reads stdin still waits for its end.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

// Each case reports how it ended, or `stuck` if it had not after 20 s.
const PROGRAM = (dir) => [
  "const { exec, execFile, spawn } = require('child_process');",
  "const fs = require('fs');",
  `const DIR = ${JSON.stringify(dir)};`,
  'const settle = (name, start) => new Promise((resolve) => {',
  "  const stuck = setTimeout(() => resolve(name + ' stuck'), 20000);",
  '  start((result) => { clearTimeout(stuck); resolve(name + \' \' + JSON.stringify(result)); });',
  '});',
  'const cases = [',
  "  ['execFile-redirect', (done) => execFile('sh', ['-c', 'printf child-live-ok > ' + DIR + '/out.txt'], (e, out) => done({ code: e ? e.code : 0, out, file: fs.readFileSync(DIR + '/out.txt', 'utf8') }))],",
  "  ['execFile-pipeline', (done) => execFile('sh', ['-c', 'echo a b | tr a-z A-Z'], (e, out) => done({ code: e ? e.code : 0, out }))],",
  "  ['exec-true', (done) => exec('true', (e, out) => done({ code: e ? e.code : 0, out }))],",
  "  ['spawn-open-stdin', (done) => { const c = spawn('sh', ['-c', 'echo x']); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => done({ code, out })); }],",
  "  ['execFile-script', (done) => execFile(DIR + '/b.sh', (e, out) => done({ code: e ? e.code : 0, out }))],",
  // head reads nothing for a count of 0, so stdin left open does not hold it.
  "  ['spawn-head-0', (done) => { const c = spawn('head', ['-n', '0']); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => done({ code, out })); }],",
  "  ['spawn-head-c0', (done) => { const c = spawn('sh', ['-c', 'head -c 0; echo after']); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => done({ code, out })); }],",
  // A reader of stdin waits for its end, and gets what was written before it.
  "  ['spawn-reader', (done) => { const c = spawn('sh', ['-c', 'cat']); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => done({ code, out })); c.stdin.write('in'); setTimeout(() => c.stdin.end(), 300); }],",
  '];',
  "(async () => { for (const [name, start] of cases) console.log('EXIT ' + await settle(name, start)); })();",
].join('\n');

const lines = (stdout) => stdout.split('\n').filter((line) => line.startsWith('EXIT ')).map((line) => line.replace(/\r$/, ''));

// ── The host's Node ─────────────────────────────────────────────────────────
const SCRIPT = '#!/bin/sh\nprintf script-ok\necho " $(basename /a/b)" | tr a-z A-Z\n';
const hostDir = mkdtempSync(join(tmpdir(), 'cp-exit-stdin-'));
let expected;
try {
  writeFileSync(join(hostDir, 'b.sh'), SCRIPT, { mode: 0o755 });
  const host = spawnSync('node', ['-e', PROGRAM(hostDir)], { cwd: hostDir, encoding: 'utf8', timeout: 120_000 });
  assert.equal(host.status, 0, host.stderr);
  expected = lines(host.stdout);
  assert.equal(readFileSync(join(hostDir, 'out.txt'), 'utf8'), 'child-live-ok');
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}
assert.equal(expected.length, 8, `the host ran every case: ${JSON.stringify(expected)}`);
for (const line of expected) assert.doesNotMatch(line, / stuck$/, `host: ${line}`);

// ── Nimbus, through the broker ──────────────────────────────────────────────
const W = '/home/user/w';
console.log('cp-exit-stdin-open-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const files = Buffer.from(JSON.stringify({ 'parent.js': PROGRAM(W), 'b.sh': SCRIPT })).toString('base64');
    const written = await terminal.run(
      `mkdir -p ${W} && node -e "for (const [n, t] of Object.entries(JSON.parse(Buffer.from('${files}', 'base64').toString()))) require('fs').writeFileSync('${W}/' + n, t)" && chmod 755 ${W}/b.sh && echo WRITTEN`,
      300_000,
    );
    assert.match(written.stdout, /WRITTEN/, written.stdout);
    const run = await terminal.run(`cd ${W} && node parent.js`, 300_000);
    assert.deepEqual(lines(run.stdout), expected, `each child ends as under node:\n${run.stdout}`);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('cp-exit-stdin-open-workerd: a child ends when its command does, stdin open or not, as under node');
