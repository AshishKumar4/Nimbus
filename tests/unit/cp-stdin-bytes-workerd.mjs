// @serial
// What a parent writes to a running child's stdin reaches it as written, as
// under Node.
//
// 2602b279b made a broker child's stdin a pipe its command reads as the
// parent writes it. A node child, handed that pipe, pumped it into an input
// store of its own pid, so the parent's later writes went to that store
// through a text decoder: 0xff written after the child started arrived as
// efbfbd (the reviewer, FlyingPartridge). What has to hold, against the
// host's Node: bytes written after the child printed READY (a lone 0xff, a
// NUL, a UTF-8 sequence split across two writes) reach it unchanged; and a
// child that reads fd 0 synchronously gets all of it when its parent writes
// it in pieces (`a`, 5 s, `b`, end; the child starts within them): the child's
// own channel was then its stdin, and nothing read it ahead of the program,
// so readFileSync(0) threw EAGAIN on what had not arrived yet. (A program
// `python3 -` reads in pieces: core-wasm-runtime-bun; this probe stages only
// bash.)
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const SYNC_READER = "console.log('SYNC ' + JSON.stringify(require('fs').readFileSync(0, 'utf8')))";
const READER = "console.log('READY'); const c = []; process.stdin.on('data', (d) => c.push(d)); process.stdin.on('end', () => console.log('GOT ' + Buffer.concat(c).toString('hex')));";

const PROGRAM = [
  "const { spawn } = require('child_process');",
  `const READER = ${JSON.stringify(READER)};`,
  `const SYNC_READER = ${JSON.stringify(SYNC_READER)};`,
  'const settle = (name, start) => new Promise((resolve) => {',
  "  const stuck = setTimeout(() => resolve(name + ' stuck'), 30000);",
  "  start((result) => { clearTimeout(stuck); resolve(name + ' ' + JSON.stringify(result)); });",
  '});',
  'const cases = [',
  // Written once the child runs: after READY, in two writes, the second splitting é.
  "  ['bytes-after-start', (done) => { const c = spawn('node', ['-e', READER]); let out = ''; let sent = false;",
  "    c.stdout.on('data', (d) => { out += d; if (!sent && out.includes('READY')) { sent = true; c.stdin.write(Buffer.from([0xff, 0x00, 0xc3])); c.stdin.end(Buffer.from([0xa9, 0x0a])); } });",
  "    c.on('close', (code) => done({ code, got: (/GOT (\\S*)/.exec(out) || [])[1] })); }],",
  // A synchronous reader of fd 0, written to in delayed pieces after it starts.
  "  ['sync-read-delayed', (done) => { const c = spawn('node', ['-e', SYNC_READER]); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });",
  "    c.on('close', (code) => done({ code, out: out.trim().split('\\n').pop() })); c.stdin.write('a'); setTimeout(() => c.stdin.end('b'), 5000); }],",
  '];',
  "(async () => { for (const [name, start] of cases) console.log('BYTES ' + await settle(name, start)); })();",
].join('\n');

const lines = (stdout) => stdout.split('\n').filter((line) => line.startsWith('BYTES ')).map((line) => line.replace(/\r$/, ''));

// ── The host's Node ─────────────────────────────────────────────────────────
const hostDir = mkdtempSync(join(tmpdir(), 'cp-stdin-bytes-'));
let expected;
try {
  const host = spawnSync('node', ['-e', PROGRAM], { cwd: hostDir, encoding: 'utf8', timeout: 120_000 });
  assert.equal(host.status, 0, host.stderr);
  expected = lines(host.stdout);
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}
assert.deepEqual(expected, [
  'BYTES bytes-after-start {"code":0,"got":"ff00c3a90a"}',
  'BYTES sync-read-delayed {"code":0,"out":"SYNC \\"ab\\""}',
], 'the host reads the bytes, and a synchronous read gets all of them');

// ── Nimbus, through the broker ──────────────────────────────────────────────
const W = '/home/user/w';
console.log('cp-stdin-bytes-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const program = Buffer.from(PROGRAM).toString('base64');
    const written = await terminal.run(
      `mkdir -p ${W} && node -e "require('fs').writeFileSync('${W}/parent.js', Buffer.from('${program}', 'base64').toString()); console.log('WRITTEN')"`,
      300_000,
    );
    assert.match(written.stdout, /WRITTEN/, written.stdout);
    const run = await terminal.run(`cd ${W} && node parent.js`, 300_000);
    assert.deepEqual(lines(run.stdout), expected, `the child reads its stdin as under node:\n${run.stdout}`);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('cp-stdin-bytes-workerd: bytes written after a child starts arrive as written');
