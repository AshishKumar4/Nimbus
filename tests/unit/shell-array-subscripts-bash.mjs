#!/usr/bin/env bun
// An array literal's `[subscript]=value` elements, as bash 5.2 assigns them
// (arrayfunc.c assign_compound_array_list):
//
//   - an element that begins with an unquoted `[subscript]=` is written at
//     the subscript's arithmetic, its subscript expanded first (`[$i]`,
//     `[$(cmd)]`, quoted characters inside); `[subscript]+=` appends to the
//     element there; a quoted `"[0]=x"`, `\[0]=x`, `[1]` and `[1]x=y` are
//     words;
//   - a word's elements go on at the next index: 0, or past the last that
//     holds a value for `a+=(…)`, and the index after a subscripted one;
//   - a negative subscript counts back from past the last value; one still
//     before the first, an empty one, and `@` or `*` are refused with bash's
//     diagnostic and skipped, and the rest is assigned, status 0;
//   - a value is expanded as an assignment's is: no splitting or globbing,
//     `~` at its start, "$@" joined;
//   - `declare -a`, `typeset -a` and `local -a` take the same literal, and
//     `declare -p`'s output for a sparse array is read back as it was.
//
// `a[i]=v` and `${a[i]}` follow the same index rule: a negative subscript
// counts back from past the last value; for `a[i]=v`, one before the first,
// or an empty one, is a bad array subscript. A command of assignments alone
// that cannot assign (that, or a readonly name) discards the rest of its
// line, as bash's DISCARD does: the next line runs with $? 1, in a script, a
// function's caller's line, eval's text; a subshell ends with 1. A prefix
// `a+=(…)` leaves the array as it was after its command. The subscript of a
// `[subscript]=` element is read whole: `[i + 1]`, `[(1+2)*2]`, a `]` in a
// substitution its own. Under `set -e` a reported error ends the shell; in
// a POSIX script (`sh`) a failed assignment does.
//
// Red before (ticket-lifo-indexed-array-literals): `[i]=v` was stored as the
// literal word at consecutive indices; `a+=(…)` went on past a removed last
// element; `a[-9]=x` set a property no expansion reads. Host bash is the
// oracle (stdout, status, stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LINES = [
  'a=([0]=one [5]=z); declare -p a',
  'a=(x [3]=y z); declare -p a',
  'a=("[0]=lit"); declare -p a',
  'a=(\\[1]=x [1]x=y [1]); declare -p a',
  'a=(one); a+=([4]=four); declare -p a',
  'a=(one two); a+=([0]+=X q); declare -p a',
  'i=2; v="p q"; a=([i+1]=$v [$i]=w); declare -p a',
  'a=([-1]=x z); echo "st=$?"; declare -p a',
  'a=(p [-5]=x z)\necho "st=$?"; declare -p a',
  'a=(p q [-1]=x z); declare -p a',
  'b=(a b c); b+=([-1]=x); declare -p b',
  'a=([@]=x z)\necho "st=$?"; declare -p a',
  'a=([]=x z)\necho "st=$?"; declare -p a',
  'declare -a a=([-1]=x z)\necho "st=$?"; declare -p a',
  'i=-5; v="p q"; a=([$i]=$v z)\necho "st=$?"; declare -p a',
  'a=(); a[-1]=x\necho "st=$?"; declare -p a',
  'a=(); a[]=x\necho "st=$?"; declare -p a',
  'i=-1; a=(); a[$i]=x\necho "st=$?"; declare -p a',
  'a=(p q r); unset "a[2]"; a[-1]=x; declare -p a',
  'a=(p q r); unset "a[2]"; a+=([-1]=x); declare -p a',
  'a=(p q r); unset "a[2]"; a+=(s); declare -p a',
  'a=(p); unset "a[0]"; a+=(q); declare -p a',
  'x=s; x+=(t); declare -p x',
  'x=s; x+=([3]=t); declare -p x',
  'a=([0]=~/q [1]=$HOME [2]=*); declare -p a',
  'set -- "p q" r; a=([5]="$@" [1]=$*); declare -p a',
  'a=(x [3]+=y); declare -p a',
  'a=([1]=b); a+=([1]+=c d); declare -p a',
  'a=([1]=x [1]+=y); declare -p a',
  'a=([1]=x); a+=([1]=y); declare -p a',
  'a=([0]=x); a=([1]=y); declare -p a',
  'f() { local -a l=([2]=x y); declare -p l; }; f',
  'f() { local a=([1]=x); declare -p a; }; f',
  'declare -a d=([3]=x y); declare -p d; typeset -a t=([1]=q); declare -p t',
  'a=([2+3]=x [1]=one [1]=two); declare -p a',
  "a=([$(echo 4)]=c [\"2\"]=q ['3']=s); declare -p a",
  'a=([1]=x [3]= [4]=""); declare -p a',
  'a=( [1]=x   [2]=y ); declare -p a',
  'a=([1]=$(echo "u v") w); declare -p a',
  'a=(one); a[5]=z; s=$(declare -p a); unset a; eval "$s"; declare -p a',
  'a=([1]=x); echo "${#a[@]} ${!a[@]} ${a[1]}"; b=("${a[@]}"); declare -p b',
  'a=([x]=1); declare -p a; x=3; b=([x]=1); declare -p b',
  'declare -r r=(1); r=([2]=x)\necho "st=$?"; declare -p r',
  'i=2; a=([i + 1]=x [(1+2)*2]=y [ 0 ]=w [ i ]+=v); declare -p a',
  'a=(old); a+=(new) true; declare -p a',
  'a=(p q r); unset "a[2]"; a[-1]=x; echo "${a[-1]} ${a[-2]}"; b=(p q r); unset "b[2]"; echo "${b[-1]}"',
  // A command of assignments alone that cannot assign discards the rest of its line; the next line runs, $? 1.
  'a=(); a[-1]=x; echo same\necho "next $?"; readonly r=1; r=2; echo same\necho "next $?"',
  'f() { a=(); a[-1]=x; echo in; }; f; echo "after $?"\necho "next $?"',
  '(a=(); a[-1]=x; echo in); echo "paren $?"; x=$(a=(); a[-1]=x; echo in); echo "sub $? [$x]"',
  'a=(); eval "a[-1]=x; echo in\necho in2 \\$?"; echo "after $?"',
  'a=([$( : ]=; echo 2)]=v ["$( : ]; echo 1)"]=w); declare -p a',
  // Under `set -e` an error the shell reports ends it, an `if`'s condition too (bash's report_error).
  'set -e; a=(); a[-1]=x\necho next',
  'set -e; a=([-1]=x z)\necho "next $?"',
  'set -e; readonly r=1; r=2\necho next',
  'set -e; if a=([-1]=x); then echo in-if; fi; echo after',
  'set -e; declare -a d=([-1]=x)\necho next',
  // What it assigned before the refusal stays, for an EXIT trap to see.
  "a=(old); trap 'declare -p a' EXIT; set -e; a=(p [-5]=x [2]=y)",
  "a=(old); trap 'declare -p a' EXIT; set -e; declare -a a=(p [-5]=x [2]=y)",
  "a=(old); trap 'declare -p a' EXIT; set -e; a+=(p [-9]=x [5]=y)",
  // As scripts: `bash ./s.sh` discards the line; a POSIX shell's (`sh`, bash --posix the oracle) ends.
  // Their diagnostics name the script and its line, so their output and status are compared.
  { line: 'a=()\na[-1]=x; echo same\necho "next $?"\nreadonly r=1\nr=2; echo same\necho "next $?"', script: 'bash' },
  { line: 'a=()\na[-1]=x; echo same\necho "next $?"', script: 'sh' },
  { line: 'readonly r=1\nr=2; echo same\necho "next $?"', script: 'sh' },
  { line: 'a=([-1]=x z)\necho "next $?"', script: 'sh' },
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const CASES = LINES.map((c) => (typeof c === 'string' ? { line: c, script: null } : c));
const compared = (result, script) => (script === null ? result : { stdout: result.stdout, status: result.status });

const want = [];
for (const { line, script } of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-array-subscripts-'));
  try {
    if (script !== null) writeFileSync(join(dir, 's.sh'), `${line}\n`);
    const argv = script === 'sh' ? ['--posix', './s.sh'] : script === 'bash' ? ['./s.sh'] : ['--norc', '--noprofile', '-c', line];
    const r = spawnSync('bash', argv, { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8', HOME: '/home/user' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push(compared({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status }, script));
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
    const ours = compared({ stdout: r.stdout, stderr: r.stderr, status: r.exitCode }, script);
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-array-subscripts-bash: ${CASES.length - failed.length} of ${CASES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
