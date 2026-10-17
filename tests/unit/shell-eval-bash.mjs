#!/usr/bin/env bun
// `eval` runs its arguments, joined by spaces, in the shell that runs it: its
// assignments, `cd`, functions and aliases are that shell's; its `return`,
// `break` and `exit` act there; its status is the last command's, 0 where
// there is none; in a pipeline or a subshell it is that child's. It takes no
// options: `--` ends them, any other is refused with status 2. In a script,
// a status its text ended with is no special builtin's failure: it is
// recoverable, as a sourced file's is. Before, the shell had no `eval`
// ("eval: command not found"); a sourced file's `exit` ended only the file,
// as an eval's or an alias's would have, and a sourced file's failing last
// command ended a script. Each line runs as a session's line and as host
// bash's `bash -c`; each script as `bash ./s.sh`. Host bash is the oracle
// (stdout, status, stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
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
  // A sourced file's `exit` ends the shell too.
  "printf 'exit 6\\n' > s.sh; . ./s.sh; echo no",
  "printf 'exit 7\\n' > s.sh; ( . ./s.sh; echo no ); echo \"st=$?\"",
  // So does an alias's.
  "alias q='exit 3'\nq\necho no",
  "eval -- 'echo hi'; eval --; echo \"st=$?\"",
  'eval -x; echo "st=$?"',
  "eval '-x foo'; echo \"st=$?\"",
  'eval --foo; echo "st=$?"',
  'eval -- -x; echo "st=$?"',
];

/** Run as scripts: a special builtin's own failure ends one, its text's does not. */
const SCRIPTS = [
  'eval false || echo recovered; echo after',
  'eval false; echo "st=$?"',
  'set -e; eval false || true; echo after',
  'set -e; eval false; echo no',
  "eval -- 'echo hi'; eval 'exit 3' || echo no; echo no",
  "printf 'false\\n' > f.sh; . ./f.sh || echo recovered; . ./f.sh; echo \"st=$?\"",
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, a function's `environment: line 2: ` (the armada image's bash). */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const runs = [
  ...CASES.map((line) => ({ line, script: false })),
  ...SCRIPTS.map((line) => ({ line, script: true })),
];
const want = [];
for (const { line, script } of runs) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-eval-'));
  try {
    if (script) writeFileSync(join(dir, 's.sh'), `${line}\n`);
    const argv = script ? ['./s.sh'] : ['--norc', '--noprofile', '-O', 'expand_aliases', '-c', line];
    const r = spawnSync('bash', argv, { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
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
  let n = 0;
  for (const [i, { line, script }] of runs.entries()) {
    const dir = `/home/user/ev${n++}`;
    await ws.exec(`mkdir -p ${dir}`, { cwd: '/home/user' });
    if (script) await ws.fs.writeFile(`${dir}/s.sh`, `${line}\n`);
    const r = await ws.exec(script ? 'bash ./s.sh' : line, { cwd: dir });
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-eval-bash: ${runs.length - failed.length} of ${runs.length} lines and scripts as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
