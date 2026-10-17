// @serial
// @tier slow — drives a local workerd
// Output that begins with U+FEFF (bytes EF BB BF) reaches the terminal with
// it, as a Linux terminal receives every byte a program writes: the wasm
// bash's printf, a node program's write of the bytes, and the shell's cat of
// a file that begins with them. And a child's command is its name, every
// character its own: node's spawnSync(' node') and spawnSync('\uFEFFnode')
// find no program (ENOENT), as host Node's do. Host bash and host node run
// the same lines; the BOM must lead each output.
//
// Red before: the output streams' decoders dropped a leading BOM (one per
// process, and one per chunk where output was decoded piece by piece), and
// the child process manager trimmed a command, the BOM with the spaces.
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
const spawns = "const cp = require('child_process'); for (const c of [' node', 'node ', '\\\\uFEFFnode']) { const r = cp.spawnSync(c, ['-e', '1']); console.log(JSON.stringify([c, r.error ? r.error.code : null])); }";
// [the line, the text its output begins with once the terminal's leading line breaks are gone]
const lines = [
  ["bash -c 'printf \"\\357\\273\\277x\\n\"'", `${BOM}x`],
  ['node -e "process.stdout.write(Buffer.from([0xef, 0xbb, 0xbf, 0x79, 0x0a]))"', `${BOM}y`],
  ['cat bom.txt', `${BOM}z`],
];

// The oracle: host bash and host node, in a directory holding the same file.
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
  spawned = hostOut(`node -e "${spawns}"`);
} finally {
  rmSync(host, { recursive: true, force: true });
}
assert.equal(spawned, '[" node","ENOENT"]\n["node ","ENOENT"]\n["\uFEFFnode","ENOENT"]\n', 'host node finds no program for a padded name');

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
    const shown = r.stdout.replace(/\r/g, '').replace(/^\n+/, '');
    if (shown === spawned) console.log('  ok  spawnSync of a padded name finds no program');
    else {
      console.log(`  FAIL  spawnSync of a padded name: ${JSON.stringify(r.stdout)}`);
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
