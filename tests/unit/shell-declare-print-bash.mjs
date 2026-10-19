#!/usr/bin/env bun
// `declare -p` (and `typeset -p`, `local -p`), as bash 5.2 prints it: each
// named variable as a declaration bash reads back, its attributes (a array,
// r readonly, x exported; `--` for none) and its value in double quotes with
// `"`, `$`, backquote and backslash escaped, or as $'…' when it holds a
// character that does not print (its UTF-8 bytes in octal); an array as
// ([i]="v" …), holes skipped, however high its last index; a name declared
// with an attribute and no value (or the running function's local) as its
// name alone; an unset name is `declare: NAME: not found`, status 1. With -a,
// -r or -x and no names, the variables with any of them; `local -p`, the
// running function's own. Its output read back (eval) is the variable again.
// `export` marks a name exported (`-n` unmarks it; a readonly name too), as
// `declare -x` does, `unset` drops the mark, and a local's mark is its own,
// the caller's back after the call; `export -f` takes only functions. Before, lifo
// said `declare: -p: invalid option` (status 2) and kept no export mark
// (ticket-lifo-declare-print). Each line runs as a session's line and as host
// bash's `bash -c` under C.UTF-8. Host bash is the oracle (stdout, status,
// stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const CASES = [
  "x=1; declare -p x",
  "a=(a 'b c'); a[5]=z; declare -p a",
  "export y=$'q\"\\\\$'; declare -p y",
  "readonly r=1; declare -p r",
  "declare -p nope; echo $?",
  "x=$'a\\tb\\x01'\"'\"; declare -p x",
  "e=(); declare -p e",
  "export z=1; export -n z; declare -p z",
  "export q; q=2; declare -p q",
  "f() { local l=3; local -p l; typeset -p l; }; f",
  "declare -rx w=5; declare -p w",
  "u=1; unset u; declare -p u; echo $?",
  "x='it'\"'\"'s $HOME `pwd` \\\\'; declare -p x",
  "x=1 y=2; declare -p x y",
  "declare -x d=4; env | grep '^d='; declare -p d",
  "x=1; s=$(declare -p x); unset x; eval \"$s\"; echo $x; declare -p x",
  "declare x=1 -r; x=2; echo $x",
  "x=outer; f() { local x=inner; export x; declare -p x; }; f; declare -p x",
  "export x=g; f() { local x; export -n x; declare -p x; }; f; declare -p x",
  "export x=g; f() { local x=l; declare -p x; }; f; declare -p x",
  "export p; declare -p p; readonly r2; declare -p r2; export -p | grep -E ' (p|r2)$'",
  "plain=1; export marked=2; a=(v); declare -xp | grep -E 'plain|marked|a='; declare -ap | grep -E 'plain|marked| a='; declare -rp | grep -E 'plain|marked| a='",
  "x=1; export -f x; echo $?; declare -p x; f() { :; }; export -f f; echo $?",
  "readonly r=1; export r=2; echo $?; declare -p r",
  "x=$'\\u0085\\u2028\\u200b\\u00e9!\\x7f\\e'; declare -p x",
  "a=(); a[1000000000]=z; declare -p a",
  "f() { local y=2; local -p x; echo $?; local -p; }; x=1; f",
  "x=1; local -p x; echo $?",
  "x=$'\\377a\\001'; declare -p x; s=$(declare -p x); unset x; eval \"$s\"; [[ $x == $'\\377a\\001' ]] && echo same",
  "x=1; x=1 export x; declare -p x; y=2; y=2 declare -x y; declare -p y",
  "declare p; declare -p p; export q; export -n q; declare -p q",
  "f() { local p; declare -p | grep -E ' p$'; }; f",
  "f() { local z=1 a=2; local -p; }; f; g() { local plain=1 marked=2; export marked; local -xp; }; g",
  "f() { :; }; export -f f=value; echo $?",
  "f() { echo still; }; declare f; unset f; f; declare -p f",
  "x=outer; x=inner eval 'export x'; declare -p x; unset x; x=inner eval 'export x'; declare -p x; echo $?",
  "x=0; x=1 export x; declare -p x; y=0; y=1 readonly y; declare -p y; z=0; z=1 export w; declare -p z",
  "export -n ghost; declare -p ghost; echo $?",
  "x=outer; x=inner export -n x; declare -p x; y=outer; y=inner export -p y; declare -p y",
  "x=outer; x=inner true 2>/dev/null </dev/null/child; echo $?; declare -p x; x=inner local x; declare -p x",
  "x=1 declare -p x; f() { declare -p x; }; x=2 f; x=3 eval 'declare -p x'; declare -p x; echo $?",
  "g() { declare -p p; }; f() { local p; g; }; f; declare -p p; echo $?",
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const LINES = CASES.map((c) => (typeof c === 'string' ? { line: c, compare: 'all' } : c));
const compared = (result, compare) => (compare === 'out' ? { stdout: result.stdout, status: result.status } : result);

const want = [];
for (const { line, compare } of LINES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-declare-'));
  try {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
    assert.equal(r.error, undefined, `bash ran ${JSON.stringify(line)}: ${r.error?.message}`);
    want.push(compared({ stdout: r.stdout, stderr: plainStderr(r.stderr), status: r.status }, compare));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [i, { line, compare }] of LINES.entries()) {
    const r = await ws.exec(line, { cwd: '/home/user' });
    const ours = compared({ stdout: r.stdout, stderr: r.stderr, status: r.exitCode }, compare);
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
  // A prefix assignment whose expansion throws gives back the bindings before it, in a shell
  // that goes on (a session's named shell, as an interactive bash): x as it was. (A named
  // shell's next line has its variables back as its environment: exported, so its value is compared.)
  const persistent = { cwd: '/home/user', shellId: 'prefix-throw' };
  await ws.exec('x=outer', persistent);
  await ws.exec('x=inner y=${missing:?oops} true', persistent);
  const after = await ws.exec('declare -p x', persistent);
  if (!after.stdout.endsWith(' x="outer"\n')) failed.push(`a throwing prefix expansion: ${JSON.stringify(after)}`);
} finally {
  await ws.close();
}
console.log(`shell-declare-print-bash: ${LINES.length - failed.length} of ${LINES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
