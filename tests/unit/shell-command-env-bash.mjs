#!/usr/bin/env bun
// A command's environment, as bash 5.2 builds it (export_env): the exported
// variables' values, a prefix assignment's for its command alone; an
// unexported variable, a local, or an array is the shell's own and no
// child's. PWD and OLDPWD are exported from the start (OLDPWD declared, with
// no value, until a cd). Before (ticket-lifo-command-environment-exports),
// every scalar the shell held reached every command: `x=1; env` printed x,
// and a variable set without export reached each program run. Host bash is
// the oracle (stdout, status, stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LINES = [
  "x=1; env | grep -c '^x='",
  "export y=2; env | grep '^y='; y=3; env | grep '^y='",
  "export z=3; export -n z; env | grep -c '^z='",
  "w=1 env | grep '^w='; env | grep -c '^w='",
  "x=1; bash -c 'echo ${x-unset}'; export x; bash -c 'echo ${x-unset}'",
  "a=(1 2); export a; env | grep -c '^a='",
  "f() { local l=1; bash -c 'echo ${l-unset}'; }; f",
  "declare -p OLDPWD; cd /; bash -c 'echo \"${OLDPWD:+old} $PWD\"'",
  "declare -x d=4; typeset -x t=5; env | grep -E '^(d|t)=' | sort",
  "s=secret; ( bash -c 'echo ${s-unset}' ); echo $(bash -c 'echo ${s-unset}'); bash -c 'echo ${s-unset}' | cat",
  "export q=1; unset q; env | grep -c '^q='; q=2; env | grep -c '^q='",
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, a script's `./s.sh: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment|\.\/s\.sh): (?:-c: )?(?:line \d+: )?/gm, '');

const CASES = LINES.map((c) => (typeof c === 'string' ? { line: c, script: null } : c));

const want = [];
for (const { line, script } of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-command-env-'));
  try {
    if (script !== null) writeFileSync(join(dir, 's.sh'), `${line}\n`);
    const argv = script === null ? ['--norc', '--noprofile', '-c', line] : ['./s.sh'];
    const r = spawnSync('bash', argv, { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8', HOME: '/home/user' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
// `bash s.sh` runs the script as the session's bash does.
registerShellEntrypointCommands(ws.registry, { execute: (cmd, options) => ws.shell.execute(cmd, options) });
const failed = [];
try {
  for (const [i, { line, script }] of CASES.entries()) {
    const dir = `/home/user/case${i}`;
    await ws.exec(`mkdir -p ${dir}`, { cwd: '/home/user' });
    if (script !== null) await ws.fs.writeFile(`${dir}/s.sh`, `${line}\n`);
    const r = await ws.exec(script === null ? line : `${script} ./s.sh`, { cwd: dir });
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}

console.log(`shell-command-env-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
