#!/usr/bin/env bun
// What the GNU fixtures cannot hold, since they compare stdout on files
// made as they run: diff -u's header names each file and its mtime as GNU
// diff 3.12 does (`%Y-%m-%d %H:%M:%S.%N %z`, local time; a name with a
// space C-quoted), `-` is standard input, and a directory beside a file
// names that file in it. Checked against /usr/bin/diff where GNU diffutils
// is installed, with the same mtime on both sides.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const WHEN = 1_700_000_000;
const gnu = spawnSync('/usr/bin/diff', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU diffutils');
const disk = mkdtempSync(join(tmpdir(), 'diff-header-'));
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
try {
  const files = { 'a': 'one\ntwo\n', 'my b': 'one\n2\n', 'd/a': 'one\ntwo\n' };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(disk, name, '..'), { recursive: true });
    writeFileSync(join(disk, name), text);
    utimesSync(join(disk, name), WHEN, WHEN);
  }
  await ws.exec('mkdir -p /tmp/h/d');
  for (const [name, text] of Object.entries(files)) await ws.fs.writeFile(`/tmp/h/${name}`, text);
  assert.equal((await ws.exec(`cd /tmp/h && touch -d @${WHEN} a 'my b' d/a`)).exitCode, 0);

  const ours = await ws.exec(`cd /tmp/h && diff -u a 'my b'`);
  assert.equal(ours.exitCode, 1, ours.stderr);
  const [minus, plus] = ours.stdout.split('\n');
  assert.match(minus, /^--- a\t\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.000000000 [+-]\d{4}$/);
  assert.match(plus, /^\+\+\+ "my b"\t/, 'a name with a space is C-quoted');
  if (gnu) {
    const reference = spawnSync('/usr/bin/diff', ['-u', 'a', 'my b'], { cwd: disk, encoding: 'utf8' });
    assert.equal(ours.stdout, reference.stdout, 'the header is GNU diff\'s');
  }

  const stdin = await ws.exec(`cd /tmp/h && printf 'one\\nTWO\\n' | diff -u --label input - a`);
  assert.equal(stdin.stdout.split('\n').slice(0, 1).concat(stdin.stdout.split('\n').slice(2)).join('\n'), '--- input\n@@ -1,2 +1,2 @@\n one\n-TWO\n+two\n');
  assert.deepEqual([(await ws.exec('cd /tmp/h && diff a d')).exitCode, (await ws.exec('cd /tmp/h && diff d a')).exitCode], [0, 0], 'a directory names the file of the same name in it');
} finally {
  await ws.close();
  rmSync(disk, { recursive: true, force: true });
}
console.log(`diff-unified-header: ok${gnu ? ' (GNU diff agrees)' : ''}`);
