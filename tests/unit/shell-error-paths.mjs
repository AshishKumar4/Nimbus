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
];
for (const [line, expected] of cases) {
  const result = await ws.exec(line);
  assert.equal(result.exitCode, 1, line);
  assert.equal(result.stderr.trim(), expected, line);
}

console.log('shell-error-paths: ok');
