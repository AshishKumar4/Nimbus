#!/usr/bin/env bun
// `eval` runs its arguments, joined by spaces, in the shell that runs it: its
// assignments, `cd`, functions and aliases are that shell's; its `return`,
// `break` and `exit` act there; its status is the last command's, 0 where
// there is none; in a pipeline or a subshell it is that child's. Before, the
// shell had no `eval` ("eval: command not found"). Host bash is the oracle
// (stdout, status, stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const CASES = [
  "eval 'echo hi'",
  "x=1; eval echo '$x'",
  'eval; echo "st=$?"',
  "false; eval ''; echo \"st=$?\"",
  "eval 'x=5'; echo \"$x\"",
  "mkdir -p d; eval 'cd d'; basename \"$PWD\"",
  "f() { eval 'return 3'; echo no; }; f; echo \"st=$?\"",
  'for i in 1 2; do eval break; echo no; done; echo end',
  'eval false; echo "st=$?"',
  "set -- a b; eval 'echo $2'",
  'eval "echo \\"a  b\\""',
  "eval 'echo hi' | tr a-z A-Z",
  "eval 'echo one; echo two'",
  "eval $'echo one\\necho two'",
  "v='echo nested'; eval \"eval \\\"\\$v\\\"\"",
  'f() { echo "f $1"; }; eval f arg',
  "eval 'exit 4'; echo no",
  "( eval 'exit 5' ); echo \"st=$?\"",
  "alias e='echo aliased'\neval e",
  "eval 'echo $((1 + 2))'",
  "eval 'g() { echo defined; }'; g",
  "eval 'nosuchcommand'; echo \"st=$?\"",
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, a function's `environment: line 2: ` (the armada image's bash). */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const want = [];
for (const line of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-eval-'));
  try {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-O', 'expand_aliases', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  let n = 0;
  for (const [i, line] of CASES.entries()) {
    const dir = `/home/user/ev${n++}`;
    await ws.exec(`mkdir -p ${dir}`, { cwd: '/home/user' });
    const r = await ws.exec(line, { cwd: dir });
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-eval-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
