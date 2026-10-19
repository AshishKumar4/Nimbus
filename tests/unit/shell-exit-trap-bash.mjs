#!/usr/bin/env bun
// An `exit` in the EXIT trap's action is the shell's status, as is an end
// by `set -e` there; an action that ends otherwise leaves the status the
// shell was ending with. A bare `exit` there ends with that status, not the
// action's last command's (POSIX). A subshell's and a command
// substitution's traps are their own. Before, the action's `exit` ended
// only the action, and the status was always the one before the trap.
// Each script runs as `bash ./s.sh`; host bash is the oracle (stdout,
// status, stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const SCRIPTS = [
  "trap 'exit 5' EXIT; exit 1",
  "trap 'false' EXIT; exit 1",
  "trap 'eval \"exit 6\"' EXIT; true",
  "trap 'false; exit' EXIT; exit 3",
  "trap 'exit' EXIT; false",
  "( trap 'exit 5' EXIT; exit 1 ); echo \"sub $?\"",
  "set -e; trap 'false; echo no' EXIT; true",
  "trap 'exit 5' EXIT; echo hi",
  'f() { exit 4; }; trap f EXIT; true',
  "trap 'echo in; exit 7; echo no' EXIT; exit 2",
  "x=$(trap 'exit 9' EXIT; echo out); echo \"cs $? $x\"",
  "trap 'echo \"st $?\"' EXIT; (exit 3)",
  // A substitution, and a simple command forked (a pipeline's element, a job), are still in the action:
  // a bare `exit` there ends with the trap's entry status, and an EXIT trap set there does not run.
  // A compound command forked, `( … )` among them, is not.
  "trap 'x=$(false; exit); exit $?' EXIT; exit 3",
  "trap 'x=$( { false; exit; } ); exit $?' EXIT; exit 3",
  "trap 'x=$( (false; exit) ); exit $?' EXIT; exit 3",
  "trap 'false | exit; exit $?' EXIT; exit 3",
  "trap 'false | f; exit $?' EXIT; f() { false; exit; }; exit 3",
  "trap 'true | { false; exit; }; exit $?' EXIT; exit 3",
  "trap 'true | ( false; exit ); exit $?' EXIT; exit 3",
  "trap '(false; exit); exit $?' EXIT; exit 3",
  "f() { false; exit; }; trap 'f & wait $!; exit $?' EXIT; exit 3",
  "trap '{ false; exit; } & wait $!; exit $?' EXIT; exit 3",
  "trap 'true | f & wait $!; exit $?' EXIT; f() { false; exit; }; exit 3",
  "trap 'false | exit & wait $!; exit $?' EXIT; exit 3",
  "trap 'f && true & wait $!; exit $?' EXIT; f() { false; exit; }; exit 3",
  "trap 'x=$(trap \"exit 7\" EXIT; exit); exit $?' EXIT; exit 3",
  "trap '( trap \"exit 7\" EXIT; exit ); exit $?' EXIT; exit 3",
  "trap 'true | trap \"exit 7\" EXIT; exit $?' EXIT; exit 3",
];

const plainStderr = (text) => text.replace(/^(?:bash|\.\/s\.sh): (?:line \d+: )?/gm, '');

const want = [];
for (const line of SCRIPTS) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-exit-trap-'));
  try {
    writeFileSync(join(dir, 's.sh'), `${line}\n`);
    const r = spawnSync('bash', ['./s.sh'], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
// `bash`, as the session's command registry has it.
registerShellEntrypointCommands(ws.registry, { execute: (cmd, options) => ws.shell.execute(cmd, options) });
const failed = [];
try {
  for (const [i, line] of SCRIPTS.entries()) {
    const dir = `/home/user/trap${i}`;
    await ws.exec(`mkdir -p ${dir}`, { cwd: '/home/user' });
    await ws.fs.writeFile(`${dir}/s.sh`, `${line}\n`);
    const r = await ws.exec('bash ./s.sh', { cwd: dir });
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-exit-trap-bash: ${SCRIPTS.length - failed.length} of ${SCRIPTS.length} scripts as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
