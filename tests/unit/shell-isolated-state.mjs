#!/usr/bin/env bun
// `sh -c` and `bash -c` run a script in a shell of their own: what it
// defines (functions and aliases as well as variables, options and traps)
// is gone when it returns, as it is when that shell's process exits. And
// `unset` takes bash's -f and -v: a function is removed by `unset -f`, or by
// a bare `unset` when no variable has its name.
//
// Each case is one line run in the workspace's shell; the answers are bash
// 5.3's, with Nimbus's diagnostics (no `bash: line 1:` prefix).

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const CASES = [
  // unset
  ['f() { echo x; }; unset -f f; f; echo s=$?', 's=127\n', 'f: command not found\n'],
  ['f() { echo x; }; unset f; f; echo s=$?', 's=127\n', 'f: command not found\n'],
  ['f=1; f() { echo fn; }; unset f; f; echo s=$? v=${f-none}', 'fn\ns=0 v=none\n', ''],
  ['f() { echo x; }; unset -v f; f', 'x\n', ''],
  ['f() { echo x; }; (unset -f f); f', 'x\n', ''],
  ['unset -fv x; echo s=$?', 's=1\n', 'unset: cannot simultaneously unset a function and a variable\n'],
  ['unset -x foo; echo s=$?', 's=2\n', 'unset: -x: invalid option\nunset: usage: unset [-f] [-v] [-n] [name ...]\n'],
  ['f() { echo x; }; unset -f -- f; f; echo s=$?', 's=127\n', 'f: command not found\n'],
  ['unset -f nosuch; echo s=$?', 's=0\n', ''],
  ['f() { echo x; }; g() { echo y; }; unset -f f g; f; g; echo s=$?', 's=127\n', 'f: command not found\ng: command not found\n'],

  // What a script's shell defines stays in it
  ["sh -c 'h() { echo leaked; }'; h; echo s=$?", 's=127\n', 'h: command not found\n'],
  ["bash -c 'h() { echo leaked; }'; h; echo s=$?", 's=127\n', 'h: command not found\n'],
  ["k() { echo kept; }; sh -c 'unset -f k'; k", 'kept\n', ''],
  ["k() { echo kept; }; sh -c 'k() { echo replaced; }'; k", 'kept\n', ''],
];

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
registerShellEntrypointCommands(ws.registry, { execute: (command, options) => ws.shell.execute(command, options) });

const failures = [];
for (const [line, stdout, stderr] of CASES) {
  const result = await ws.exec(line);
  if (result.stdout !== stdout || result.stderr !== stderr) {
    failures.push(`${line}\n    want ${JSON.stringify([stdout, stderr])}\n    got  ${JSON.stringify([result.stdout, result.stderr])}`);
  }
}

// An alias a script defines is gone after it, too; the alias takes effect on
// the line after its definition, so this one is three lines.
await ws.exec("sh -c \"alias zz='echo leaked'\"");
const alias = await ws.exec('zz; echo s=$?');
if (alias.stdout !== 's=127\n' || alias.stderr !== 'zz: command not found\n') {
  failures.push(`an alias from sh -c\n    got  ${JSON.stringify([alias.stdout, alias.stderr])}`);
}

await ws.close();
for (const failure of failures) console.log(`FAIL ${failure}`);
assert.equal(failures.length, 0, `${failures.length} of ${CASES.length + 1} cases differ`);
console.log(`shell-isolated-state: ${CASES.length + 1} cases match bash`);
