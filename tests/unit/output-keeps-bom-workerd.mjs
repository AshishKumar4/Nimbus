// @serial
// @tier slow — drives a local workerd
// Output that begins with U+FEFF (bytes EF BB BF) reaches the terminal with
// it, as a Linux terminal receives every byte a program writes: the wasm
// bash's printf, a node program's write of the bytes, and the shell's cat of
// a file that begins with them. And a child's command is its name, every
// character its own: node's spawn(' node') and spawn('\uFEFFnode') find no
// program (ENOENT), as host Node's do. Host bash and host node run
// the same lines; the BOM must lead each output. A node program reading the
// bytes as text (setEncoding, readline) has them, and grep matches the
// line's bytes, the BOM's before its text.
//
// Red before: the output streams' decoders dropped a leading BOM (one per
// process, and one per chunk where output was decoded piece by piece), so
// did stdin's setEncoding, readline and grep's records, and the child
// process manager trimmed a command, the BOM with the spaces.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const BOM = '\uFEFF';
const bomFile = new Uint8Array([0xef, 0xbb, 0xbf, 0x7a, 0x0a]);
// Each spawn's outcome, a line each in whatever order they come: its 'error' code, or its exit code.
const spawns = "const cp = require('child_process'); for (const c of [' node', 'node ', '\\\\uFEFFnode']) cp.spawn(c, ['-e', '1']).on('error', (e) => console.log(JSON.stringify([c, e.code]))).on('exit', (code) => console.log(JSON.stringify([c, code])));";
const sortedLines = (text) => text.replace(/\r/g, '').split('\n').filter(Boolean).sort().join('\n');
// [the line, the text its output begins with once the terminal's leading line breaks are gone]
const lines = [
  ["bash -c 'printf \"\\357\\273\\277x\\n\"'", `${BOM}x`],
  ['node -e "process.stdout.write(Buffer.from([0xef, 0xbb, 0xbf, 0x79, 0x0a]))"', `${BOM}y`],
  ['cat bom.txt', `${BOM}z`],
  // Read back as text by a program: setEncoding's data, and readline's lines.
  ["cat bom.txt | node -e \"process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => process.stdout.write(JSON.stringify(d)))\"", `"${BOM}z\\n"`],
  ["cat bom.txt | node -e \"require('readline').createInterface({ input: process.stdin }).on('line', (l) => console.log(JSON.stringify(l)))\"", `"${BOM}z"`],
  // GNU grep matches bytes: the BOM's are before the z.
  ["grep -c '^z' bom.txt; echo \"rc=$?\"", '0\nrc=1'],
];

// The oracle: host bash and host node, in a directory holding the same file; its grep GNU grep.
const grepVersion = spawnSync('grep', ['--version'], { encoding: 'utf8' }).stdout;
assert.match(grepVersion, /GNU grep/, `the host's grep is GNU grep: ${grepVersion.split('\n')[0]}`);
const host = mkdtempSync(join(tmpdir(), 'nimbus-bom-out-'));
const hostOut = (line) => {
  const ran = spawnSync('bash', ['-c', line], { cwd: host, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
  assert.equal(ran.status, 0, `host: ${line}: ${ran.stderr}`);
  return ran.stdout.toString('utf8');
};
let spawned;
try {
  writeFileSync(join(host, 'bom.txt'), bomFile);
  for (const [line, begins] of lines) assert.ok(hostOut(line).startsWith(begins), `host: ${line} begins with ${JSON.stringify(begins)}`);
  spawned = sortedLines(hostOut(`node -e "${spawns}"`));
} finally {
  rmSync(host, { recursive: true, force: true });
}
assert.equal(spawned, sortedLines('[" node","ENOENT"]\n["node ","ENOENT"]\n["\uFEFFnode","ENOENT"]\n'), 'host node finds no program for a padded name');

const probe = await startLocalProbe();
const failed = [];
try {
  const terminal = await localTerminal(probe);
  try {
    await terminal.writeFile('/home/user/bom.txt', bomFile);
    for (const [line, begins] of lines) {
      const r = await terminal.run(`cd /home/user && ${line}`, 90_000);
      const shown = r.stdout.replace(/^[\r\n]+/, '');
      if (r.status === 0 && shown.startsWith(begins)) console.log(`  ok  ${line}`);
      else {
        console.log(`  FAIL  ${line}: ${JSON.stringify(r.stdout)} (status ${r.status})`);
        failed.push(line);
      }
    }
    const r = await terminal.run(`cd /home/user && node -e "${spawns}"`, 90_000);
    if (sortedLines(r.stdout) === spawned) console.log('  ok  spawn of a padded name finds no program');
    else {
      console.log(`  FAIL  spawn of a padded name: ${JSON.stringify(r.stdout)}`);
      failed.push('spawn');
    }
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
assert.deepEqual(failed, [], 'every output begins as host bash and node begin it');
console.log('output-keeps-bom-workerd: ok');
