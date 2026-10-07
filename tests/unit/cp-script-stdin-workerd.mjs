// @serial
// @tier slow — drives a local workerd; CI median 26 s wall, 28 s CPU, 1.0 GiB peak (6 runs, 2026-10-06)
// A shell script child_process.spawn starts reads the stdin its parent
// writes, live, as under Node (TestyIguana, resolve-path).
//
// `spawn('./s.sh')` with s.sh `#!/bin/sh\ncat` echoes what the parent writes
// and exits at the end of its stdin, under Node. Through the broker the
// script had none: the broker ran the child with an empty fixed stdin, and
// never said its descriptors were pipes, so sh took its stdin for a terminal
// and passed none on. What has to hold, for the script named by a relative
// path, an absolute path, its name on PATH, and as `sh s.sh`, and for node
// itself: the first line the parent writes is echoed before the parent ends
// stdin (the child reads it live), the second after, and the child exits 0 at
// the end, as the same program does under the host's Node. A script whose
// program is node reads the script's stdin too, not the queue its env names;
// it is written whole and ended, because a runtime whose stdout is a pipe
// hands its output back when it exits (runtime-registry.ts, captureOutput),
// so it cannot echo before its parent ends.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const SCRIPT = '#!/bin/sh\ncat\n';
// A script whose program is node, and node itself: their stdin is the same pipe.
const NODE_ECHO = 'process.stdin.pipe(process.stdout)';
const NODE_SCRIPT = `#!/bin/sh\nnode -e '${NODE_ECHO}'\n`;

// The parent: per variant, write a line, and either wait for its echo then
// write another and end (`live`), or write both and end (`whole`). A child that
// never echoes is ended anyway after a while, and one that never exits is
// killed, so the transcript says what happened either way.
const PROGRAM = (dir) => [
  "const { spawn } = require('child_process');",
  `const DIR = ${JSON.stringify(dir)};`,
  'const variants = [',
  "  ['relative', './s.sh', [], {}, 'live'],",
  "  ['absolute', DIR + '/s.sh', [], {}, 'live'],",
  "  ['path', 's.sh', [], { env: { ...process.env, PATH: DIR + '/bin:' + process.env.PATH } }, 'live'],",
  "  ['sh', 'sh', ['s.sh'], {}, 'live'],",
  `  ['node', 'node', ['-e', ${JSON.stringify(NODE_ECHO)}], {}, 'live'],`,
  "  ['script-node', './n.sh', [], {}, 'whole'],",
  '];',
  'const run = ([name, command, args, options, mode]) => new Promise((resolve) => {',
  '  const child = spawn(command, args, { cwd: DIR, ...options });',
  "  let out = ''; const steps = [];",
  '  const end = () => { if (!child.stdin.writableEnded) child.stdin.end(); };',
  "  const quiet = setTimeout(() => { steps.push('no-echo'); end(); }, 15000);",
  '  const stuck = setTimeout(() => child.kill(), 30000);',
  "  child.stdout.on('data', (d) => {",
  '    out += d;',
  "    if (mode === 'live' && out === 'one\\n') { clearTimeout(quiet); steps.push('echoed-before-end'); child.stdin.write('two\\n'); end(); }",
  '  });',
  "  child.stderr.on('data', (d) => { steps.push('stderr:' + String(d).trim()); });",
  "  child.on('close', (code, signal) => { clearTimeout(quiet); clearTimeout(stuck); resolve(name + ' ' + JSON.stringify({ out, code, signal, steps })); });",
  "  child.stdin.write('one\\n');",
  "  if (mode === 'whole') { clearTimeout(quiet); child.stdin.write('two\\n'); end(); }",
  '});',
  "(async () => { for (const v of variants) console.log('SCRIPT ' + await run(v)); })();",
].join('\n');

const lines = (stdout) => stdout.split('\n').filter((line) => line.startsWith('SCRIPT ')).map((line) => line.replace(/\r$/, ''));

// ── The host's Node ─────────────────────────────────────────────────────────
const hostDir = mkdtempSync(join(tmpdir(), 'cp-script-stdin-'));
let expected;
try {
  mkdirSync(join(hostDir, 'bin'));
  for (const [path, text] of [[join(hostDir, 's.sh'), SCRIPT], [join(hostDir, 'bin', 's.sh'), SCRIPT], [join(hostDir, 'n.sh'), NODE_SCRIPT]]) {
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  }
  const host = spawnSync('node', ['-e', PROGRAM(hostDir)], { cwd: hostDir, encoding: 'utf8', timeout: 120_000 });
  assert.equal(host.status, 0, host.stderr);
  expected = lines(host.stdout);
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}
assert.equal(expected.length, 6, `the host ran every variant: ${JSON.stringify(expected)}`);
for (const line of expected) {
  const steps = line.startsWith('SCRIPT script-node ') ? '' : '"echoed-before-end"';
  assert.ok(line.endsWith(`{"out":"one\\ntwo\\n","code":0,"signal":null,"steps":[${steps}]}`), `host: ${line}`);
}

// ── Nimbus, through the broker ──────────────────────────────────────────────
const W = '/home/user/w';
console.log('cp-script-stdin-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const scripts = Buffer.from(JSON.stringify({ 's.sh': SCRIPT, 'bin/s.sh': SCRIPT, 'n.sh': NODE_SCRIPT })).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W}/bin && node -e "for (const [n, t] of Object.entries(JSON.parse(Buffer.from('${scripts}', 'base64').toString()))) require('fs').writeFileSync('${W}/' + n, t)" && chmod 755 ${W}/s.sh ${W}/bin/s.sh ${W}/n.sh && echo SETUP`,
      300_000,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);
    const program = Buffer.from(PROGRAM(W)).toString('base64');
    const written = await terminal.run(
      `node -e "require('fs').writeFileSync('${W}/parent.js', Buffer.from('${program}', 'base64').toString()); console.log('WRITTEN')"`,
      300_000,
    );
    assert.match(written.stdout, /WRITTEN/, written.stdout);
    const run = await terminal.run(`cd ${W} && node parent.js`, 300_000);
    assert.deepEqual(lines(run.stdout), expected, `each script reads its parent's stdin live, as under node:\n${run.stdout}`);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('cp-script-stdin-workerd: a spawned shell script reads its parent\'s stdin live, as under node');
