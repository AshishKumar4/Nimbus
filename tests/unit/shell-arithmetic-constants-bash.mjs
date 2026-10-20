#!/usr/bin/env bun
// Shell arithmetic's integer constants, as bash 5.2 reads them (expr.c
// strlong): a leading 0 is octal, 0x or 0X hexadecimal, base#digits any base
// from 2 to 64 (digits 0-9, a-z, A-Z, @ and _; to base 36 a letter's case is
// one value); a variable's value is read as an expression, a constant in it
// too. A digit past its base is `value too great for base`, a base out of
// range `invalid arithmetic base`, a bare `base#` `invalid integer
// constant`, a value that refers to itself without end `expression
// recursion level exceeded`; such an error discards the rest of the line
// (bash's evalerror), a function's caller's too, and ends a substitution
// with 1; in [[ … ]] it is the conditional's failure, status 1. The same
// constants are read in $((…)), an array subscript and [[ … -eq … ]], whose
// operands are expressions; `test`'s integers are decimal. Before
// (ticket-lifo-arithmetic-constants), every constant was read as decimal:
// $((0x1f)) was 0 and $((010)) 10. Host bash is the oracle (stdout, status,
// stderr without bash's line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LINES = [
  'echo $((010)) $((0x1f)) $((0X1F)) $((2#101)) $((36#z)) $((36#Z)) $((64#_)) $((64#@)) $((37#A)) $((37#a)) $((-010)) $((0)) $((00)) $((10#010))',
  'echo $((0x)) $((07 + 0x0a)) $((1 << 0x4)) $((0x10 / 010))',
  'x=010; y=0x1f; z="2#11"; echo $((x)) $((y + 1)) $((z)) $((x * y))',
  'x="1+2"; y=x; echo $((x * 2)) $((y + 1))',
  'a=(); a[010]=x; a[0x1]=y; declare -p a',
  '[[ 010 -eq 8 ]] && echo double; [[ 0x10 -gt 15 ]] && echo hex; [ 010 -eq 10 ] && echo single',
  'x=1; [[ x -eq 1 && 1+1 -eq 2 && 0xff -eq 255 ]] && echo operands; [[ 08 -eq 8 ]]; echo "st=$?"\necho next',
  'i=0x0f; j=0; while [ $j -lt 2 ]; do i=$((i + 1)); j=$((j + 1)); done; echo $i',
  'echo $((08))\necho next',
  'echo $((2#2))\necho next',
  'echo $((65#1))\necho next',
  'echo $((1#1))\necho next',
  'x=09; echo $((x + 1))\necho next',
  'echo $((019)); echo same\necho "next $?"',
  'echo $((0x1g))\necho $((2#))\necho $((012#1))\necho $((9#9))\necho end',
  'x=x; echo $((x))\necho "next $?"',
  'x=$(echo $((08))); echo "sub $? [$x]"',
  'f() { echo $((08)); echo in-f; }; f; echo after\necho "next $?"',
  // A branch &&, || or ?: skips is read, not evaluated: its variables are neither read as expressions nor assigned.
  'x=08; echo $((1 || x)) $((0 && x)) $((1 ? 2 : x)); echo after',
  'j=0; echo $((1 || (j=5))) $((0 && j++)) $((0 ? j++ : 3)) $j',
  // In [[ ]] an operand's error makes its comparison false; one met expanding a word discards the line.
  '[[ ! 08 -eq 8 ]] && echo neg; [[ 08 -eq 8 || 1 -eq 1 ]] && echo or',
  '[[ $((08)) -eq 8 ]]; echo same\necho "next $?"',
  // The diagnostic goes where the shell's stderr is when it is met; a redirection's target is no exception.
  'f() { echo $((08)); }; f 2>err\ngrep -c "08: value too great for base" err; echo next',
  'echo hi >"$((08))"; echo same\necho "next $?"; [ -e 08 ] || echo none',
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const want = [];
for (const line of LINES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-arithmetic-'));
  try {
    const r = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } });
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
  for (const [i, line] of LINES.entries()) {
    const r = await ws.exec(line, { cwd: '/home/user' });
    const ours = { stdout: r.stdout, stderr: r.stderr, status: r.exitCode };
    if (JSON.stringify(ours) !== JSON.stringify(want[i])) failed.push(`${JSON.stringify(line)}\n  bash: ${JSON.stringify(want[i])}\n  ours: ${JSON.stringify(ours)}`);
  }
} finally {
  await ws.close();
}
console.log(`shell-arithmetic-constants-bash: ${LINES.length - failed.length} of ${LINES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
