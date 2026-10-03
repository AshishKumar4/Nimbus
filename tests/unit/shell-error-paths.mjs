#!/usr/bin/env bun
// A shell command's error names the operand as the caller wrote it, in GNU's
// words, never a storage key.
//
// Kinu ask 9: `ls /tmp/spoon` printed "ls: cannot access '/tmp/spoon':
// ENOENT: no such file or directory, stat 'tmp/spoon'", the key the store
// files it under. cp and mv printed Node's message whole, and chmod a
// refusal's message instead of GNU's.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1 });
await ws.start();

const cases = [
  // GNU coreutils 9's words for each, with the operand as written.
  ['ls /tmp/spoon', "ls: cannot access '/tmp/spoon': No such file or directory"],
  ['cd /tmp && ls spoon', "ls: cannot access 'spoon': No such file or directory"],
  ['ls /etc/passwd/x', "ls: cannot access '/etc/passwd/x': Not a directory"],
  ['chmod 644 /tmp/spoon', "chmod: cannot access '/tmp/spoon': No such file or directory"],
  ['cp /tmp/spoon /tmp/x', "cp: cannot stat '/tmp/spoon': No such file or directory"],
  ['mv /tmp/spoon /tmp/y', "mv: cannot stat '/tmp/spoon': No such file or directory"],
  ['ln -s a /tmp/spoon/s', "ln: failed to create symbolic link '/tmp/spoon/s': No such file or directory"],
  ['cd /tmp/spoon', 'cd: /tmp/spoon: No such file or directory'],
];
for (const [line, expected] of cases) {
  const result = await ws.exec(line);
  assert.equal(result.exitCode, 1, line);
  assert.equal(result.stderr.trim(), expected, line);
}

// tree (2.3.1) names the directory as the caller wrote it, the first operand
// included when no `-L` is given, and refuses one it cannot open with 2.
await ws.exec('mkdir -p /tmp/t/a && touch /tmp/t/f');
const tree = await ws.exec('cd /tmp && tree t');
assert.equal(tree.exitCode, 0);
assert.equal(tree.stdout, 't\n├── a\n└── f\n\n1 directories, 1 files\n');
const missing = await ws.exec('tree /tmp/spoon');
assert.equal(missing.exitCode, 2);
assert.equal(missing.stdout, '/tmp/spoon  [error opening dir]\n\n0 directories, 0 files\n');

console.log('shell-error-paths: ok');
