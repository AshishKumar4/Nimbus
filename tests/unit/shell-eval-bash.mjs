#!/usr/bin/env bun
// `eval` runs its arguments, joined by spaces, in the shell that runs it: its
// assignments, `cd`, functions and aliases are that shell's; its `return`,
// `break` and `exit` act there; its status is the last command's, 0 where
// there is none; in a pipeline or a subshell it is that child's. It takes no
// options: `--` ends them, any other is refused with status 2. In a script,
// a status its text ended with is no special builtin's failure: it is
// recoverable, as a sourced file's is. A syntax error in its text, or in a
// sourced file, is its status 2, said on its stderr, the lines of the text
// read before it run and the rest of the line it is in going on (before, it
// ended that line, said on the terminal); one met running the text (a
// command substitution's) is not its own. Before, the shell had no `eval`
// ("eval: command not found"); a sourced file's `exit` ended only the file,
// as an eval's or an alias's would have, and a sourced file's failing last
// command ended a script. Each line runs as a session's line and as host
// bash's `bash -c`; each script as `bash ./s.sh`. Host bash is the oracle
// (stdout, status, stderr without bash's line prefix). A script's special
// builtin that fails on its own (`.` of a missing file, an eval option)
// ends it, as POSIX has it, inside eval's text or a sourced file too, and so
// does a syntax error in that text while eval or `.` is the builtin last
// dispatched (bash's evalstring): those run as `sh ./s.sh`, with `bash
// --posix` the oracle (stdout and status). `bash ./s.sh`, or a bash an sh
// runs, is not in POSIX mode: it goes on (before, every script ended).
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
  // `set -e` in eval's text in a child shell ends that child, and the parent goes on.
  "true | eval 'set -e; false'; echo \"after ${PIPESTATUS[*]}\"",
  '( set -e; false; echo no ); echo "after $?"',
  "( eval 'set -e; false; echo no' ); echo \"after $?\"",
  "x=$(eval 'set -e; false; echo no'); echo \"after $? [$x]\"",
  "{ eval 'set -e; false'; echo no; } & wait $!; echo \"bg $?\"",
  "eval 'if' 2>/dev/null; echo \"st=$?\"",
  "eval $'echo a\\nif' 2>/dev/null; echo \"st=$?\"",
  "eval 'echo a; (echo b) (echo c)' 2>/dev/null; echo \"st=$?\"",
  "f() { eval 'fi' 2>/dev/null; echo \"in=$?\"; }; f; echo \"out=$?\"",
  "eval 'if' 2>/dev/null || echo recovered",
  "x=$(eval 'fi' 2>&1); [ -n \"$x\" ] && echo has-message; y=$(eval 'if' 2>/dev/null); echo \"[$y] $?\"",
  "printf 'echo side\\nif\\n' > bad.sh; . ./bad.sh 2>/dev/null; echo \"st=$?\"",
  "printf 'echo s1; (echo a) (echo b)\\necho never\\n' > bad2.sh; . ./bad2.sh 2>/dev/null; echo \"st=$?\"",
  "set -e; eval 'if' 2>/dev/null; echo after",
];

/** Run as scripts: a special builtin's own failure ends one, its text's does not. */
const SCRIPTS = [
  ". ./missing 2>/dev/null; echo after",
  "eval -x 2>/dev/null; echo after",
  "eval 'if' 2>/dev/null; echo \"st=$?\"\necho next",
  'eval false || echo recovered; echo after',
  'eval false; echo "st=$?"',
  'set -e; eval false || true; echo after',
  'set -e; eval false; echo no',
  "eval -- 'echo hi'; eval 'exit 3' || echo no; echo no",
  "printf 'false\\n' > f.sh; . ./f.sh || echo recovered; . ./f.sh; echo \"st=$?\"",
  "set -e; eval 'false; echo no'; echo no",
];

/** Run as POSIX scripts: a special builtin's own failure ends one, from inside eval's text or a sourced file too. */
const POSIX_SCRIPTS = [
  "eval $'bash -c eval\\nif' 2>/dev/null; echo survived",
  "eval $'echo before\\neval\\nif' 2>/dev/null; echo survived",
  "eval $'echo a >/dev/null/missing\\nif' 2>/dev/null; echo survived",
  "printf 'if\\n' > b5.sh; source ./b5.sh 2>/dev/null; echo survived",
  "source ./missing 2>/dev/null; echo after",
  "bash -c 'eval -x 2>/dev/null; echo survived; set -o | grep posix | grep -c on'; echo after",
  "eval 'if' 2>/dev/null; echo survived",
  "eval $'echo a\\nif' 2>/dev/null; echo survived",
  "eval $'x=1\\nif' 2>/dev/null; echo survived",
  "printf 'if\\necho never\\n' > b3.sh; . ./b3.sh 2>/dev/null; echo survived",
  "printf 'echo side\\nif\\n' > b.sh; . ./b.sh 2>/dev/null; echo survived",
  "command eval 'if' 2>/dev/null; echo \"st=$?\"",
  "eval 'if' 2>/dev/null || echo recovered; echo after",
  "eval '. ./missing'; echo after",
  "eval 'eval -x'; echo after",
  "printf '. ./missing\\n' > g.sh; . ./g.sh; echo after",
  'eval false || echo recovered; echo after',
];

/** Lines whose stdout alone is compared: a command substitution's syntax error, met running eval's text, ends the line it is in (bash's parse_comsub). */
const STDOUT_LINES = [
  "eval 'echo $(fi)' 2>/dev/null; echo survived",
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, a function's `environment: line 2: ` (the armada image's bash). */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const runs = [
  ...CASES.map((line) => ({ line, script: null })),
  ...SCRIPTS.map((line) => ({ line, script: 'bash' })),
  ...POSIX_SCRIPTS.map((line) => ({ line, script: 'sh' })),
  ...STDOUT_LINES.map((line) => ({ line, script: null, stdoutOnly: true })),
];
const want = [];
for (const { line, script, stdoutOnly } of runs) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-eval-'));
  try {
    if (script !== null) writeFileSync(join(dir, 's.sh'), `${line}\n`);
    const argv = script === 'sh' ? ['--posix', './s.sh'] : script === 'bash' ? ['./s.sh'] : ['--norc', '--noprofile', '-O', 'expand_aliases', '-c', line];
    const r = spawnSync('bash', argv, { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push(stdoutOnly ? { stdout: r.stdout } : script === 'sh' ? { stdout: r.stdout, status: r.status } : { stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
// `bash` and `sh`, as the session's command registry has them.
registerShellEntrypointCommands(ws.registry, { execute: (cmd, options) => ws.shell.execute(cmd, options) });
const failed = [];
try {
  let n = 0;
  for (const [i, { line, script, stdoutOnly }] of runs.entries()) {
    const dir = `/home/user/ev${n++}`;
    await ws.exec(`mkdir -p ${dir}`, { cwd: '/home/user' });
    if (script !== null) await ws.fs.writeFile(`${dir}/s.sh`, `${line}\n`);
    const r = await ws.exec(script === null ? line : `${script} ./s.sh`, { cwd: dir });
    const ours = stdoutOnly ? { stdout: r.stdout } : script === 'sh' ? { stdout: r.stdout, status: r.exitCode } : { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-eval-bash: ${runs.length - failed.length} of ${runs.length} lines and scripts as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
