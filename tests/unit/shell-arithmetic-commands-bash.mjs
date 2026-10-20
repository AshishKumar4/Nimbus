#!/usr/bin/env bun
// The shell's arithmetic commands, as bash 5.2 runs them: `((expression))`,
// its status 0 where the value is not 0 and 1 where it is (or an error,
// reported as `((`'s); `let arg …`, the last argument's value deciding its
// status (an error let's, status 1); and `for ((init; test; step))`, an
// empty test true, `continue` going on to the step, its body `do … done` or
// `{ … }`. The expression is expanded as a word, its quotes removed, before
// it is evaluated. `((` that no `))` closes is two subshells. The evaluator
// they share reads a comma list, the compound assignments (`+=` … `|=`),
// `++x` and `--x`, and reports a division by 0. Before
// (ticket-lifo-arithmetic-commands), `((…))` ran its words as a command
// ("010: command not found"), `let` was not found, `for ((` was a syntax
// error, `++x` was x, `x += 1` and a comma were misread, and a division by 0
// was 0. Host bash is the oracle (stdout, status, stderr without bash's
// line prefix).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const LINES = [
  '((010 == 8)) && echo eight; ((0x10 == 16)) && echo sixteen',
  '(( 0 )); echo "zero $?"; (( 1 )); echo "one $?"; (( )); echo "empty $?"',
  'x=3; (( $x > 2 )) && echo big; (( "x" > 2 )) && echo quoted; ((y = $(echo 4) * 2)); echo $y',
  'x=5; ((x += 3, x *= 2)); echo $x; ((y = 1, z = y + 1)); echo $y $z; echo $((1, 2, 3))',
  'x=3; echo $((++x)) $x $((--x)) $x $((x++)) $x; i=0; ((i++)); ((i++)); ((i--)); echo $i',
  'x=12; ((x <<= 2)); echo $x; ((x >>= 1, x &= 7, x |= 8, x ^= 1, x %= 5, x -= 1)); echo $x',
  'x=1; echo $(( x == 1 )) $(( x != 1 )) $(( x <= 1 )) $(( x >= 2 )) $(( x ** 3 + 2 ))',
  'echo $((1/0))\necho $((1/0 + 2))\necho $(( 7 % 0 ))\nx=1; echo $((x /= 0))\necho $((0 && 1/0)) end',
  'let "v = 0x10" "w = 8#17"; echo $v $w; let 0; echo "st=$?"; let 1+1; echo "st=$?"',
  'let; echo "st=$?"; let 08; echo "st=$?"; let "x=1" "y=x+1"; echo "st=$? $x $y"',
  '((019)); echo "st=$?"\necho next',
  'for ((i = 0; i < 3; i++)); do echo $i; done',
  'for ((i = 0; i < 2; i++)) do echo $i; done; for ((;;)); do echo once; break; done',
  'for (( ; j < 2 ; )) { echo j$j; j=$((j+1)); }',
  'for ((i = 0; i < 5; i++)); do ((i == 1)) && continue; ((i == 3)) && break; echo $i; done; echo "after $i"',
  'for ((i=08; i<2; i++)); do echo $i; done; echo "st=$?"',
  'for ((i = 0; i < 2; i++)); do for ((k = 0; k < 3; k++)); do ((k == 1)) && continue 2; echo $i$k; done; done',
  '((echo a) ); echo "st=$?"',
  'n=0; while ((n < 3)); do ((n++)); done; echo $n; until ((n == 0)); do ((n--)); done; echo $n',
  'set -e; i=0; ((i++)); echo "not reached"',
  '((x = 7)) >/dev/null 2>&1; echo $x; f() { ((x *= 2)); }; f; echo $x',
];

/** bash's diagnostic prefix: `bash: line 1: `, `bash: -c: line 1: `, and in a function 5.2's `environment: line 1: `. */
const plainStderr = (text) => text.replace(/^(?:bash|environment): (?:-c: )?(?:line \d+: )?/gm, '');

const want = [];
for (const line of LINES) {
  const dir = mkdtempSync(join(tmpdir(), 'shell-arithmetic-commands-'));
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
console.log(`shell-arithmetic-commands-bash: ${LINES.length - failed.length} of ${LINES.length} lines as bash's`);
assert.deepEqual(failed, [], `as bash:\n${failed.join('\n')}`);
