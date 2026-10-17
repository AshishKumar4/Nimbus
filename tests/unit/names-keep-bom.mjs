#!/usr/bin/env bun
// A name that begins with U+FEFF (bytes EF BB BF) keeps it, as Linux, GNU
// tar, Info-ZIP and bash keep it: host bash runs the same lines in a
// directory of its own, and the shell's output is the same.
//   - tar -x of an archive GNU tar wrote, and unzip of one Python's zipfile
//     wrote: the members' names;
//   - ln -s to a target that begins with one, then readlink: the target;
//   - $( ) of a file's bytes that begin with one, and an exported variable
//     holding them: the value.
// Lines are compared without their order: what they list, not how a sort
// collates it.
//
// Red before: unzip, readlink and $( ) each decoded with a TextDecoder that
// drops a leading BOM. tar's names kept it already.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const BOM = '\uFEFF';
const work = mkdtempSync(join(tmpdir(), 'nimbus-bom-names-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

// The archives, written by GNU tar and Python's zipfile from the same files.
const src = join(work, 'src');
mkdirSync(join(src, 'd'), { recursive: true });
writeFileSync(join(src, `${BOM}a.txt`), 'a\n');
writeFileSync(join(src, 'd', `${BOM}b`), 'b\n');
const made = spawnSync('tar', ['-C', src, '--format=ustar', '-cf', join(work, 't.tar'), `${BOM}a.txt`, 'd'], { encoding: 'utf8' });
assert.equal(made.status, 0, made.stderr);
const zipped = spawnSync('python3', ['-c', `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('\\ufeffa.txt', 'a\\n')
    z.writestr('d/\\ufeffb', 'b\\n')
`, join(work, 'z.zip')], { encoding: 'utf8' });
assert.equal(zipped.status, 0, zipped.stderr);

const host = join(work, 'host');
mkdirSync(host);
for (const name of ['t.tar', 'z.zip']) writeFileSync(join(host, name), readFileSync(join(work, name)));
// A file whose bytes begin with the BOM's.
const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x76]);
writeFileSync(join(host, 'bom'), bomBytes);

/** Host bash running `line` in its directory: its stdout. */
function hostRun(line) {
  const ran = spawnSync('bash', ['-c', line], { cwd: host, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8', HOME: host } });
  assert.equal(ran.status, 0, `host bash: ${line}: ${ran.stderr}`);
  return ran.stdout.toString('utf8');
}

// Each line's output is bracketed: a name that begins it is not the output's first character.
const lines = [
  "mkdir x && cd x && tar -xf ../t.tar && find . -type f | sed 's/.*/[&]/'",
  "mkdir y && cd y && unzip -q ../z.zip && find . -type f | sed 's/.*/[&]/'",
  `ln -s "${BOM}t" l && printf '[%s]\\n' "$(readlink l)"`,
  "x=$(cat bom) && printf '[%s]\\n' \"$x\"",
  "export N=\"$(cat bom)\" && env | grep '^N=' | sed 's/.*/[&]/'",
];
const lineSet = (text) => text.split('\n').filter(Boolean).sort();

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const failed = [];
try {
  for (const name of ['t.tar', 'z.zip']) await ws.fs.writeFile(`/home/user/${name}`, readFileSync(join(work, name)));
  await ws.fs.writeFile('/home/user/bom', bomBytes);
  for (const line of lines) {
    const expected = hostRun(line);
    assert.ok(expected.includes(BOM), `host bash keeps the BOM: ${line}: ${JSON.stringify(expected)}`);
    const ours = await ws.exec(`cd /home/user && ${line}`);
    if (ours.exitCode === 0 && JSON.stringify(lineSet(ours.stdout)) === JSON.stringify(lineSet(expected))) {
      console.log(`  ok  ${line}`);
    } else {
      console.log(`  FAIL  ${line}: ours ${JSON.stringify(ours.stdout)} (exit ${ours.exitCode}; ${ours.stderr}); bash's ${JSON.stringify(expected)}`);
      failed.push(line);
    }
  }
} finally {
  await ws.close();
}
assert.deepEqual(failed, [], 'every line puts out what host bash puts out');
console.log(`names-keep-bom: ok (${lines.length} lines)`);
